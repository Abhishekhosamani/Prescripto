import crypto from 'crypto'
import razorpay from 'razorpay'
import doctorModel from '../models/doctorModel.js'
import appointmentModel from '../models/appointmentModel.js'
import refundModel from '../models/refundModel.js'
import slotOrphanModel from '../models/slotOrphanModel.js'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Online-payment hold duration. Configurable via RESERVATION_EXPIRY_MINUTES, default 10.
export const getReservationMinutes = () => {
    const minutes = Number(process.env.RESERVATION_EXPIRY_MINUTES)
    return Number.isFinite(minutes) && minutes > 0 ? minutes : 10
}

// A refund attempt makes at most 2 Razorpay calls (list refunds + create refund),
// so the per-request timeout is capped at a quarter of the refund lease.
export const REFUND_LEASE_MS = 5 * 60 * 1000
export const getRazorpayTimeoutMs = () => {
    const configured = Number(process.env.RAZORPAY_TIMEOUT_MS)
    const ms = Number.isFinite(configured) && configured > 0 ? configured : 20000
    return Math.min(ms, Math.floor(REFUND_LEASE_MS / 4))
}

// The razorpay SDK (v2.9.x) has no timeout option; it uses an axios instance
// exposed as `client.api.rq`, so the timeout is set on that instance.
export const createRazorpayClient = () => {
    const client = new razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET
    })
    if (client.api?.rq?.defaults) client.api.rq.defaults.timeout = getRazorpayTimeoutMs()
    return client
}

let razorpayFactory = createRazorpayClient

export const getRazorpay = () => razorpayFactory()

// Test seam only: lets the test suite substitute a fake Razorpay client.
export const __setRazorpayFactory = (factory) => { razorpayFactory = factory }

// Razorpay API errors are normalised by the SDK to { statusCode, error }. A timeout
// or network failure has no response, so the SDK throws a TypeError instead: the
// request may or may not have been executed by Razorpay.
export const isUncertainError = (error) => !(error && (error.statusCode || error.error?.code))

// ---------------------------------------------------------------------------
// Input safety
// ---------------------------------------------------------------------------

// slotDate is used as a key inside doctor.slots_booked, so it must not contain
// path separators or operator prefixes. Frontend format is e.g. "8_4_2026".
export const isValidSlotInput = (slotDate, slotTime) =>
    typeof slotDate === 'string' && typeof slotTime === 'string' &&
    slotDate.length > 0 && slotDate.length <= 20 && slotTime.length > 0 && slotTime.length <= 20 &&
    !slotDate.includes('.') && !slotDate.startsWith('$')

// ---------------------------------------------------------------------------
// Canonical slot keys
// ---------------------------------------------------------------------------
// Slot times used to be produced by the browser's toLocaleTimeString(), so one
// slot could be stored as "10:00 AM", "10:00 am", "10:00 AM" or "10:00"
// depending on the browser/locale. Exact-string matching then treated them as
// different slots (the reproduced double booking). Every write now uses the
// canonical form "hh:mm AM", and every read/guard matches all legacy spellings.

export const canonicalSlotTime = (value) => {
    if (typeof value !== 'string') return null
    const m = value.replace(/[  ]/g, ' ').trim().toLowerCase()
        .match(/^(\d{1,2}):(\d{2})\s*(?:([ap])\.?\s*m\.?)?$/)
    if (!m) return null
    let hour = Number(m[1])
    const minute = Number(m[2])
    if (minute > 59) return null
    if (m[3]) {
        if (hour < 1 || hour > 12) return null
        if (m[3] === 'a' && hour === 12) hour = 0
        if (m[3] === 'p' && hour !== 12) hour += 12
    } else if (hour > 23) {
        return null
    }
    const hour12 = hour % 12 === 0 ? 12 : hour % 12
    return `${String(hour12).padStart(2, '0')}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`
}

export const canonicalSlotDate = (value) => {
    if (typeof value !== 'string') return null
    const m = value.trim().match(/^(\d{1,2})_(\d{1,2})_(\d{4})$/)
    if (!m) return null
    const [day, month, year] = [Number(m[1]), Number(m[2]), Number(m[3])]
    const date = new Date(Date.UTC(year, month - 1, day))
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
    return `${day}_${month}_${year}`
}

// Every spelling of a slot time that older clients may have stored.
export const slotTimeVariants = (slotTime) => {
    const canonical = canonicalSlotTime(slotTime)
    if (!canonical) return [slotTime]
    const [hm, period] = canonical.split(' ')
    const [hh, mm] = hm.split(':')
    const hour12 = Number(hh)
    const hour24 = (hour12 % 12) + (period === 'PM' ? 12 : 0)
    const suffixes = period === 'AM' ? ['AM', 'am', 'Am', 'aM', 'a.m.', 'A.M.'] : ['PM', 'pm', 'Pm', 'pM', 'p.m.', 'P.M.']
    const variants = new Set([canonical, slotTime, `${String(hour24).padStart(2, '0')}:${mm}`, `${hour24}:${mm}`])
    for (const h of [hh, String(hour12)]) {
        for (const s of suffixes) {
            for (const sep of [' ', '', ' ', ' ']) variants.add(`${h}:${mm}${sep}${s}`)
        }
    }
    return [...variants]
}

const sameSlotTime = (slotTime) => ({ $in: slotTimeVariants(slotTime) })

// Fields applied when a pending online reservation expires.
const expiredFields = () => ({
    status: 'expired',
    paymentStatus: 'unpaid',
    cancelled: true,        // keeps every existing panel/filter treating it as inactive
    slotLocked: false
})

// ---------------------------------------------------------------------------
// Slot claim / release (atomic)
// ---------------------------------------------------------------------------

// An appointment "holds" its slot while active (confirmed, cash, legacy without
// slotLocked, or a pending online reservation), or while a late-payment
// settlement has claimed the slot.
const holderFilter = (docId, slotDate, slotTime, excludeAppointmentId) => ({
    docId: String(docId), slotDate, slotTime: sameSlotTime(slotTime),
    ...(excludeAppointmentId ? { _id: { $ne: excludeAppointmentId } } : {}),
    $or: [{ cancelled: { $ne: true } }, { settlingSlotClaimed: true }]
})

/**
 * Atomically claims doctor slot. Succeeds only if the slot is not already in
 * slots_booked, or if it is held by an online reservation whose expiresAt has
 * passed (that reservation is atomically expired and its slot taken over).
 * Never uses find-then-save.
 */
