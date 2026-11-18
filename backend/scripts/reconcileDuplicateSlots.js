// One-off, MANUAL reconciliation of legacy appointment / slot data.
//
//   node scripts/reconcileDuplicateSlots.js                         -> dry run (read-only, prints the plan)
//   node scripts/reconcileDuplicateSlots.js --apply                 -> applies the plan
//   add --lock-legacy to also bring active legacy appointments under the unique index
//
// Phases (each step is a conditional, idempotent update, so the script can be
// interrupted at any point and simply re-run; correct records are never modified):
//   1. Duplicate groups (same doctor/date/CANONICAL time, i.e. "10:00 am" == "10:00 AM",
//      more than one active appointment):
//        - at most one paid/completed record  -> keep it (else the earliest booking) and
//          mark the other UNPAID, NOT completed records cancelled (tagged duplicateOf).
//        - more than one paid/completed record -> UNRESOLVED: reported, nothing cancelled.
//   0. (runs after 1) Respell slot times to the canonical "hh:mm AM" form in appointments
//      and slots_booked. Redundant records are already cancelled (slotLocked false), so
//      this cannot collide on the unique index; records of UNRESOLVED groups are deferred.
//   2. (--lock-legacy) set slotLocked: true on active appointments that are the only
//      active holder of their slot.
//   3. Repair: ensure EVERY active appointment's slot is in the doctor's slots_booked,
//      whether or not it has slotLocked (covers a crash between phase 2 and 3).
//   4. Verify and report: unresolved groups, missing slots, failures.
// The script never removes anything from slots_booked and never deletes records.
// Exit code: 0 = clean, 1 = some operations failed, 2 = unresolved items need manual action.
// Take a backup (mongodump) before running with --apply.

import 'dotenv/config'
import mongoose from 'mongoose'
import { canonicalSlotTime, slotTimeVariants } from '../utils/slotReservation.js'

const APPLY = process.argv.includes('--apply')
const LOCK_LEGACY = process.argv.includes('--lock-legacy')
const ACTIVE = { cancelled: { $ne: true } }
const isObjectId = (id) => /^[a-f\d]{24}$/i.test(String(id))
const canonicalTime = (t) => canonicalSlotTime(t) || t
const slotKey = (a) => `${a.docId}|${a.slotDate}|${canonicalTime(a.slotTime)}`
const slotPath = (slotDate) => `slots_booked.${slotDate}`
const safeSlotDate = (slotDate) => typeof slotDate === 'string' && slotDate && !slotDate.includes('.') && !slotDate.startsWith('$')

