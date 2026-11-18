// Resolve a historical PAID double booking in a TEST database: keep one appointment,
// cancel the other and refund its exact Razorpay payment through the app's durable,
// idempotent refund engine (cancelPaidDuplicateAndRefund).
//
//   MONGODB_DB_NAME=prescripto_test node scripts/resolveDuplicatePayment.js \
//     --keep <appointmentId> --keep-order <order_id> --keep-payment <pay_id> \
//     --cancel <appointmentId> --order <order_id> --payment <pay_id> [--apply]
//
// Dry run by default (read-only: database + Razorpay GET requests). Guards:
//   - MONGODB_DB_NAME must be set, must end in "_test" and must not be "prescripto";
//     the connected database name is verified before anything else.
//   - RAZORPAY_KEY_ID must be a Test Mode key (rzp_test_...).

import 'dotenv/config'
import mongoose from 'mongoose'
import appointmentModel from '../models/appointmentModel.js'
import refundModel from '../models/refundModel.js'
import doctorModel from '../models/doctorModel.js'
import { getRazorpay, canonicalSlotTime, cancelPaidDuplicateAndRefund } from '../utils/slotReservation.js'

const arg = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : undefined }
const APPLY = process.argv.includes('--apply')
const opts = {
    keep: arg('--keep'), keepOrder: arg('--keep-order'), keepPayment: arg('--keep-payment'),
    cancel: arg('--cancel'), order: arg('--order'), payment: arg('--payment')
}

const refuse = (message) => { console.error(`Refusing: ${message}`); process.exitCode = 1 }