export const claimSlot = async (docId, slotDate, slotTime) => {
    const path = `slots_booked.${slotDate}`
    const variants = slotTimeVariants(slotTime)

    for (let attempt = 0; attempt < 3; attempt++) {
        // $nin over every spelling: a legacy "10:00 am" entry blocks "10:00 AM"
        const claimed = await doctorModel.findOneAndUpdate(
            { _id: docId, [path]: { $nin: variants } },
            { $push: { [path]: slotTime } },
            { returnDocument: 'after', projection: { _id: 1 } }
        )
        if (claimed) return { ok: true }

        // Slot is marked booked. If it is held by an expired online reservation,
        // reclaim it. Only one request can win this conditional update.
        const stale = await appointmentModel.findOneAndUpdate(
            { docId: String(docId), slotDate, slotTime: { $in: variants }, status: 'pending', slotLocked: true, expiresAt: { $lte: new Date() } },
            { $set: expiredFields() },
            { returnDocument: 'after' }
        )
        if (stale) return { ok: true, reclaimedFrom: stale._id }

        // Nothing reclaimable. Retry only if the slot was freed in the meantime
        // (e.g. cron released it between our two queries).
        const stillBooked = await doctorModel.exists({ _id: docId, [path]: { $in: variants } })
        if (stillBooked) return { ok: false }
    }
    return { ok: false }
}

/**
 * Removes a slot from slots_booked ONLY if no other appointment still holds it
 * (covers legacy appointments without slotLocked and pending reservations).
 * Callers first make their own appointment non-holding (atomically), then call
 * this; whichever of two concurrent releasers runs last sees the other's change,
 * so a still-held slot is never released and a free one is never left blocked.
 * A concurrent booking cannot push the slot while the entry exists ($ne guard).
 * Returns true if the slot was removed.
 */
export const releaseSlot = async (docId, slotDate, slotTime, { excludeAppointmentId } = {}) => {
    if (!isValidSlotInput(slotDate, slotTime)) return false
    if (await appointmentModel.exists(holderFilter(docId, slotDate, slotTime, excludeAppointmentId))) {
        console.log(`Slot ${docId} ${slotDate} ${slotTime} kept: still held by another appointment`)
        return false
    }
    await doctorModel.updateOne(
        { _id: docId },
        { $pull: { [`slots_booked.${slotDate}`]: { $in: slotTimeVariants(slotTime) } } }
    )
    return true
}

/**
 * Cancels an appointment and releases its slot. The slot is released only by
 * the request that actually flips cancelled false -> true, so a repeated or
 * late cancel can never free a slot that another user now holds.
 * Returns the appointment as it was before cancelling, or null if it was
 * already cancelled / not found.
 */
export const cancelAndReleaseSlot = async (appointmentId) => {
    const before = await appointmentModel.findOneAndUpdate(
        { _id: appointmentId, cancelled: { $ne: true } },
        { $set: { cancelled: true, slotLocked: false, status: 'cancelled' } },
        { returnDocument: 'before' }
    )
    if (!before) return null

    if (before.paymentStatus === 'pending') {
        await appointmentModel.updateOne({ _id: before._id, paymentStatus: 'pending' }, { $set: { paymentStatus: 'unpaid' } })
    }
    await releaseSlot(before.docId, before.slotDate, before.slotTime, { excludeAppointmentId: before._id })
    return before
}

/**
 * Ends a still-pending online reservation (payment failed / order creation
 * failed). Only the request that wins the conditional update releases the slot.
 */
export const failPendingReservation = async (appointmentId) => {
    const before = await appointmentModel.findOneAndUpdate(
        { _id: appointmentId, status: 'pending' },
        { $set: { status: 'failed', paymentStatus: 'failed', cancelled: true, slotLocked: false } },
        { returnDocument: 'before' }
    )
    if (before && before.slotLocked) {
        await releaseSlot(before.docId, before.slotDate, before.slotTime, { excludeAppointmentId: before._id })
    }
    return before
}

/**
 * Returns slots held by pending reservations whose expiresAt has passed but
 * which cron has not processed yet. Used to show those slots as available.
 */
export const getExpiredHeldSlots = () =>
    appointmentModel.find({ status: 'pending', slotLocked: true, expiresAt: { $lte: new Date() } })
        .select('docId slotDate slotTime').lean()

// ---------------------------------------------------------------------------
// Razorpay helpers
// ---------------------------------------------------------------------------

// Same order options as the existing paymentRazorpay integration.
export const createRazorpayOrder = (appointment) => getRazorpay().orders.create({
    amount: appointment.amount * 100,
    currency: process.env.CURRENCY,
    receipt: String(appointment._id),
})

const safeEqual = (a, b) => {
    const bufA = Buffer.from(String(a))
    const bufB = Buffer.from(String(b))
    return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB)
}

export const verifyPaymentSignature = (orderId, paymentId, signature) => {
    if (!orderId || !paymentId || !signature || !process.env.RAZORPAY_KEY_SECRET) return false
    const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
        .update(`${orderId}|${paymentId}`).digest('hex')
    return safeEqual(expected, signature)
}

export const verifyWebhookSignature = (rawBody, signature, secret) => {
    if (!rawBody || !signature || !secret) return false
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
    return safeEqual(expected, signature)
}

// Razorpay payment states (SDK types): created | authorized | captured | refunded | failed.
// A refunded payment was captured first.
const CAPTURED_STATES = ['captured', 'refunded']

const pickPayment = (payments, paymentId) => {
    if (paymentId) return payments.find(p => p.id === paymentId)
    return payments.find(p => p.status === 'captured')
        || payments.find(p => p.status === 'refunded')
        || payments.find(p => p.status === 'authorized')
}

// Captures an authorized payment. Any error is an uncertain outcome (it may
// have been captured already), so the payment is always re-read from Razorpay.
const captureAuthorizedPayment = async (rz, payment) => {
    try {
        const captured = await rz.payments.capture(payment.id, payment.amount, payment.currency)
        if (captured?.status === 'captured') return captured
    } catch (error) {
        console.error(`Capture of payment ${payment.id} failed or timed out; re-reading its state.`, errorText(error))
    }
    return rz.payments.fetch(payment.id)
}

const REFUND_STATES = ['refund_pending', 'refunded', 'refund_failed']
const SETTLEMENT_LEASE_MS = 2 * 60 * 1000   // a late settlement idle this long is treated as crashed and resumed
export const MAX_REFUND_ATTEMPTS = 10
const REFUND_RETRY_MINUTES = [1, 2, 5, 15, 30, 60]          // after a failed / uncertain attempt
const REFUND_PENDING_CHECK_MINUTES = [5, 15, 60, 180, 360]  // while Razorpay reports the refund pending
const ORDER_CHECK_MINUTES = [2, 10, 30, 120, 360, 720]      // webhook-independent order re-checks
const scheduleMinutes = (schedule, n) => schedule[Math.min(Math.max(n, 0), schedule.length - 1)]
const minutesFrom = (now, minutes) => new Date(now.getTime() + minutes * 60 * 1000)