const run = async () => {
    // --apply never relies on a default database: the target must be named explicitly
    if (APPLY && !process.env.MONGODB_DB_NAME) {
        console.error('Refusing --apply: set MONGODB_DB_NAME explicitly (e.g. MONGODB_DB_NAME=prescripto_test).')
        process.exitCode = 1
        return
    }
    // production is refused unless a separate, deliberate approval flag is given
    if (APPLY && process.env.MONGODB_DB_NAME === 'prescripto' && !process.argv.includes('--production-approved')) {
        console.error('Refusing --apply on the production database "prescripto" (requires an approved run with --production-approved).')
        process.exitCode = 1
        return
    }
    const dbName = process.env.MONGODB_DB_NAME || 'prescripto'
    await mongoose.connect(process.env.MONGODB_URI, { dbName })
    const db = mongoose.connection.db
    const appointments = db.collection('appointments')
    const doctors = db.collection('doctors')
    const now = new Date()
    const failures = []
    const unresolved = []
    const plannedCancel = new Set()

    const fail = (what, error) => {
        failures.push(`${what}: ${error?.code === 11000 ? 'duplicate key (another active record holds this slot)' : error?.message || error}`)
        console.log(`  FAILED ${what}`)
    }

    console.log(APPLY ? '*** APPLY MODE: changes will be written ***' : 'DRY RUN: no changes will be written')
    console.log(`Database: ${dbName}`)

    // ---------------- Phase 1: duplicate groups (by canonical slot) ----------------
    // Runs BEFORE respelling: grouping already uses the canonical slot, and a redundant
    // record is cancelled (slotLocked false) first, so respelling it later can never
    // collide with the kept record on the unique_active_slot index.
    const unresolvedIds = new Set()
    const groupsByKey = new Map()
    for (const a of await appointments.find(ACTIVE).sort({ date: 1, _id: 1 }).toArray()) {
        if (!groupsByKey.has(slotKey(a))) groupsByKey.set(slotKey(a), [])
        groupsByKey.get(slotKey(a)).push(a)
    }
    const groups = [...groupsByKey.values()].filter(rows => rows.length > 1)
    console.log(`\n[1] Active duplicate groups: ${groups.length}`)

    for (const rows of groups) {
        const key = { docId: rows[0].docId, slotDate: rows[0].slotDate, slotTime: canonicalTime(rows[0].slotTime) }
        const valuable = rows.filter(r => r.payment || r.isCompleted)
        console.log(`\n  ${key.docId} ${key.slotDate} ${key.slotTime}`)

        if (valuable.length > 1) {
            unresolved.push(`${key.docId} ${key.slotDate} ${key.slotTime}: ${valuable.length} paid/completed records (${valuable.map(r => r._id).join(', ')})`)
            rows.forEach(r => unresolvedIds.add(String(r._id)))
            rows.forEach(r => console.log(`    UNRESOLVED ${r._id}  user=${r.userId}  paid=${Boolean(r.payment)}  completed=${Boolean(r.isCompleted)}`))
            console.log('    !! More than one paid/completed record: nothing cancelled. Decide manually (refund / reschedule).')
            continue
        }

        const keep = valuable[0] || rows[0]
        const redundant = rows.filter(r => !r._id.equals(keep._id))
        console.log(`    KEEP   ${keep._id}  user=${keep.userId}  booked=${new Date(keep.date).toISOString()}  paid=${Boolean(keep.payment)}  completed=${Boolean(keep.isCompleted)}`)
        for (const r of redundant) {
            plannedCancel.add(String(r._id))
            console.log(`    CANCEL ${r._id}  user=${r.userId}  booked=${new Date(r.date).toISOString()}  paid=false  completed=false`)
            if (!APPLY) continue
            try {
                // conditional: only a still-active, unpaid, not completed record; never touches the slot
                const res = await appointments.updateOne(
                    { _id: r._id, ...ACTIVE, payment: { $ne: true }, isCompleted: { $ne: true } },
                    { $set: { cancelled: true, status: 'cancelled', slotLocked: false, duplicateOf: keep._id, reconciledAt: now } }
                )
                if (res.modifiedCount !== 1) failures.push(`cancel ${r._id}: record changed since it was read (not modified)`)
            } catch (error) {
                fail(`cancel ${r._id}`, error)
            }
        }
    }

    // ---------------- Phase 0 (runs after phase 1): canonical slot times ----------------
    // Records in UNRESOLVED groups keep their legacy spelling until a human resolves the
    // group (the live code already treats every spelling as the same slot).
    const nonCanonical = (await appointments.find({}, { projection: { slotTime: 1, docId: 1, slotDate: 1, slotLocked: 1, cancelled: 1 } }).toArray())
        .filter(a => canonicalSlotTime(a.slotTime) && canonicalSlotTime(a.slotTime) !== a.slotTime)
    console.log(`\n[0] Appointments with non-canonical slot time: ${nonCanonical.length}`)
    let deferred = 0
    for (const a of nonCanonical) {
        const id = String(a._id)
        const target = canonicalSlotTime(a.slotTime)
        if (unresolvedIds.has(id)) {
            deferred++
            console.log(`    DEFER     ${a._id}  ${JSON.stringify(a.slotTime)} (unresolved duplicate group; respelled after it is resolved)`)
            continue
        }
        // would still hold the unique index after this run?
        const staysLocked = a.slotLocked === true && a.cancelled !== true && !plannedCancel.has(id)
        if (staysLocked) {
            const conflict = await appointments.findOne({ _id: { $ne: a._id }, docId: a.docId, slotDate: a.slotDate, slotTime: target, slotLocked: true })
            if (conflict) {
                failures.push(`normalise ${a._id}: another slot-holding record ${conflict._id} already uses "${target}" (resolve manually)`)
                console.log(`    CONFLICT  ${a._id}  ${JSON.stringify(a.slotTime)} vs ${conflict._id}`)
                continue
            }
        }
        console.log(`    NORMALISE ${a._id}  ${JSON.stringify(a.slotTime)} -> "${target}"`)
        if (!APPLY) continue
        try {
            await appointments.updateOne({ _id: a._id, slotTime: a.slotTime }, { $set: { slotTime: target } })
        } catch (error) {
            fail(`normalise ${a._id}`, error)
        }
    }
    if (deferred) console.log(`    deferred (unresolved duplicate group): ${deferred}`)
    let slotArraysNormalised = 0
    for (const doctor of await doctors.find({}, { projection: { slots_booked: 1 } }).toArray()) {
        for (const [date, times] of Object.entries(doctor.slots_booked || {})) {
            if (!Array.isArray(times) || !safeSlotDate(date)) continue
            const normalised = [...new Set(times.map(canonicalTime))]
            if (JSON.stringify(normalised) === JSON.stringify(times)) continue
            slotArraysNormalised++
            console.log(`    NORMALISE slots_booked ${doctor._id} ${date}: ${JSON.stringify(times)} -> ${JSON.stringify(normalised)}`)
            if (!APPLY) continue
            try {
                // only if unchanged since read; entries are respelled/deduplicated, never dropped
                const res = await doctors.updateOne({ _id: doctor._id, [slotPath(date)]: times }, { $set: { [slotPath(date)]: normalised } })
                if (res.matchedCount === 0) failures.push(`normalise slots_booked ${doctor._id} ${date}: changed since it was read (not modified); re-run`)
            } catch (error) {
                fail(`normalise slots_booked ${doctor._id} ${date}`, error)
            }
        }
    }
    console.log(`    slots_booked arrays to normalise: ${slotArraysNormalised}`)

    // Active holders after phase 1 (in dry run: as planned)
    const active = (await appointments.find(ACTIVE).toArray()).filter(a => APPLY || !plannedCancel.has(String(a._id)))
    const holdersPerSlot = new Map()
    for (const a of active) holdersPerSlot.set(slotKey(a), (holdersPerSlot.get(slotKey(a)) || 0) + 1)

    // ---------------- Phase 2: lock legacy (optional) ----------------
    if (LOCK_LEGACY) {
        const toLock = active.filter(a => a.slotLocked !== true)
        console.log(`\n[2] Active appointments without slotLocked: ${toLock.length}`)
        for (const a of toLock) {
            if (holdersPerSlot.get(slotKey(a)) > 1) {
                console.log(`    SKIP   ${a._id} ${a.slotDate} ${a.slotTime} (slot still has multiple active holders)`)
                continue
            }
            console.log(`    LOCK   ${a._id} ${a.docId} ${a.slotDate} ${a.slotTime}`)
            if (!APPLY) continue
            try {
                await appointments.updateOne({ _id: a._id, ...ACTIVE, slotLocked: { $ne: true } }, { $set: { slotLocked: true } })
            } catch (error) {
                fail(`lock ${a._id}`, error)
            }
        }
    }

    // ---------------- Phase 3: repair slots_booked for every active appointment ----------------
    console.log(`\n[3] Checking slots_booked for ${active.length} active appointments (with or without slotLocked)`)
    let repaired = 0
    for (const a of active) {
        if (!isObjectId(a.docId) || !safeSlotDate(a.slotDate)) {
            fail(`repair ${a._id} (invalid docId/slotDate)`, 'skipped')
            continue
        }
        const docObjectId = new mongoose.Types.ObjectId(String(a.docId))
        const present = await doctors.countDocuments({ _id: docObjectId, [slotPath(a.slotDate)]: { $in: slotTimeVariants(a.slotTime) } })
        if (present) continue
        console.log(`    ADD    ${a.docId} ${a.slotDate} ${canonicalTime(a.slotTime)}  (held by ${a._id}, slotLocked=${Boolean(a.slotLocked)})`)
        if (!APPLY) { repaired++; continue }
        try {
            // $nin guard over every spelling: only adds when missing; never removes anything
            const res = await doctors.updateOne(
                { _id: docObjectId, [slotPath(a.slotDate)]: { $nin: slotTimeVariants(a.slotTime) } },
                { $push: { [slotPath(a.slotDate)]: canonicalTime(a.slotTime) } }
            )
            if (res.matchedCount === 0 && !(await doctors.countDocuments({ _id: docObjectId }))) {
                fail(`repair ${a._id} (doctor ${a.docId} not found)`, 'skipped')
            } else if (res.modifiedCount) {
                repaired++
            }
        } catch (error) {
            fail(`repair ${a._id}`, error)
        }
    }
    console.log(`    ${APPLY ? 'repaired' : 'would repair'}: ${repaired}`)

    // ---------------- Phase 4: verify ----------------
    if (APPLY) {
        const activeNow = await appointments.find(ACTIVE).toArray()
        const perSlot = new Map()
        for (const a of activeNow) perSlot.set(slotKey(a), (perSlot.get(slotKey(a)) || 0) + 1)
        const remaining = [...perSlot.values()].filter(n => n > 1)
        let missing = 0
        for (const a of activeNow) {
            if (!isObjectId(a.docId) || !safeSlotDate(a.slotDate)) continue
            if (!(await doctors.countDocuments({ _id: new mongoose.Types.ObjectId(String(a.docId)), [slotPath(a.slotDate)]: { $in: slotTimeVariants(a.slotTime) } }))) missing++
        }
        console.log(`\n[4] Verify: duplicate groups remaining ${remaining.length}, active appointments missing from slots_booked ${missing}`)
        if (missing) failures.push(`${missing} active appointment(s) still missing from slots_booked`)
    }

    console.log('\n================ SUMMARY ================')
    console.log(`Unresolved duplicate groups (manual action required): ${unresolved.length}`)
    unresolved.forEach(u => console.log(`  - ${u}`))
    console.log(`Failures: ${failures.length}`)
    failures.forEach(f => console.log(`  - ${f}`))
    if (failures.length) console.log('Re-run the script after fixing the cause; completed steps are not repeated.')

    await mongoose.disconnect()
    process.exitCode = failures.length ? 1 : unresolved.length ? 2 : 0
}

run().catch(async (error) => {
    console.error('Reconciliation aborted:', error)
    console.error('Nothing already applied is lost; re-run the script to continue.')
    await mongoose.disconnect()
    process.exit(1)
})