const run = async () => {
    const dbName = process.env.MONGODB_DB_NAME
    if (!dbName) return refuse('MONGODB_DB_NAME must be set explicitly (e.g. MONGODB_DB_NAME=prescripto_test)')
    if (dbName === 'prescripto' || !dbName.endsWith('_test')) return refuse(`"${dbName}" is not a test database (name must end in "_test")`)
    if (!String(process.env.RAZORPAY_KEY_ID || '').trim().startsWith('rzp_test_')) return refuse('RAZORPAY_KEY_ID is not a Razorpay Test Mode key (rzp_test_...)')
    if (Object.values(opts).some(v => !v)) return refuse('--keep, --keep-order, --keep-payment, --cancel, --order and --payment are all required')

    await mongoose.connect(process.env.MONGODB_URI, { dbName })
    if (mongoose.connection.db.databaseName !== dbName) return refuse(`connected to "${mongoose.connection.db.databaseName}", expected "${dbName}"`)
    console.log(`${APPLY ? '*** APPLY ***' : 'DRY RUN (read-only)'}  database=${mongoose.connection.db.databaseName}  razorpay=TEST MODE`)

    const rz = getRazorpay()
    const problems = []
    const describe = async (label, id, orderId, paymentId) => {
        const a = await appointmentModel.findById(id).lean()
        if (!a) { problems.push(`${label}: appointment ${id} not found`); return null }
        const [order, payment] = await Promise.all([rz.orders.fetch(orderId), rz.payments.fetch(paymentId)])
        const refunds = (await rz.payments.fetchMultipleRefund(paymentId, { count: 100 }))?.items || []
        const record = await refundModel.findOne({ paymentId }).lean()
        console.log(`\n${label} ${id}  user=${a.userId}  slot=${a.slotDate} ${JSON.stringify(a.slotTime)}  booked=${new Date(a.date).toISOString()}`)
        console.log(`  db:       cancelled=${a.cancelled} payment=${a.payment} paymentStatus=${a.paymentStatus} slotLocked=${a.slotLocked} refundPaymentId=${a.refundPaymentId}`)
        console.log(`  order:    ${order.id} receipt=${order.receipt} status=${order.status} amount_paid=${order.amount_paid}`)
        console.log(`  payment:  ${payment.id} order=${payment.order_id} status=${payment.status} amount=${payment.amount} amount_refunded=${payment.amount_refunded}`)
        console.log(`  refunds at Razorpay: ${refunds.length ? refunds.map(r => `${r.id}:${r.status}:${r.amount}`).join(', ') : 'none'}  | refund record: ${record ? `${record.status} (${record.refundId || 'no refund id yet'})` : 'none'}`)
        if (String(order.receipt) !== String(id)) problems.push(`${label}: order receipt ${order.receipt} != appointment ${id}`)
        if (payment.order_id !== orderId) problems.push(`${label}: payment belongs to ${payment.order_id}`)
        return { a, payment, refunds, record }
    }

    const keep = await describe('KEEP  ', opts.keep, opts.keepOrder, opts.keepPayment)
    const cancel = await describe('CANCEL', opts.cancel, opts.order, opts.payment)
    if (keep && cancel) {
        const sameSlot = keep.a.docId === cancel.a.docId && keep.a.slotDate === cancel.a.slotDate && canonicalSlotTime(keep.a.slotTime) === canonicalSlotTime(cancel.a.slotTime)
        if (!sameSlot) problems.push('appointments are not for the same doctor/date/time')
        if (keep.a.cancelled || !keep.a.payment) problems.push('KEEP appointment must be active and paid')
        if (keep.payment.status !== 'captured' || keep.payment.amount_refunded > 0 || keep.refunds.length || keep.record) problems.push('KEEP payment must be captured and have no refunds')
        const resuming = cancel.a.cancelled && cancel.a.refundPaymentId === opts.payment
        if (!resuming && (cancel.a.cancelled || !cancel.a.payment)) problems.push('CANCEL appointment must be active and paid')
        if (!['captured', 'refunded'].includes(cancel.payment.status)) problems.push('CANCEL payment is not captured')
        if (!cancel.record && cancel.refunds.some(r => r.status !== 'failed')) problems.push('CANCEL payment already has a refund this app did not create')
        if (opts.keepPayment === opts.payment) problems.push('keep and cancel payments are the same')
    }

    if (problems.length) {
        problems.forEach(p => console.error(`  PROBLEM: ${p}`))
        return refuse('safety checks failed; nothing was changed')
    }
    console.log(`\nPlan: keep ${opts.keep}; cancel ${opts.cancel} without releasing the kept slot; refund ${opts.payment} (${cancel.payment.amount} paise) once.`)
    if (!APPLY) return console.log('Dry run complete. Re-run with --apply to execute.')

    // record the verified payment link on the kept appointment (only if missing)
    await appointmentModel.updateOne(
        { _id: opts.keep, razorpayPaymentId: { $exists: false } },
        { $set: { razorpayOrderId: opts.keepOrder, razorpayPaymentId: opts.keepPayment, paymentStatus: 'paid' } }
    )
    const result = await cancelPaidDuplicateAndRefund({ appointmentId: opts.cancel, keepAppointmentId: opts.keep, paymentId: opts.payment, orderId: opts.order })
    const refunds = (await rz.payments.fetchMultipleRefund(opts.payment, { count: 100 }))?.items || []
    const keptNow = await appointmentModel.findById(opts.keep).lean()
    const doctor = await doctorModel.findById(keptNow.docId).select('slots_booked').lean()
    console.log('\nRESULT')
    console.log(`  cancelled appointment: cancelled=${result.appointment.cancelled} status=${result.appointment.status} payment=${result.appointment.payment} paymentStatus=${result.appointment.paymentStatus} refundId=${result.appointment.refundId} refundStatus=${result.appointment.refundStatus}`)
    console.log(`  refund record: status=${result.refund?.status} refundId=${result.refund?.refundId} refundStatus=${result.refund?.refundStatus} attempts=${result.refund?.attempts}`)
    console.log(`  Razorpay refunds for ${opts.payment}: ${refunds.map(r => `${r.id}:${r.status}:${r.amount}`).join(', ') || 'none'}`)
    console.log(`  kept appointment: cancelled=${keptNow.cancelled} payment=${keptNow.payment} slotLocked=${keptNow.slotLocked}`)
    console.log(`  slots_booked[${keptNow.slotDate}] = ${JSON.stringify(doctor?.slots_booked?.[keptNow.slotDate])}`)
}

run()
    .catch(error => { console.error('Resolution aborted:', error?.error?.description || error.message); process.exitCode = 1 })
    .finally(() => mongoose.disconnect())