const PAID_RESULT = { success: true, message: 'Payment Successful' }
const LATE_REFUND_MESSAGE = 'Your reservation is no longer active and the slot is unavailable. Your payment has been refunded.'

const lateResult = (appointment) => (
    appointment?.paymentStatus === 'refunded'
        ? { success: false, message: LATE_REFUND_MESSAGE }
        : { success: false, message: 'Your reservation is no longer active and the slot is unavailable. Your refund is being processed.' }
)

const errorText = (error) => String(error?.error?.description || error?.message || error).slice(0, 500)

const lockFree = (now) => ({ $or: [{ lockUntil: { $exists: false } }, { lockUntil: null }, { lockUntil: { $lte: now } }] })
const refundDue = (now) => ({ $or: [{ nextAttemptAt: { $exists: false } }, { nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] })

// ---------------------------------------------------------------------------
// Refund engine (durable intent + lease + Razorpay as source of truth)
// ---------------------------------------------------------------------------

/**
 * Records a durable refund intent for a payment. Idempotent: the refunds
 * collection is unique on paymentId, so repeated calls never create a second intent.
 */
export const ensureRefundIntent = async ({ paymentId, appointmentId, amount, reason }) => {
    if (!paymentId || !amount) throw new Error('Refund intent requires payment id and amount')
    try {
        await refundModel.updateOne(
            { paymentId },
            { $setOnInsert: { paymentId, appointmentId: String(appointmentId), amount, reason, status: 'pending', attempts: 0, checks: 0 } },
            { upsert: true }
        )
    } catch (error) {
        if (error?.code !== 11000) throw error // concurrent upsert of the same intent: already recorded
    }
}

/**
 * Executes one refund intent against Razorpay. Safe to call any number of times
 * from any number of instances:
 *  - a lease (lockUntil) lets only one worker talk to Razorpay at a time; the
 *    lease is longer than both Razorpay calls of an attempt including timeouts;
 *  - the payment's refunds are always read from Razorpay first; a new refund is
 *    created only for the amount not covered by pending/processed refunds, so a
 *    refund created before a crash, a lost response or a timeout is never
 *    requested again;
 *  - 'processed' only when Razorpay reports every covering refund as processed;
 *    Razorpay 'pending' keeps it pending, re-checked on a backoff schedule; a
 *    Razorpay 'failed' refund no longer covers the amount, so a later run retries.
 * By default only records whose nextAttemptAt is due are processed;
 * ignoreSchedule is used for immediate processing (new intents, refund webhooks).
 */
export const processRefundRecord = async (paymentId, { ignoreSchedule = false } = {}) => {
    const now = new Date()
    const lease = await refundModel.findOneAndUpdate(
        {
            paymentId,
            status: { $in: ['pending', 'failed'] },
            $and: [lockFree(now), ...(ignoreSchedule ? [] : [refundDue(now)])]
        },
        { $set: { lockUntil: new Date(now.getTime() + REFUND_LEASE_MS) } },
        { returnDocument: 'after' }
    )
    if (!lease) return null // processed / manual_required / not due / another worker holds the lease

    try {
        const rz = getRazorpay()
        const existing = (await rz.payments.fetchMultipleRefund(paymentId, { count: 100 }))?.items || []
        const covering = existing.filter(r => r.status !== 'failed')
        const covered = covering.reduce((sum, r) => sum + Number(r.amount || 0), 0)

        if (covered < lease.amount) {
            const created = await rz.payments.refund(paymentId, {
                amount: lease.amount - covered,
                notes: { appointmentId: lease.appointmentId, reason: lease.reason }
            })
            covering.push(created)
        }

        const latest = covering[covering.length - 1]
        const processed = covering.length > 0 && covering.every(r => r.status === 'processed')
        const checks = (lease.checks || 0) + 1
        await refundModel.updateOne(
            { paymentId },
            processed
                ? { $set: { status: 'processed', refundId: latest?.id, refundStatus: latest?.status, checks }, $unset: { lockUntil: 1, lastError: 1, nextAttemptAt: 1 } }
                : {
                    $set: { status: 'pending', refundId: latest?.id, refundStatus: latest?.status || 'pending', checks,
                        nextAttemptAt: minutesFrom(new Date(), scheduleMinutes(REFUND_PENDING_CHECK_MINUTES, checks - 1)) },
                    $unset: { lockUntil: 1, lastError: 1 }
                }
        )
        return processed ? 'processed' : 'pending'
    } catch (error) {
        const attempts = (lease.attempts || 0) + 1
        const status = attempts >= MAX_REFUND_ATTEMPTS ? 'manual_required' : 'failed'
        const uncertain = isUncertainError(error)
        const lastError = `${uncertain ? 'Uncertain outcome (timeout/network); Razorpay refunds are re-read before any retry. ' : ''}${errorText(error)}`
        console.error(`Refund attempt ${attempts} failed for payment ${paymentId} (appointment ${lease.appointmentId}).${status === 'manual_required' ? ' MANUAL REFUND REQUIRED.' : ' Will retry.'}`, lastError)
        await refundModel.updateOne(
            { paymentId },
            {
                $set: { status, attempts, lastError, nextAttemptAt: minutesFrom(new Date(), scheduleMinutes(REFUND_RETRY_MINUTES, attempts - 1)) },
                $unset: { lockUntil: 1 }
            }
        )
        return status
    }
}

// Copies a late-payment refund record's state onto its (unpaid) appointment.
const mirrorRefundToAppointment = async (appointmentId, paymentId) => {
    const record = await refundModel.findOne({ paymentId }).lean()
    if (!record) return
    const paymentStatus = record.status === 'processed' ? 'refunded' : record.status === 'pending' ? 'refund_pending' : 'refund_failed'
    await appointmentModel.updateOne(
        { _id: appointmentId, payment: false, refundPaymentId: paymentId },
        { $set: {
            paymentStatus, refundId: record.refundId,
            refundStatus: record.status === 'manual_required' ? 'manual_required' : (record.refundStatus || record.status),
            ...(record.lastError ? { refundLastError: record.lastError } : {})
        } }
    )
}

/**
 * Executes the refund intent recorded on a late-paid appointment
 * (paymentStatus refund_pending / refund_failed). Creates the durable refund
 * record from the appointment's intent if a crash happened before it was written,
 * processes it, and mirrors the result back onto the appointment.
 * A missing payment id / amount is resolved from the Razorpay order when
 * possible; otherwise the appointment is flagged once for manual reconciliation.
 */
export const processRefund = async (appointmentId, options = {}) => {
    const appointment = await appointmentModel.findOne({
        _id: appointmentId, payment: false, paymentStatus: { $in: ['refund_pending', 'refund_failed'] }
    }).lean()
    if (!appointment) return null

    let paymentId = appointment.refundPaymentId
    let amount = appointment.refundAmount
    if ((!paymentId || !amount) && appointment.razorpayOrderId) {
        try {
            const payments = (await getRazorpay().orders.fetchPayments(appointment.razorpayOrderId))?.items || []
            const payment = paymentId ? payments.find(p => p.id === paymentId) : pickPayment(payments.filter(p => CAPTURED_STATES.includes(p.status)))
            if (payment && CAPTURED_STATES.includes(payment.status)) {
                paymentId = payment.id
                amount = amount || Number(payment.amount)
            }
        } catch (error) {
            console.error(`Could not resolve refund payment for appointment ${appointmentId}; will retry.`, errorText(error))
            return null
        }
    }

    if (!paymentId || !amount) {
        const flagged = await appointmentModel.updateOne(
            { _id: appointmentId, refundRecordedAt: { $exists: false } },
            { $set: { paymentStatus: 'refund_failed', refundStatus: 'manual_required', refundRecordedAt: new Date(),
                refundLastError: 'No captured Razorpay payment id/amount for this refund intent. Manual reconciliation required (see backend/docs/RAZORPAY_SETUP.md).' } }
        )
        if (flagged.modifiedCount) console.error(`Refund intent on appointment ${appointmentId} has no resolvable payment id/amount. MANUAL RECONCILIATION REQUIRED.`)
        return 'manual_required'
    }

    await ensureRefundIntent({ paymentId, appointmentId, amount, reason: 'late_payment' })
    await appointmentModel.updateOne(
        { _id: appointmentId },
        { $set: { refundPaymentId: paymentId, refundAmount: amount, refundRecordedAt: new Date() } }
    )
    const result = await processRefundRecord(paymentId, options)
    await mirrorRefundToAppointment(appointmentId, paymentId)
    return result
}

/**
 * Processes the refund record for a payment and mirrors the result onto a
 * late-paid appointment. Used by cron and by Razorpay refund.* webhooks.
 */
export const syncRefund = async (paymentId, options = {}) => {
    const result = await processRefundRecord(paymentId, options)
    const record = await refundModel.findOne({ paymentId }).lean()
    // mirror only onto an appointment whose own (unpaid) refund intent is this payment
    // (late payments, cancelled duplicates); a paid appointment is never touched
    if (record) await mirrorRefundToAppointment(record.appointmentId, paymentId)
    return result
}

/**
 * Cancels a PAID appointment that lost a slot to another paid appointment (e.g. a
 * historical double booking) and refunds its exact Razorpay payment through the
 * durable refund engine. Verified against Razorpay before any write:
 *  - the payment is captured, belongs to an order whose receipt is this appointment,
 *    and is not already (being) refunded except by our own refund record;
 *  - the appointment to keep is a different, active, paid holder of the same slot.
 * Order of writes is crash-safe: the appointment is cancelled with its refund intent
 * in ONE atomic update (cron resumes the refund if we crash afterwards); then the slot
 * is released only if nobody else holds it (the kept appointment does, so it stays);
 * then the refund record is created and processed. Re-running is idempotent.
 */
export const cancelPaidDuplicateAndRefund = async ({ appointmentId, keepAppointmentId, paymentId, orderId }) => {
    if (!appointmentId || !keepAppointmentId || !paymentId || !orderId) throw new Error('appointmentId, keepAppointmentId, paymentId and orderId are required')
    if (String(appointmentId) === String(keepAppointmentId)) throw new Error('The appointment to cancel must differ from the one kept')

    const [target, keep] = await Promise.all([appointmentModel.findById(appointmentId).lean(), appointmentModel.findById(keepAppointmentId).lean()])
    if (!target || !keep) throw new Error('Appointment not found')
    const sameSlot = String(target.docId) === String(keep.docId) && target.slotDate === keep.slotDate &&
        canonicalSlotTime(target.slotTime) === canonicalSlotTime(keep.slotTime)
    if (!sameSlot) throw new Error('The two appointments are not for the same doctor/date/time')
    if (keep.cancelled || !keep.payment) throw new Error('The appointment to keep must be active and paid')

    const rz = getRazorpay()
    const [order, payment] = await Promise.all([rz.orders.fetch(orderId), rz.payments.fetch(paymentId)])
    if (String(order?.receipt) !== String(appointmentId)) throw new Error('Order receipt does not match the appointment to cancel')
    if (payment?.order_id !== orderId) throw new Error('Payment does not belong to the order')
    if (!CAPTURED_STATES.includes(payment.status)) throw new Error(`Payment is ${payment?.status}, not captured`)
    if (keep.razorpayPaymentId && keep.razorpayPaymentId === paymentId) throw new Error('Refusing to refund the kept appointment\'s payment')

    const ownRecord = await refundModel.findOne({ paymentId }).lean()
    const existingRefunds = (await rz.payments.fetchMultipleRefund(paymentId, { count: 100 }))?.items || []
    if (!ownRecord && existingRefunds.some(r => r.status !== 'failed')) {
        throw new Error('This payment already has a refund that this application did not create; reconcile manually')
    }

    const alreadyDone = target.cancelled && target.refundPaymentId === paymentId
    if (!alreadyDone) {
        if (target.cancelled) throw new Error('Appointment is already cancelled without this refund intent; reconcile manually')
        const cancelled = await appointmentModel.findOneAndUpdate(
            { _id: appointmentId, cancelled: { $ne: true }, payment: true },
            { $set: {
                cancelled: true, status: 'cancelled', slotLocked: false, payment: false, paymentStatus: 'refund_pending',
                refundPaymentId: paymentId, refundAmount: Number(payment.amount), razorpayOrderId: orderId, razorpayPaymentId: paymentId,
                duplicateOf: String(keepAppointmentId)
            } },
            { returnDocument: 'before' }
        )
        if (!cancelled) throw new Error('Appointment changed concurrently; nothing was modified, re-run to retry')
        await releaseSlot(cancelled.docId, cancelled.slotDate, cancelled.slotTime, { excludeAppointmentId: cancelled._id })
    }

    await ensureRefundIntent({ paymentId, appointmentId, amount: Number(payment.amount), reason: 'duplicate_booking' })
    await processRefund(appointmentId, { ignoreSchedule: true })
    return {
        appointment: await appointmentModel.findById(appointmentId).lean(),
        refund: await refundModel.findOne({ paymentId }).lean()
    }
}

// ---------------------------------------------------------------------------
// Payment settlement
// ---------------------------------------------------------------------------

/**
 * Decides and completes a late payment (reservation no longer pending) whose
 * settlement lock is held. Resumable: every step is persisted before it is
 * acted on, so cron can re-run it after a crash at any point.
 *  - Re-confirms only if no other active appointment holds the slot and the
 *    slot is (re)claimed atomically; the unique index is the final arbiter.
 *  - Otherwise records a refund intent, then executes it.
 * Confirm and refund-intent use the same guard (payment false and no refund
 * state), so exactly one of them can ever win.
 */
export const resolveLateSettlement = async (appointmentId) => {
    const appointment = await appointmentModel.findById(appointmentId)
    if (!appointment) return { success: false, message: 'Appointment not found' }
    if (appointment.payment && appointment.status === 'confirmed') return PAID_RESULT
    if (REFUND_STATES.includes(appointment.paymentStatus)) {
        await processRefund(appointment._id, { ignoreSchedule: true })
        return lateResult(await appointmentModel.findById(appointment._id))
    }

    const { docId, slotDate, slotTime } = appointment
    let mayConfirm = false
    let pushedNow = false

    // Only reservations that lapsed (expired / failed) may get their slot back.
    // User/doctor/admin-cancelled appointments are always refunded.
    if (appointment.status === 'expired' || appointment.status === 'failed') {
        const otherHolder = await appointmentModel.exists({
            docId, slotDate, slotTime: sameSlotTime(slotTime), _id: { $ne: appointment._id }, cancelled: { $ne: true }
        })
        if (!otherHolder) {
            const inSlots = await doctorModel.exists({ _id: docId, [`slots_booked.${slotDate}`]: sameSlotTime(slotTime) })
            if (appointment.settlingSlotClaimed && inSlots) {
                // resuming after a crash between claiming the slot and confirming
                mayConfirm = true
            } else if (!inSlots) {
                // persist intent before touching the slot so a crash is resumable
                await appointmentModel.updateOne({ _id: appointment._id }, { $set: { settlingSlotClaimed: true } })
                const claim = await claimSlot(docId, slotDate, slotTime)
                mayConfirm = pushedNow = claim.ok
            }
            // Slot present but not claimed by us: someone else is mid-booking or
            // cron is about to release it. Do not take it; refund instead.
        }
    }

    if (mayConfirm) {
        try {
            const done = await appointmentModel.findOneAndUpdate(
                { _id: appointment._id, payment: false, paymentStatus: { $nin: REFUND_STATES } },
                {
                    $set: { status: 'confirmed', paymentStatus: 'paid', payment: true, cancelled: false, slotLocked: true, paidAt: new Date() },
                    $unset: { settlingSlotClaimed: 1 }
                },
                { returnDocument: 'after' }
            )
            if (done) return PAID_RESULT
        } catch (error) {
            // Anything but a unique-index conflict: keep state as-is; cron resumes it.
            if (error?.code !== 11000) throw error
            // E11000: another live appointment holds this slot; the slot entry is theirs.
            pushedNow = false
        }
        const current = await appointmentModel.findById(appointment._id)
        if (current?.payment) return PAID_RESULT
        if (pushedNow) await releaseSlot(docId, slotDate, slotTime, { excludeAppointmentId: appointment._id })
    }

    // Record the refund intent BEFORE calling Razorpay.
    const intent = await appointmentModel.findOneAndUpdate(
        { _id: appointment._id, payment: false, paymentStatus: { $nin: REFUND_STATES } },
        {
            $set: { paymentStatus: 'refund_pending', refundPaymentId: appointment.razorpayPaymentId, refundAmount: appointment.settlingAmount },
            $unset: { settlingSlotClaimed: 1 }
        },
        { returnDocument: 'after' }
    )
    if (!intent) {
        const current = await appointmentModel.findById(appointment._id)
        if (current?.payment) return PAID_RESULT
    }

    await processRefund(appointment._id, { ignoreSchedule: true })
    return lateResult(await appointmentModel.findById(appointment._id))
}

/**
 * Single, idempotent settlement path for a Razorpay order, used by
 * verifyRazorpay, the webhook and the reconciliation jobs.
 * Payment state is always read from Razorpay on the server; frontend data is never trusted.
 * Online reservations do not assume automatic capture: an 'authorized' payment is
 * captured by the server only while its reservation still holds the slot, and is
 * never captured for a booking that can no longer be honoured.
 */
export const settlePaidOrder = async ({ orderId, paymentId, userId }) => {
    const rz = getRazorpay()
    const order = await rz.orders.fetch(orderId)
    if (!order) return { success: false, message: 'Payment failed' }

    const appointment = await appointmentModel.findById(order.receipt)
    if (!appointment) {
        return { success: false, message: 'Appointment not found' }
    }

    // Browser-initiated verification must come from the appointment's owner.
    // (Webhook / reconciliation calls pass no userId and settle server-side.)
    if (userId && String(appointment.userId) !== String(userId)) {
        return { success: false, message: 'Unauthorized action' }
    }

    const payments = (await rz.orders.fetchPayments(orderId))?.items || []
    let payment = pickPayment(payments, paymentId)
    if (!payment && paymentId) {
        const fetched = await rz.payments.fetch(paymentId)
        if (fetched?.order_id === orderId) payment = fetched
    }

    // Legacy appointments created before online-only booking (no paymentMethod /
    // 'cash'): they already hold their slot. Payment is accepted only while the
    // appointment is active; a payment for a cancelled one is refunded, never kept.
    if (appointment.paymentMethod !== 'online') {
        if (order.status !== 'paid') return { success: false, message: 'Payment failed' }
        if (appointment.cancelled) {
            if (payment && CAPTURED_STATES.includes(payment.status)) {
                await ensureRefundIntent({ paymentId: payment.id, appointmentId: appointment._id, amount: Number(payment.amount), reason: 'cancelled_appointment' })
                await processRefundRecord(payment.id, { ignoreSchedule: true })
                const record = await refundModel.findOne({ paymentId: payment.id }).lean()
                if (record?.status === 'processed') return { success: false, message: 'This appointment is cancelled. Your payment has been refunded.' }
            }
            return { success: false, message: 'This appointment is cancelled. Your payment will be refunded.' }
        }
        const update = { payment: true, paymentStatus: 'paid' }
        if (payment?.id) update.razorpayPaymentId = payment.id
        await appointmentModel.updateOne({ _id: appointment._id, cancelled: { $ne: true } }, { $set: update })
        return PAID_RESULT
    }
    if (!payment || !['authorized', ...CAPTURED_STATES].includes(payment.status)) {
        return { success: false, message: 'Payment failed' }
    }

    if (Number(payment.amount) < Math.round(appointment.amount * 100)) {
        console.error(`Amount mismatch for appointment ${appointment._id}: payment ${payment.id} amount ${payment.amount}`)
        return { success: false, message: 'Payment verification failed' }
    }

    // A payment already refunded at Razorpay (e.g. manually) never confirms a booking.
    if (payment.status === 'refunded' && !(appointment.payment && appointment.razorpayPaymentId === payment.id)) {
        if (REFUND_STATES.includes(appointment.paymentStatus)) return lateResult(appointment)
        return { success: false, message: 'This payment has been refunded.' }
    }

    // The reservation counts only if the payment was made (or is being verified)
    // before the hold expired. Otherwise the hold is closed first, atomically, and
    // the payment is treated as late (re-claim the slot if free, else refund).
    const holdExpiresAt = appointment.expiresAt ? new Date(appointment.expiresAt).getTime() : 0
    const paymentMadeAt = Number(payment.created_at) > 0 ? Number(payment.created_at) * 1000 : Date.now()
    const withinHold = Date.now() <= holdExpiresAt || paymentMadeAt <= holdExpiresAt
    if (appointment.status === 'pending' && !withinHold) {
        const lapsed = await appointmentModel.findOneAndUpdate(
            { _id: appointment._id, status: 'pending', expiresAt: { $lte: new Date() } },
            { $set: expiredFields() },
            { returnDocument: 'before' }
        )
        if (lapsed?.slotLocked) await releaseSlot(lapsed.docId, lapsed.slotDate, lapsed.slotTime, { excludeAppointmentId: lapsed._id })
        appointment.status = 'expired'
        appointment.slotLocked = false
        appointment.cancelled = true
    }

    // Authorized but not captured (manual-capture account, or capture delay).
    if (payment.status === 'authorized') {
        const holdsSlot = withinHold && appointment.status === 'pending' && appointment.slotLocked === true && appointment.cancelled === false
        if (!holdsSlot) {
            await appointmentModel.updateOne({ _id: appointment._id, payment: false }, { $set: { uncapturedPaymentId: payment.id } })
            console.warn(`Payment ${payment.id} is authorized but its reservation ${appointment._id} is no longer active: NOT capturing. Razorpay releases uncaptured payments automatically.`)
            return { success: false, message: 'Your reservation is no longer active. The payment was not captured and will be released by Razorpay.' }
        }
        payment = await captureAuthorizedPayment(rz, payment)
        if (!CAPTURED_STATES.includes(payment?.status)) {
            return { success: false, message: 'Payment is being processed. Please refresh in a moment.' }
        }
    }

    paymentId = payment.id
    const paidAmount = Number(payment.amount)

    // Already confirmed (duplicate callback / webhook): idempotent success.
    if (appointment.payment && appointment.status === 'confirmed') {
        if (appointment.razorpayPaymentId && paymentId !== appointment.razorpayPaymentId) {
            // A second, separate payment for an already-paid appointment. Record a durable
            // refund intent first (errors propagate, so a webhook is retried by Razorpay
            // and the order sweep re-checks); execution failures are retried by cron.
            console.error(`Duplicate payment ${paymentId} for already paid appointment ${appointment._id}; refunding.`)
            await ensureRefundIntent({ paymentId, appointmentId: appointment._id, amount: paidAmount, reason: 'duplicate_payment' })
            await processRefundRecord(paymentId, { ignoreSchedule: true })
        }
        return PAID_RESULT
    }

    const now = new Date()

    // Normal case: reservation still holds the slot -> confirm atomically.
    // Competes atomically with expiry, reclaim, release and cancel (all require
    // status 'pending' / cancelled false), so exactly one of them wins.
    const confirmed = await appointmentModel.findOneAndUpdate(
        { _id: appointment._id, status: 'pending', slotLocked: true, cancelled: false },
        { $set: { status: 'confirmed', paymentStatus: 'paid', payment: true, razorpayOrderId: orderId, razorpayPaymentId: paymentId, paidAt: now } },
        { returnDocument: 'after' }
    )
    if (confirmed) return PAID_RESULT

    // Late payment: take the one-time settlement lock so duplicate callbacks
    // cannot settle (or refund) twice. The lock records everything needed to resume.
    const locked = await appointmentModel.findOneAndUpdate(
        { _id: appointment._id, payment: false, status: { $ne: 'pending' }, settlingPaymentId: { $exists: false } },
        { $set: { settlingPaymentId: paymentId, settlingAt: now, settlingAmount: paidAmount, razorpayOrderId: orderId, razorpayPaymentId: paymentId } },
        { returnDocument: 'after' }
    )

    if (!locked) {
        const current = await appointmentModel.findById(appointment._id)
        if (current?.payment && current.status === 'confirmed') return PAID_RESULT
        if (REFUND_STATES.includes(current?.paymentStatus)) return lateResult(current)
        return { success: false, message: 'Payment is being processed. Please refresh in a moment.' }
    }

    return resolveLateSettlement(locked._id)
}

// ---------------------------------------------------------------------------
// Reconciliation jobs
// ---------------------------------------------------------------------------

/**
 * Cron: resumes late settlements whose lease went stale (crash/stall), creates
 * refund records for intents recorded just before a crash, and processes due
 * refund records in deterministic order across several pages. Records that are
 * manual_required or not yet due (backoff) never block newer ones.
 */
export const reconcileLatePayments = async ({ batchSize = 50, maxPages = 4 } = {}) => {
    let resumed = 0
    let refundsProcessed = 0

    const stale = await appointmentModel.find({
        settlingPaymentId: { $exists: true }, payment: false,
        paymentStatus: { $nin: REFUND_STATES },
        settlingAt: { $lte: new Date(Date.now() - SETTLEMENT_LEASE_MS) }
    }).sort({ settlingAt: 1, _id: 1 }).select('_id settlingAt').limit(batchSize).lean()

    for (const item of stale) {
        // take over the lease atomically; only one instance resumes it
        const lease = await appointmentModel.findOneAndUpdate(
            { _id: item._id, settlingAt: item.settlingAt, payment: false },
            { $set: { settlingAt: new Date() } }
        )
        if (!lease) continue
        try {
            await resolveLateSettlement(item._id)
            resumed++
        } catch (error) {
            console.error(`Late settlement resume failed for ${item._id}:`, errorText(error))
        }
    }

    // Refund intents recorded on an appointment but without a refund record yet
    // (crash between the two writes). Bounded: refundRecordedAt is set once handled.
    const handled = new Set() // at most one attempt per payment per run
    const unrecorded = await appointmentModel.find({
        payment: false, paymentStatus: { $in: ['refund_pending', 'refund_failed'] }, refundRecordedAt: { $exists: false }
    }).sort({ _id: 1 }).select('_id refundPaymentId').limit(batchSize).lean()
    for (const item of unrecorded) {
        try {
            const result = await processRefund(item._id, { ignoreSchedule: true })
            const current = await appointmentModel.findById(item._id).select('refundPaymentId').lean()
            if (current?.refundPaymentId) handled.add(current.refundPaymentId)
            if (result) refundsProcessed++
        } catch (error) {
            console.error(`Refund reconcile failed for appointment ${item._id}:`, errorText(error))
        }
    }

    // Due refund records (late + duplicate payments): oldest due first, paginated.
    for (let page = 0; page < maxPages; page++) {
        const now = new Date()
        const due = await refundModel.find({
            status: { $in: ['pending', 'failed'] },
            paymentId: { $nin: [...handled] },
            $and: [lockFree(now), refundDue(now)]
        }).sort({ nextAttemptAt: 1, _id: 1 }).select('paymentId').limit(batchSize).lean()
        if (due.length === 0) break
        for (const item of due) {
            handled.add(item.paymentId)
            try {
                if (await syncRefund(item.paymentId)) refundsProcessed++
            } catch (error) {
                console.error(`Refund reconcile failed for payment ${item.paymentId}:`, errorText(error))
            }
        }
        if (due.length < batchSize) break
    }

    return { resumed, refundsProcessed }
}

export const getOrderReconcileLookbackHours = () => {
    const hours = Number(process.env.ORDER_RECONCILE_LOOKBACK_HOURS)
    return Number.isFinite(hours) && hours > 0 ? hours : 48
}

// All Razorpay orders created for an appointment (orders use the appointment id as receipt).
const listOrdersForAppointment = async (appointmentId) => {
    const rz = getRazorpay()
    const orders = []
    for (let skip = 0; skip < 500; skip += 100) {
        const page = await rz.orders.all({ receipt: String(appointmentId), count: 100, skip })
        const items = page?.items || []
        orders.push(...items)
        if (items.length < 100) break
    }
    return orders
}

/**
 * Webhook-independent reconciliation of recent online reservations that are no
 * longer pending (expired, failed, cancelled, confirmed). Re-reads every Razorpay
 * order for the appointment and settles captured/authorized payments through the
 * normal idempotent path (late payment -> re-confirm or refund; second payment
 * on a confirmed booking -> refund). Bounded: only reservations from the last
 * ORDER_RECONCILE_LOOKBACK_HOURS (default 48), each re-checked on a backoff
 * schedule, oldest due first, claimed atomically so instances never double-check.
 */
export const reconcileRecentOnlineOrders = async ({ batchSize = 25, now = new Date() } = {}) => {
    const since = new Date(now.getTime() - getOrderReconcileLookbackHours() * 60 * 60 * 1000)
    const due = await appointmentModel.find({
        paymentMethod: 'online',
        reservedAt: { $gte: since },
        status: { $ne: 'pending' },   // pending holds are reconciled by cleanupExpiredReservations
        $or: [{ nextOrderCheckAt: { $exists: false } }, { nextOrderCheckAt: null }, { nextOrderCheckAt: { $lte: now } }]
    }).sort({ nextOrderCheckAt: 1, _id: 1 }).select('_id nextOrderCheckAt orderCheckCount').limit(batchSize).lean()

    let checked = 0
    let settled = 0
    for (const item of due) {
        const claimed = await appointmentModel.findOneAndUpdate(
            { _id: item._id, nextOrderCheckAt: item.nextOrderCheckAt ?? null },
            { $set: { nextOrderCheckAt: minutesFrom(now, scheduleMinutes(ORDER_CHECK_MINUTES, item.orderCheckCount || 0)) }, $inc: { orderCheckCount: 1 } }
        )
        if (!claimed) continue
        checked++
        try {
            for (const order of await listOrdersForAppointment(item._id)) {
                if (order.status !== 'paid' && order.status !== 'attempted') continue
                const before = await appointmentModel.findById(item._id).select('payment paymentStatus status').lean()
                await settlePaidOrder({ orderId: order.id })
                const after = await appointmentModel.findById(item._id).select('payment paymentStatus status').lean()
                if (JSON.stringify(before) !== JSON.stringify(after)) settled++
            }
        } catch (error) {
            console.error(`Order reconcile failed for appointment ${item._id}; will retry on schedule.`, errorText(error))
        }
    }
    return { checked, settled }
}

// ---------------------------------------------------------------------------
// Slot consistency repair (appointments <-> doctor.slots_booked)
// ---------------------------------------------------------------------------

const ORPHAN_GRACE_MS = 2 * 60 * 1000
const HOLDER_SCAN_DAYS = 60   // detection scan window (booking date); release always re-checks without bounds

// Day number (YYYYMMDD) of a date in India Standard Time.
export const istDayNumber = (date = new Date()) => {
    const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' })
        .format(date).split('-').map(Number)
    return y * 10000 + m * 100 + d
}

const slotDayNumber = (slotDate) => {
    const [d, m, y] = String(slotDate).split('_').map(Number)
    if (!d || !m || !y || d > 31 || m > 12) return null
    return y * 10000 + m * 100 + d
}

// Repair scope: from IST yesterday onward (a one-day margin across midnight).
export const isInRepairScope = (slotDate, now = new Date()) => {
    const day = slotDayNumber(slotDate)
    return day !== null && day >= istDayNumber(new Date(now.getTime() - 24 * 60 * 60 * 1000))
}

/**
 * Detects and repairs inconsistencies left by a crash between an appointment
 * write and the matching slots_booked write (IST yesterday onward):
 *  - missing entry (active holder, slot not in slots_booked): re-added atomically.
 *    Adding never releases anyone's slot.
 *  - orphan entry (slot in slots_booked, no holder): released only after it has
 *    been seen orphaned on an earlier run at least graceMs ago. Sightings are
 *    stored in the database (shared by all instances); one instance claims the
 *    release atomically; releaseSlot re-checks holders without any date bound,
 *    and the entry is restored if a holder appears meanwhile.
 */
export const repairSlotConsistency = async ({ graceMs = ORPHAN_GRACE_MS, now = new Date() } = {}) => {
    // keys use the canonical time so legacy spellings of one slot compare equal
    const key = (docId, slotDate, slotTime) => `${docId}|${slotDate}|${canonicalSlotTime(slotTime) || slotTime}`
    let added = 0
    let released = 0

    const holders = await appointmentModel.find({
        $or: [
            { cancelled: { $ne: true }, date: { $gte: now.getTime() - HOLDER_SCAN_DAYS * 24 * 60 * 60 * 1000 } },
            { settlingSlotClaimed: true }
        ]
    }).select('docId slotDate slotTime').lean()
    const held = new Set()
    for (const a of holders) {
        if (!isValidSlotInput(a.slotDate, a.slotTime) || !isInRepairScope(a.slotDate, now)) continue
        if (!/^[a-f\d]{24}$/i.test(String(a.docId))) continue
        held.add(key(a.docId, a.slotDate, a.slotTime))
    }

    const doctors = await doctorModel.find({}).select('slots_booked').lean()
    const present = new Set()
    const seenOrphans = []

    for (const doctor of doctors) {
        for (const [slotDate, times] of Object.entries(doctor.slots_booked || {})) {
            if (!Array.isArray(times) || !isValidSlotInput(slotDate, 'x') || !isInRepairScope(slotDate, now)) continue
            for (const slotTime of times) {
                const k = key(doctor._id, slotDate, slotTime)
                present.add(k)
                if (held.has(k)) continue
                seenOrphans.push(k)

                const sighting = await slotOrphanModel.findOne({ key: k }).lean()
                if (!sighting) {
                    try {
                        const created = await slotOrphanModel.create({ key: k, docId: String(doctor._id), slotDate, slotTime, firstSeenAt: now })
                        // This run read the slot list earlier; another instance may have released
                        // the entry since. Re-check AFTER our own write and drop a stale sighting.
                        // (A release that happens after this check deletes it, see below.)
                        const stillListed = await doctorModel.exists({ _id: doctor._id, [`slots_booked.${slotDate}`]: { $in: slotTimeVariants(slotTime) } })
                        if (!stillListed) await slotOrphanModel.deleteOne({ _id: created._id })
                    } catch (error) {
                        if (error?.code !== 11000) throw error
                    }
                    continue // first sighting: never release now
                }
                if (now.getTime() - new Date(sighting.firstSeenAt).getTime() < graceMs) continue

                // exactly one instance proceeds with this release
                const claimed = await slotOrphanModel.findOneAndDelete({ key: k, firstSeenAt: sighting.firstSeenAt })
                if (!claimed) continue

                const releasedNow = await releaseSlot(doctor._id, slotDate, slotTime)
                // Drop every sighting of this slot AFTER the release: one created concurrently by
                // another instance (which read the list before the release) must not survive.
                await slotOrphanModel.deleteMany({ key: k })
                if (releasedNow) {
                    if (await appointmentModel.exists(holderFilter(doctor._id, slotDate, slotTime))) {
                        await doctorModel.updateOne(
                            { _id: doctor._id, [`slots_booked.${slotDate}`]: { $nin: slotTimeVariants(slotTime) } },
                            { $push: { [`slots_booked.${slotDate}`]: slotTime } }
                        )
                    } else {
                        released++
                        console.log(`Slot repair: released orphaned slot ${k}`)
                    }
                }
            }
        }
    }
    // forget sightings that are no longer orphaned (or out of scope)
    await slotOrphanModel.deleteMany({ key: { $nin: seenOrphans } })

    for (const k of held) {
        if (present.has(k)) continue
        const [docId, slotDate, slotTime] = k.split('|')
        const res = await doctorModel.updateOne(
            { _id: docId, [`slots_booked.${slotDate}`]: { $nin: slotTimeVariants(slotTime) } },
            { $push: { [`slots_booked.${slotDate}`]: slotTime } }
        )
        if (res.modifiedCount) {
            added++
            console.log(`Slot repair: re-added missing slot ${k}`)
        }
    }

    return { added, released }
}

// ---------------------------------------------------------------------------
// Cron cleanup
// ---------------------------------------------------------------------------

/**
 * Expires pending online reservations whose expiresAt has passed.
 * Idempotent and safe across multiple backend instances: every state change
 * is a conditional update, and only the winner releases the slot.
 */
export const cleanupExpiredReservations = async ({ batchSize = 100 } = {}) => {
    const now = new Date()
    const candidates = await appointmentModel
        .find({ status: 'pending', expiresAt: { $lte: now } })
        .sort({ expiresAt: 1, _id: 1 })
        .select('_id docId slotDate slotTime razorpayOrderId')
        .limit(batchSize)
        .lean()

    let expired = 0
    let reconciled = 0

    for (const appointment of candidates) {
        try {
            // Reconcile first: a payment may have been captured or authorized
            // without the browser reaching verifyRazorpay (tab closed, network drop).
            if (appointment.razorpayOrderId) {
                try {
                    const order = await getRazorpay().orders.fetch(appointment.razorpayOrderId)
                    if (order?.status === 'paid' || order?.status === 'attempted') {
                        await settlePaidOrder({ orderId: appointment.razorpayOrderId })
                        const current = await appointmentModel.findById(appointment._id).select('status').lean()
                        if (current?.status !== 'pending') {
                            reconciled++
                            continue
                        }
                    }
                } catch (error) {
                    // Razorpay unreachable: expire anyway. The order sweep / webhook
                    // settles (re-claim or refund) the payment later.
                    console.error(`Reservation reconcile failed for ${appointment._id}:`, errorText(error))
                }
            }

            const before = await appointmentModel.findOneAndUpdate(
                { _id: appointment._id, status: 'pending', expiresAt: { $lte: now } },
                { $set: expiredFields() },
                { returnDocument: 'before' }
            )
            if (before) {
                if (before.slotLocked) await releaseSlot(before.docId, before.slotDate, before.slotTime, { excludeAppointmentId: before._id })
                expired++
            }
        } catch (error) {
            console.error(`Reservation cleanup failed for ${appointment._id}:`, error?.message || error)
        }
    }

    return { checked: candidates.length, expired, reconciled }
}
