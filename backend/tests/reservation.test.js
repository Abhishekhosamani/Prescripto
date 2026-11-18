// Regression tests: slot reservation, double booking, online-only payment, refunds.
// Run: npm test (from backend/). Uses an in-memory MongoDB only: never reads .env and
// never connects to any real database. Razorpay is a fake client; API semantics it
// models (beyond what the SDK source shows) are ASSUMPTIONS, see docs/RAZORPAY_SETUP.md.
import { createRequire } from 'module'
import { pathToFileURL, fileURLToPath } from 'url'
import crypto from 'crypto'
import assert from 'assert/strict'
import os from 'os'
import { MongoMemoryServer } from 'mongodb-memory-server'

const BACKEND = fileURLToPath(new URL('..', import.meta.url)).replace(/[\/]$/, '')
const requireBackend = createRequire(pathToFileURL(BACKEND + '/package.json'))
const mongoose = requireBackend('mongoose')
const imp = (p) => import(pathToFileURL(`${BACKEND}/${p}`).href)
// child processes run in an empty temp dir so dotenv can never load the real .env
const SANDBOX_CWD = requireBackend('fs').mkdtempSync(requireBackend('path').join(os.tmpdir(), 'prescripto-test-'))
// Backend modules such as config/cloudinary.js import 'dotenv/config'. Point dotenv at a
// non-existent file in the sandbox so the real backend/.env is never loaded into the
// test process or inherited by child processes.
process.env.DOTENV_CONFIG_PATH = requireBackend('path').join(SANDBOX_CWD, '.env')
delete process.env.MONGODB_DB_NAME
const MIGRATION_DB = 'prescripto_migration_test'

process.env.RAZORPAY_KEY_SECRET = 'test_secret'
process.env.RAZORPAY_KEY_ID = 'test_key'
process.env.RAZORPAY_WEBHOOK_SECRET = 'wh_secret'
process.env.CURRENCY = 'INR'

// ---------- fake Razorpay (behaviour modelled on SDK v2.9.6; API semantics are ASSUMPTIONS) ----------
const rz = { orders: new Map(), payments: new Map(), refunds: [], seq: 0, ordersAllCalls: 0, captureCalls: 0 }
// SDK normalises API errors to { statusCode, error }; a timeout has no response and
// the SDK's normalizeError then throws a TypeError (verified in SDK source).
const apiError = (description) => ({ statusCode: 400, error: { code: 'BAD_REQUEST_ERROR', description } })
const sdkTimeoutError = () => new TypeError("Cannot read properties of undefined (reading 'status')")
const fakeClient = {
    orders: {
        create: async ({ amount, currency, receipt }) => {
            const o = { id: `order_${++rz.seq}`, amount, currency, receipt, status: 'created', amount_paid: 0 }
            rz.orders.set(o.id, o); return { ...o }
        },
        fetch: async (id) => { const o = rz.orders.get(id); if (!o) throw apiError('order not found'); return { ...o } },
        fetchPayments: async (id) => ({ items: [...rz.payments.values()].filter(p => p.order_id === id).map(p => ({ ...p })) }),
        all: async ({ receipt, count = 10, skip = 0 } = {}) => {
            rz.ordersAllCalls++
            const items = [...rz.orders.values()].filter(o => !receipt || o.receipt === receipt)
            return { items: items.slice(skip, skip + count).map(o => ({ ...o })) }
        }
    },
    payments: {
        fetch: async (pid) => { const p = rz.payments.get(pid); if (!p) throw apiError('payment not found'); return { ...p } },
        capture: async (pid, amount, currency) => {
            rz.captureCalls++
            const p = rz.payments.get(pid)
            if (p.status !== 'authorized') throw apiError('This payment has already been captured')
            p.status = 'captured'
            const o = rz.orders.get(p.order_id); o.status = 'paid'; o.amount_paid = amount
            return { ...p }
        },
        fetchMultipleRefund: async (pid) => ({ items: rz.refunds.filter(r => r.paymentId === pid).map(r => ({ id: r.id, amount: r.amount, status: r.status })) }),
        refund: async (paymentId, params) => {
            rz.refundCalls = (rz.refundCalls || 0) + 1
            if (rz.failNextRefunds > 0) { rz.failNextRefunds--; throw apiError('gateway error (injected)') }
            const p = rz.payments.get(paymentId)
            // like Razorpay: reject refunds beyond the unrefunded amount (failed refunds do not count)
            const live = rz.refunds.filter(r => r.paymentId === paymentId && r.status !== 'failed').reduce((s, r) => s + r.amount, 0)
            if (live + params.amount > p.amount) throw apiError('The total refund amount is greater than the refund payment amount')
            p.amount_refunded = live + params.amount
            const r = { id: `rfnd_${rz.refunds.length + 1}`, paymentId, params, amount: params.amount, status: rz.nextRefundStatus || 'processed' }
            rz.refunds.push(r)
            if (rz.crashAfterRefund) { rz.crashAfterRefund = false; throw new Error('process crashed after refund API call (injected)') }
            if (rz.timeoutAfterRefund) { rz.timeoutAfterRefund = false; throw sdkTimeoutError() }
            return { id: r.id, amount: r.amount, status: r.status }
        }
    }
}
const payOrder = (orderId) => {
    const o = rz.orders.get(orderId); const pid = `pay_${++rz.seq}`
    o.status = 'paid'; o.amount_paid = o.amount
    rz.payments.set(pid, { id: pid, order_id: orderId, status: 'captured', amount: o.amount, currency: 'INR', amount_refunded: 0, created_at: Math.floor(Date.now() / 1000) })
    const sig = crypto.createHmac('sha256', 'test_secret').update(`${orderId}|${pid}`).digest('hex')
    return { razorpay_order_id: orderId, razorpay_payment_id: pid, razorpay_signature: sig }
}
// a rejected/failed Checkout attempt: payment 'failed', order 'attempted'
const failAttempt = (orderId) => {
    const o = rz.orders.get(orderId); const pid = `pay_${++rz.seq}`
    if (o.status !== 'paid') o.status = 'attempted'
    rz.payments.set(pid, { id: pid, order_id: orderId, status: 'failed', amount: o.amount, currency: 'INR', amount_refunded: 0, created_at: Math.floor(Date.now() / 1000) })
    return pid
}
// manual-capture account: payment authorized, order 'attempted', nothing captured
const authorizeOrder = (orderId) => {
    const o = rz.orders.get(orderId); const pid = `pay_${++rz.seq}`
    o.status = 'attempted'
    rz.payments.set(pid, { id: pid, order_id: orderId, status: 'authorized', amount: o.amount, currency: 'INR', amount_refunded: 0, created_at: Math.floor(Date.now() / 1000) })
    const sig = crypto.createHmac('sha256', 'test_secret').update(`${orderId}|${pid}`).digest('hex')
    return { razorpay_order_id: orderId, razorpay_payment_id: pid, razorpay_signature: sig }
}

// ---------- boot ----------
const mongod = await MongoMemoryServer.create()
process.env.MONGODB_URI = mongod.getUri()
assert.match(process.env.MONGODB_URI, /^mongodb:\/\/127\.0\.0\.1:\d+\//, 'tests must only use the in-memory MongoDB')
await mongoose.connect(mongod.getUri(), { dbName: 'prescripto_test' })

const doctorModel = (await imp('models/doctorModel.js')).default
const appointmentModel = (await imp('models/appointmentModel.js')).default
const userModel = (await imp('models/userModel.js')).default
const refundModel = (await imp('models/refundModel.js')).default
await refundModel.init()
const slotOrphanModel = (await imp('models/slotOrphanModel.js')).default
await slotOrphanModel.init()
// all refund records due now (simulates time passing beyond the retry/re-check backoff)
const makeRefundsDue = () => refundModel.updateMany({}, { $set: { nextAttemptAt: new Date(Date.now() - 1000) } })

// Legacy duplicate active appointments (like production) must not block index creation
const legacy = { userId: 'u0', docId: 'legacyDoc', slotDate: '1_1_2026', slotTime: '10:00 AM', userData: {}, docData: {}, amount: 1, date: 1 }
await appointmentModel.collection.insertMany([{ ...legacy, cancelled: false, payment: false, isCompleted: false }, { ...legacy, cancelled: false, payment: false, isCompleted: false }])
await appointmentModel.init() // builds schema indexes (what autoIndex does at startup)
const idx = await appointmentModel.collection.indexes()

const R = await imp('utils/slotReservation.js')
R.__setRazorpayFactory(() => fakeClient)
const userCtl = await imp('controllers/userController.js')
// importing the controllers ran dotenv (via config/cloudinary.js): nothing real may have loaded
assert.equal(process.env.MONGODB_URI, mongod.getUri(), 'in-memory MongoDB URI unchanged')
for (const key of ['JWT_SECRET', 'CLOUDINARY_API_KEY', 'CLOUDINARY_SECRET_KEY', 'GROQ_API_KEY', 'ADMIN_PASSWORD', 'ALLOWED_ORIGINS']) {
    assert.equal(process.env[key], undefined, `${key} must not be loaded from a real .env during tests`)
}
const docCtl = await imp('controllers/doctorController.js')
const adminCtl = await imp('controllers/adminController.js')

const call = (handler, { body = {}, userId, docId, headers = {} } = {}) => new Promise((resolve, reject) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json(d) { resolve({ status: this.statusCode, ...d }) } }
    Promise.resolve(handler({ body, userId, docId, headers }, res)).catch(reject)
})

const mkDoctor = (n) => doctorModel.create({ name: `Dr ${n}`, email: `d${n}@x.com`, password: 'x', image: 'i', speciality: 's', degree: 'd', experience: '1', about: 'a', fees: 500, address: {}, date: Date.now() })
const users = await Promise.all(Array.from({ length: 12 }, (_, i) => userModel.create({ name: `U${i}`, email: `u${i}@x.com`, password: 'x' })))
const uid = (i) => String(users[i]._id)
const slotsOf = async (docId, date) => ((await doctorModel.findById(docId).lean()).slots_booked[date] || [])
const book = (i, docId, slotDate, slotTime, paymentMethod) => call(userCtl.bookAppointment, { userId: uid(i), body: { docId: String(docId), slotDate, slotTime, ...(paymentMethod !== undefined ? { paymentMethod } : {}) } })
const expireNow = (id) => appointmentModel.updateOne({ _id: id }, { $set: { expiresAt: new Date(Date.now() - 60 * 1000) } })
// mark a payment as made at a given time (Razorpay created_at, seconds)
const setPaymentCreatedAt = (pid, date) => { rz.payments.get(pid).created_at = Math.floor(date.getTime() / 1000) }

const results = []
const test = async (name, fn) => {
    try { await fn(); results.push(['PASS', name]) } catch (e) { results.push(['FAIL', name, e.stack || e.message]) }
}

const D = '20_11_2026'

await test('0. Unique partial index built despite legacy duplicates', async () => {
    const u = idx.find(i => i.name === 'unique_active_slot')
    assert.ok(u && u.unique && u.partialFilterExpression.slotLocked === true)
    assert.equal(await appointmentModel.countDocuments({ docId: 'legacyDoc' }), 2) // nothing deleted
})

await test('1. Simultaneous bookings of the same slot: only one succeeds', async () => {
    const doc = await mkDoctor(1)
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => book(i, doc._id, D, '10:00 AM')))
    assert.equal(rs.filter(r => r.success).length, 1, JSON.stringify(rs.map(r => r.message)))
    rs.filter(r => !r.success).forEach(r => assert.equal(r.message, 'Slot not available'))
    assert.equal(await appointmentModel.countDocuments({ docId: String(doc._id), slotTime: '10:00 AM' }), 1)
    assert.deepEqual(await slotsOf(doc._id, D), ['10:00 AM'])
})

await test('1b. Simultaneous bookings with and without an explicit online method: only one succeeds', async () => {
    const doc = await mkDoctor(2)
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => book(i, doc._id, D, '11:00 AM', i % 2 ? 'online' : undefined)))
    assert.equal(rs.filter(r => r.success).length, 1)
    assert.equal(await appointmentModel.countDocuments({ docId: String(doc._id), slotLocked: true }), 1)
})

await test('1c. Concurrent bookings of DIFFERENT slots on the same doctor are all kept (no lost updates)', async () => {
    const doc = await mkDoctor(3)
    const times = ['10:00 AM', '10:30 AM', '11:00 AM', '11:30 AM', '12:00 PM', '12:30 PM']
    const rs = await Promise.all(times.map((t, i) => book(i, doc._id, D, t)))
    assert.ok(rs.every(r => r.success))
    assert.deepEqual((await slotsOf(doc._id, D)).sort(), [...times].sort())
})

await test('1d. Two different doctors can have the same time', async () => {
    const a = await mkDoctor(4), b = await mkDoctor(5)
    const [r1, r2] = await Promise.all([book(0, a._id, D, '10:00 AM'), book(1, b._id, D, '10:00 AM')])
    assert.ok(r1.success && r2.success)
})

let doc6, resv
await test('2. Second user rejected while first reservation is active', async () => {
    doc6 = await mkDoctor(6)
    resv = await book(0, doc6._id, D, '10:00 AM', 'online')
    assert.ok(resv.success && resv.order && resv.appointmentId && resv.expiresAt)
    const a = await appointmentModel.findById(resv.appointmentId)
    assert.equal(a.status, 'pending'); assert.equal(a.paymentStatus, 'pending'); assert.equal(a.payment, false)
    assert.ok(a.reservedAt); const mins = (a.expiresAt - a.reservedAt) / 60000; assert.equal(mins, 10)
    assert.equal(a.razorpayOrderId, resv.order.id)
    const r2 = await book(1, doc6._id, D, '10:00 AM'); assert.equal(r2.success, false); assert.equal(r2.message, 'Slot not available')
    const r3 = await book(2, doc6._id, D, '10:00 AM', 'online'); assert.equal(r3.success, false)
    // slot listing still shows it booked while active
    const list = await call(docCtl.doctorList)
    assert.ok(list.doctors.find(d => String(d._id) === String(doc6._id)).slots_booked[D].includes('10:00 AM'))
})

await test('3/12. Payment within window confirms; duplicate verify + webhook are idempotent', async () => {
    const resp = payOrder(resv.order.id)
    const v1 = await call(userCtl.verifyRazorpay, { userId: uid(0), body: resp })
    assert.ok(v1.success, v1.message)
    const [v2, v3] = await Promise.all([call(userCtl.verifyRazorpay, { userId: uid(0), body: resp }), call(userCtl.verifyRazorpay, { userId: uid(0), body: resp })])
    assert.ok(v2.success && v3.success)
    const raw = Buffer.from(JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: resp.razorpay_payment_id, order_id: resp.razorpay_order_id } } } }))
    const sig = crypto.createHmac('sha256', 'wh_secret').update(raw).digest('hex')
    const wh = await call(userCtl.razorpayWebhook, { body: raw, headers: { 'x-razorpay-signature': sig } })
    assert.equal(wh.status, 200)
    const a = await appointmentModel.findById(resv.appointmentId)
    assert.equal(a.status, 'confirmed'); assert.equal(a.paymentStatus, 'paid'); assert.equal(a.payment, true); assert.equal(a.cancelled, false)
    assert.equal(a.razorpayPaymentId, resp.razorpay_payment_id)
    assert.equal(rz.refunds.length, 0)
    assert.equal(await appointmentModel.countDocuments({ docId: String(doc6._id), slotTime: '10:00 AM', payment: true }), 1)
})

await test('9. Confirmed appointment never expires (even past expiresAt, cron + booking)', async () => {
    await expireNow(resv.appointmentId)
    await R.cleanupExpiredReservations()
    const r = await book(3, doc6._id, D, '10:00 AM')
    assert.equal(r.success, false)
    const a = await appointmentModel.findById(resv.appointmentId)
    assert.equal(a.status, 'confirmed'); assert.equal(a.cancelled, false)
    assert.deepEqual(await slotsOf(doc6._id, D), ['10:00 AM'])
})

await test('Security: forged / missing signature is rejected', async () => {
    const doc = await mkDoctor(7)
    const r = await book(0, doc._id, D, '10:00 AM', 'online')
    const resp = payOrder(r.order.id)
    const bad = await call(userCtl.verifyRazorpay, { userId: uid(0), body: { ...resp, razorpay_signature: 'deadbeef' } })
    assert.equal(bad.success, false)
    const none = await call(userCtl.verifyRazorpay, { userId: uid(0), body: { razorpay_order_id: resp.razorpay_order_id } })
    assert.equal(none.success, false)
    const wh = await call(userCtl.razorpayWebhook, { body: Buffer.from('{}'), headers: { 'x-razorpay-signature': 'x' } })
    assert.equal(wh.status, 400)
    assert.equal((await appointmentModel.findById(r.appointmentId)).payment, false)
})

await test('4. Payment failure does NOT release the slot; only the owner can report it', async () => {
    const doc = await mkDoctor(8)
    const r = await book(0, doc._id, D, '10:00 AM', 'online')
    failAttempt(r.order.id)
    const notOwner = await call(userCtl.reportPaymentFailure, { userId: uid(1), body: { appointmentId: String(r.appointmentId) } })
    assert.deepEqual([notOwner.success, notOwner.message], [false, 'Unauthorized action'])
    const rep = await call(userCtl.reportPaymentFailure, { userId: uid(0), body: { appointmentId: String(r.appointmentId) } })
    assert.ok(rep.success, rep.message); assert.equal(rep.reservationActive, true)
    const a = await appointmentModel.findById(r.appointmentId)
    assert.equal(a.status, 'pending'); assert.equal(a.paymentStatus, 'pending'); assert.equal(a.slotLocked, true); assert.equal(a.cancelled, false)
    assert.deepEqual(await slotsOf(doc._id, D), ['10:00 AM'])
    assert.equal((await book(1, doc._id, D, '10:00 AM')).success, false)
})

let doc9, expiring
await test('5/7. Abandoned checkout: slot shown available and bookable after expiry BEFORE cron runs', async () => {
    doc9 = await mkDoctor(9)
    expiring = await book(0, doc9._id, D, '10:00 AM', 'online')
    await expireNow(expiring.appointmentId)
    const list = await call(docCtl.doctorList)
    assert.ok(!list.doctors.find(d => String(d._id) === String(doc9._id)).slots_booked[D].includes('10:00 AM'))
    // DB untouched by listing
    assert.equal((await appointmentModel.findById(expiring.appointmentId)).status, 'pending')
})

await test('6. Another user books after expiry (concurrently: only one wins)', async () => {
    const rs = await Promise.all([1, 2, 3, 4, 5].map(i => book(i, doc9._id, D, '10:00 AM')))
    assert.equal(rs.filter(r => r.success).length, 1)
    const old = await appointmentModel.findById(expiring.appointmentId)
    assert.equal(old.status, 'expired'); assert.equal(old.paymentStatus, 'unpaid'); assert.equal(old.cancelled, true); assert.equal(old.slotLocked, false)
    assert.deepEqual(await slotsOf(doc9._id, D), ['10:00 AM'])
    assert.equal(await appointmentModel.countDocuments({ docId: String(doc9._id), slotLocked: true }), 1)
})

await test('13. Late payment after slot rebooked: not confirmed, refunded, new booking intact; duplicate late callbacks refund once', async () => {
    const resp = payOrder(expiring.order.id)
    const [l1, l2] = await Promise.all([call(userCtl.verifyRazorpay, { userId: uid(0), body: resp }), call(userCtl.verifyRazorpay, { userId: uid(0), body: resp })])
    assert.equal(l1.success, false); assert.equal(l2.success, false)
    const l3 = await call(userCtl.verifyRazorpay, { userId: uid(0), body: resp })
    assert.equal(l3.success, false)
    const old = await appointmentModel.findById(expiring.appointmentId)
    assert.equal(old.payment, false); assert.equal(old.status, 'expired'); assert.equal(old.paymentStatus, 'refunded')
    assert.equal(rz.refunds.filter(x => x.paymentId === resp.razorpay_payment_id).length, 1)
    assert.equal(await appointmentModel.countDocuments({ docId: String(doc9._id), slotLocked: true, cancelled: false }), 1)
    assert.deepEqual(await slotsOf(doc9._id, D), ['10:00 AM'])
})

await test('13b. Late payment while slot still free: slot re-claimed and confirmed (no refund)', async () => {
    const doc = await mkDoctor(10)
    const r = await book(0, doc._id, D, '10:00 AM', 'online')
    await expireNow(r.appointmentId)
    await R.cleanupExpiredReservations()
    assert.deepEqual(await slotsOf(doc._id, D), [])
    const before = rz.refunds.length
    const v = await call(userCtl.verifyRazorpay, { userId: uid(0), body: payOrder(r.order.id) })
    assert.ok(v.success, v.message)
    const a = await appointmentModel.findById(r.appointmentId)
    assert.equal(a.status, 'confirmed'); assert.equal(a.cancelled, false); assert.equal(a.slotLocked, true)
    assert.deepEqual(await slotsOf(doc._id, D), ['10:00 AM'])
    assert.equal(rz.refunds.length, before)
})

await test('8. Cron expires records (kept for history), releases slot, idempotent with parallel runs', async () => {
    const doc = await mkDoctor(11)
    const r = await book(0, doc._id, D, '10:00 AM', 'online')
    await expireNow(r.appointmentId)
    const runs = await Promise.all([R.cleanupExpiredReservations(), R.cleanupExpiredReservations(), R.cleanupExpiredReservations()])
    assert.equal(runs.reduce((s, x) => s + x.expired, 0), 1)
    const a = await appointmentModel.findById(r.appointmentId)
    assert.ok(a); assert.equal(a.status, 'expired'); assert.equal(a.paymentStatus, 'unpaid'); assert.equal(a.cancelled, true)
    assert.deepEqual(await slotsOf(doc._id, D), [])
    // re-run does nothing, and a re-book is not undone by a later cron pass
    assert.ok((await book(1, doc._id, D, '10:00 AM')).success)
    await R.cleanupExpiredReservations()
    assert.deepEqual(await slotsOf(doc._id, D), ['10:00 AM'])
})

await test('8b. Cron reconciles a paid-but-unverified order (tab closed after paying) instead of expiring it', async () => {
    const doc = await mkDoctor(12)
    const r = await book(0, doc._id, D, '10:00 AM', 'online')
    payOrder(r.order.id)
    await expireNow(r.appointmentId)
    const res = await R.cleanupExpiredReservations()
    assert.equal(res.reconciled, 1)
    const a = await appointmentModel.findById(r.appointmentId)
    assert.equal(a.status, 'confirmed'); assert.equal(a.payment, true)
    assert.ok(a.razorpayPaymentId)
})

await test('Resume payment: Pay Online reuses the reservation order; rejected after expiry', async () => {
    const doc = await mkDoctor(13)
    const r = await book(0, doc._id, D, '10:00 AM', 'online')
    const p = await call(userCtl.paymentRazorpay, { userId: uid(0), body: { appointmentId: String(r.appointmentId) } })
    assert.ok(p.success); assert.equal(p.order.id, r.order.id); assert.ok(p.expiresAt)
    await expireNow(r.appointmentId)
    const p2 = await call(userCtl.paymentRazorpay, { userId: uid(0), body: { appointmentId: String(r.appointmentId) } })
    assert.equal(p2.success, false)
})

await test('11. COD / cash / pay-at-clinic rejected by the backend; booking never confirms on creation', async () => {
    const doc = await mkDoctor(14)
    for (const method of ['cash', 'cod', 'COD', 'pay_at_clinic', 'offline', '']) {
        const r = await book(0, doc._id, D, '10:00 AM', method === '' ? '' : method)
        assert.equal(r.success, false, method); assert.match(r.message, /Online payment is required/)
    }
    assert.equal(await appointmentModel.countDocuments({ docId: String(doc._id) }), 0)
    assert.deepEqual(await slotsOf(doc._id, D), [])
    // a booking without a method is an online reservation, never confirmed on creation
    const r = await book(0, doc._id, D, '10:00 AM')
    assert.ok(r.success && r.order)
    const a = await appointmentModel.findById(r.appointmentId)
    assert.equal(a.paymentMethod, 'online'); assert.equal(a.status, 'pending'); assert.equal(a.payment, false); assert.ok(a.expiresAt)
})
await test('11b. Legacy appointment (no new fields) can still be paid online', async () => {
    const doc = await mkDoctor(15)
    const [legacyAppt] = await appointmentModel.collection.insertMany([{ userId: uid(0), docId: String(doc._id), slotDate: D, slotTime: '04:00 PM', userData: {}, docData: {}, amount: 500, date: 1, cancelled: false, payment: false, isCompleted: false }]).then(r => Object.values(r.insertedIds))
    const p = await call(userCtl.paymentRazorpay, { userId: uid(0), body: { appointmentId: String(legacyAppt) } })
    const v = await call(userCtl.verifyRazorpay, { userId: uid(0), body: payOrder(p.order.id) })
    assert.ok(v.success)
    const a = await appointmentModel.findById(legacyAppt).lean()
    assert.equal(a.payment, true); assert.equal(a.status, undefined)
})

await test('10. User / doctor / admin cancellation release the slot; repeated cancel cannot free a re-booked slot', async () => {
    const doc = await mkDoctor(16)
    await book(0, doc._id, D, '10:00 AM'); await book(1, doc._id, D, '10:30 AM'); await book(2, doc._id, D, '11:00 AM')
    const [a0, a1, a2] = await Promise.all(['10:00 AM', '10:30 AM', '11:00 AM'].map(t => appointmentModel.findOne({ docId: String(doc._id), slotTime: t })))
    const unauth = await call(userCtl.cancelAppointment, { userId: uid(5), body: { appointmentId: String(a0._id) } })
    assert.equal(unauth.message, 'Unauthorized action')
    const c0 = await call(userCtl.cancelAppointment, { userId: uid(0), body: { appointmentId: String(a0._id) } })
    assert.deepEqual([c0.success, c0.message], [true, 'Appointment Cancelled'])
    const c1 = await call(docCtl.appointmentCancel, { docId: String(doc._id), body: { appointmentId: String(a1._id) } })
    assert.deepEqual([c1.success, c1.message], [true, 'Appointment Cancelled'])
    const c2 = await call(adminCtl.appointmentCancel, { body: { appointmentId: String(a2._id) } })
    assert.deepEqual([c2.success, c2.message], [true, 'Appointment Cancelled'])
    assert.deepEqual(await slotsOf(doc._id, D), [])
    for (const a of [a0, a1, a2]) { const x = await appointmentModel.findById(a._id); assert.equal(x.cancelled, true); assert.equal(x.slotLocked, false) }
    // slot rebooked by someone else, then the old appointment is cancelled again
    assert.ok((await book(3, doc._id, D, '10:00 AM')).success)
    const again = await call(userCtl.cancelAppointment, { userId: uid(0), body: { appointmentId: String(a0._id) } })
    assert.equal(again.success, true)
    assert.deepEqual(await slotsOf(doc._id, D), ['10:00 AM'])
    // doctor complete still works
    const nb = await appointmentModel.findOne({ docId: String(doc._id), slotTime: '10:00 AM', cancelled: false })
    const done = await call(docCtl.appointmentComplete, { docId: String(doc._id), body: { appointmentId: String(nb._id) } })
    assert.equal(done.message, 'Appointment Completed')
})

await test('Cancelled pending reservation then paid: refunded, slot not taken', async () => {
    const doc = await mkDoctor(17)
    const r = await book(0, doc._id, D, '10:00 AM', 'online')
    await call(userCtl.cancelAppointment, { userId: uid(0), body: { appointmentId: String(r.appointmentId) } })
    const resp = payOrder(r.order.id)
    const v = await call(userCtl.verifyRazorpay, { userId: uid(0), body: resp })
    assert.equal(v.success, false)
    const a = await appointmentModel.findById(r.appointmentId)
    assert.equal(a.paymentStatus, 'refunded'); assert.equal(a.payment, false)
    assert.deepEqual(await slotsOf(doc._id, D), [])
})

await test('Unique index backstop rejects a second slot-holding record directly', async () => {
    const base = { userId: 'x', docId: 'zz', slotDate: D, slotTime: '10:00 AM', userData: {}, docData: {}, amount: 1, date: 1, slotLocked: true }
    await appointmentModel.create(base)
    await assert.rejects(appointmentModel.create(base), e => e.code === 11000)
    await appointmentModel.create({ ...base, slotLocked: false }) // released records are not indexed
})

await test('Doctor unavailable / bad slot input still rejected with clear message', async () => {
    const doc = await mkDoctor(18); await doctorModel.updateOne({ _id: doc._id }, { available: false })
    assert.equal((await book(0, doc._id, D, '10:00 AM')).message, 'Doctor not available')
    const doc2 = await mkDoctor(19)
    assert.equal((await book(0, doc2._id, 'a.b', '10:00 AM')).success, false)
    assert.equal((await call(userCtl.bookAppointment, { userId: uid(0), body: { docId: String(doc2._id), slotDate: D, slotTime: { $gt: '' } } })).success, false)
})

await test('Env: RESERVATION_EXPIRY_MINUTES configurable', async () => {
    process.env.RESERVATION_EXPIRY_MINUTES = '3'; assert.equal(R.getReservationMinutes(), 3)
    process.env.RESERVATION_EXPIRY_MINUTES = 'abc'; assert.equal(R.getReservationMinutes(), 10)
    delete process.env.RESERVATION_EXPIRY_MINUTES; assert.equal(R.getReservationMinutes(), 10)
})

// ======================= Review round: new tests =======================
const ago = (ms) => new Date(Date.now() - ms)
const refundsFor = (pid) => rz.refunds.filter(r => r.paymentId === pid && r.status !== 'failed').length
let docN = 100
// reservation -> expired by cron (slot released) -> slot rebooked by someone else -> payment captured
const lateRefundScenario = async () => {
    const doc = await mkDoctor(docN++)
    const r = await book(0, doc._id, D, '10:00 AM', 'online')
    await expireNow(r.appointmentId); await R.cleanupExpiredReservations()
    assert.ok((await book(1, doc._id, D, '10:00 AM')).success)
    return { doc, r, resp: payOrder(r.order.id) }
}

await test('R1. Refund API fails transiently -> refund_failed -> cron retry refunds exactly once', async () => {
    const { r, resp } = await lateRefundScenario()
    rz.failNextRefunds = 1
    const v = await call(userCtl.verifyRazorpay, { userId: uid(0), body: resp })
    assert.equal(v.success, false)
    let a = await appointmentModel.findById(r.appointmentId)
    assert.equal(a.paymentStatus, 'refund_failed'); assert.equal(refundsFor(resp.razorpay_payment_id), 0); assert.ok(a.refundLastError)
    await makeRefundsDue() // retry is scheduled with backoff
    const rec = await R.reconcileLatePayments()
    assert.equal(rec.refundsProcessed, 1)
    a = await appointmentModel.findById(r.appointmentId)
    assert.equal(a.paymentStatus, 'refunded'); assert.equal(refundsFor(resp.razorpay_payment_id), 1); assert.equal(a.payment, false)
    await makeRefundsDue()
    await R.reconcileLatePayments()
    assert.equal(refundsFor(resp.razorpay_payment_id), 1)
})

await test('R2. Refund processed at Razorpay but response lost -> retry detects it, no second refund', async () => {
    const { r, resp } = await lateRefundScenario()
    rz.crashAfterRefund = true
    await call(userCtl.verifyRazorpay, { userId: uid(0), body: resp })
    assert.equal((await appointmentModel.findById(r.appointmentId)).paymentStatus, 'refund_failed')
    assert.equal(refundsFor(resp.razorpay_payment_id), 1)
    const callsBefore = rz.refundCalls
    await makeRefundsDue()
    await R.reconcileLatePayments()
    const a = await appointmentModel.findById(r.appointmentId)
    assert.equal(a.paymentStatus, 'refunded'); assert.ok(a.refundId)
    assert.equal(rz.refundCalls, callsBefore, 'refund API must not be called again')
    assert.equal(refundsFor(resp.razorpay_payment_id), 1)
})

// Build a "crashed" state directly: refund intent recorded on the appointment and
// (optionally) the durable refund record, with a worker that died holding the lease
const crashedRefundState = async (leaseUntil, { withRecord = true, attempts = 0, status = 'pending' } = {}) => {
    const { r, resp } = await lateRefundScenario()
    await appointmentModel.updateOne({ _id: r.appointmentId }, { $set: {
        status: 'expired', paymentStatus: status === 'pending' ? 'refund_pending' : 'refund_failed', settlingPaymentId: resp.razorpay_payment_id, settlingAt: ago(10 * 60000),
        settlingAmount: 50000, razorpayPaymentId: resp.razorpay_payment_id, refundPaymentId: resp.razorpay_payment_id, refundAmount: 50000 } })
    if (withRecord) await refundModel.create({ paymentId: resp.razorpay_payment_id, appointmentId: String(r.appointmentId), amount: 50000, reason: 'late_payment', status, attempts, lockUntil: leaseUntil })
    return { r, resp }
}

await test('R3. Crash BEFORE refund API call: lease held -> skipped; lease expired -> refunded once', async () => {
    const { r, resp } = await crashedRefundState(new Date(Date.now() + 60000))
    await R.reconcileLatePayments()
    assert.equal(refundsFor(resp.razorpay_payment_id), 0, 'active lease must be respected')
    await refundModel.updateOne({ paymentId: resp.razorpay_payment_id }, { $set: { lockUntil: ago(1000) } })
    await R.reconcileLatePayments()
    assert.equal(refundsFor(resp.razorpay_payment_id), 1)
    assert.equal((await appointmentModel.findById(r.appointmentId)).paymentStatus, 'refunded')
})

await test('R3b. Crash between appointment refund intent and refund record creation -> cron creates record, refunds once', async () => {
    const { r, resp } = await crashedRefundState(null, { withRecord: false })
    await Promise.all([R.reconcileLatePayments(), R.reconcileLatePayments()])
    assert.equal(await refundModel.countDocuments({ paymentId: resp.razorpay_payment_id }), 1)
    assert.equal(refundsFor(resp.razorpay_payment_id), 1)
    assert.equal((await appointmentModel.findById(r.appointmentId)).paymentStatus, 'refunded')
})

await test('R4. Crash AFTER refund API call, before DB update: reconcile records it without refunding again', async () => {
    const { r, resp } = await crashedRefundState(ago(1000))
    await fakeClient.payments.refund(resp.razorpay_payment_id, { amount: 50000 }) // refund that happened before the crash
    const callsBefore = rz.refundCalls
    await R.reconcileLatePayments()
    const a = await appointmentModel.findById(r.appointmentId)
    assert.equal(a.paymentStatus, 'refunded'); assert.equal(rz.refundCalls, callsBefore); assert.equal(refundsFor(resp.razorpay_payment_id), 1)
})

await test('R5. Concurrent refund workers (5x processRefund + 3x cron) -> exactly one refund', async () => {
    const { r, resp } = await crashedRefundState(ago(1000))
    await Promise.all([...Array(5)].map(() => R.processRefund(r.appointmentId)).concat([R.reconcileLatePayments(), R.reconcileLatePayments(), R.reconcileLatePayments()]))
    assert.equal(refundsFor(resp.razorpay_payment_id), 1)
    assert.equal((await appointmentModel.findById(r.appointmentId)).paymentStatus, 'refunded')
})

await test('R6. After MAX_REFUND_ATTEMPTS failures -> manual_required, cron stops calling Razorpay', async () => {
    const { r, resp } = await crashedRefundState(ago(1000), { attempts: R.MAX_REFUND_ATTEMPTS - 1, status: 'failed' })
    rz.failNextRefunds = 1
    await R.reconcileLatePayments()
    const rec = await refundModel.findOne({ paymentId: resp.razorpay_payment_id })
    assert.equal(rec.status, 'manual_required'); assert.equal(rec.attempts, R.MAX_REFUND_ATTEMPTS)
    const calls = rz.refundCalls
    await R.reconcileLatePayments(); await R.reconcileLatePayments()
    assert.equal(rz.refundCalls, calls)
    assert.equal(refundsFor(resp.razorpay_payment_id), 0)
    assert.equal((await appointmentModel.findById(r.appointmentId)).paymentStatus, 'refund_failed')
})

// late payment whose settlement lock was taken by a process that then crashed
const crashedSettlement = async ({ rebook = false, claimed = false } = {}) => {
    const doc = await mkDoctor(docN++)
    const r = await book(0, doc._id, D, '10:00 AM', 'online')
    await expireNow(r.appointmentId); await R.cleanupExpiredReservations()
    if (rebook) assert.ok((await book(1, doc._id, D, '10:00 AM')).success)
    if (claimed) await doctorModel.updateOne({ _id: doc._id }, { $push: { [`slots_booked.${D}`]: '10:00 AM' } }) // crashed right after claimSlot
    const resp = payOrder(r.order.id)
    await appointmentModel.updateOne({ _id: r.appointmentId }, { $set: {
        settlingPaymentId: resp.razorpay_payment_id, settlingAt: ago(3 * 60000), settlingAmount: 50000,
        razorpayPaymentId: resp.razorpay_payment_id, ...(claimed ? { settlingSlotClaimed: true } : {}) } })
    return { doc, r, resp }
}

await test('S1. Crash after settlement lock, slot free -> cron resumes and confirms', async () => {
    const { doc, r, resp } = await crashedSettlement()
    const dup = await call(userCtl.verifyRazorpay, { userId: uid(0), body: resp }) // callback while lock held
    assert.equal(dup.success, false)
    assert.equal((await R.reconcileLatePayments()).resumed, 1)
    const a = await appointmentModel.findById(r.appointmentId)
    assert.equal(a.status, 'confirmed'); assert.equal(a.payment, true); assert.equal(a.slotLocked, true)
    assert.deepEqual(await slotsOf(doc._id, D), ['10:00 AM']); assert.equal(refundsFor(resp.razorpay_payment_id), 0)
})

await test('S2. Crash after settlement lock, slot reassigned -> cron refunds, never confirms', async () => {
    const { doc, r, resp } = await crashedSettlement({ rebook: true })
    await R.reconcileLatePayments()
    const a = await appointmentModel.findById(r.appointmentId)
    assert.equal(a.payment, false); assert.equal(a.paymentStatus, 'refunded'); assert.equal(refundsFor(resp.razorpay_payment_id), 1)
    assert.equal(await appointmentModel.countDocuments({ docId: String(doc._id), cancelled: false }), 1)
    assert.deepEqual(await slotsOf(doc._id, D), ['10:00 AM'])
})

await test('S3. Crash after re-claiming slot, before confirming -> cron confirms (no orphaned slot)', async () => {
    const { doc, r } = await crashedSettlement({ claimed: true })
    await R.reconcileLatePayments()
    const a = await appointmentModel.findById(r.appointmentId)
    assert.equal(a.status, 'confirmed'); assert.equal(a.settlingSlotClaimed, undefined)
    assert.deepEqual(await slotsOf(doc._id, D), ['10:00 AM'])
})

await test('S4. In-flight (fresh) settlement lease is not taken over by cron', async () => {
    const { r } = await crashedSettlement()
    await appointmentModel.updateOne({ _id: r.appointmentId }, { $set: { settlingAt: new Date() } })
    assert.equal((await R.reconcileLatePayments()).resumed, 0)
    assert.equal((await appointmentModel.findById(r.appointmentId)).payment, false)
})

// Invariant checker: at most one active holder; slots_booked agrees with holders
const assertSlotInvariant = async (docId, time = '10:00 AM') => {
    const holders = await appointmentModel.countDocuments({ docId: String(docId), slotDate: D, slotTime: time, cancelled: false })
    const inSlots = (await slotsOf(docId, D)).filter(t => t === time).length
    assert.ok(holders <= 1, `holders=${holders}`)
    assert.equal(inSlots, holders, `slots_booked entries (${inSlots}) != active holders (${holders})`)
}

await test('X1. Payment success vs expiry reclaim by another user (x10): never both; loser is refunded', async () => {
    for (let i = 0; i < 10; i++) {
        const doc = await mkDoctor(docN++)
        const r = await book(0, doc._id, D, '10:00 AM', 'online')
        await expireNow(r.appointmentId)
        const resp = payOrder(r.order.id)
        const [v, b] = await Promise.all([call(userCtl.verifyRazorpay, { userId: uid(0), body: resp }), book(1, doc._id, D, '10:00 AM')])
        await R.reconcileLatePayments()
        assert.ok(v.success !== b.success, `iteration ${i}: verify=${v.success} book=${b.success}`)
        if (!v.success) assert.equal(refundsFor(resp.razorpay_payment_id), 1)
        else assert.equal(refundsFor(resp.razorpay_payment_id), 0)
        await assertSlotInvariant(doc._id)
    }
})

await test('X2. Cron cleanup vs new booking (x10): no double booking, slots_booked consistent', async () => {
    for (let i = 0; i < 10; i++) {
        const doc = await mkDoctor(docN++)
        const r = await book(0, doc._id, D, '10:00 AM', 'online')
        await expireNow(r.appointmentId)
        await Promise.all([R.cleanupExpiredReservations(), book(1, doc._id, D, '10:00 AM'), R.cleanupExpiredReservations()])
        assert.equal((await appointmentModel.findById(r.appointmentId)).status, 'expired')
        await assertSlotInvariant(doc._id)
    }
})

await test('X3. Webhook vs frontend verify simultaneously (x5): confirmed once, no refund', async () => {
    for (let i = 0; i < 5; i++) {
        const doc = await mkDoctor(docN++)
        const r = await book(0, doc._id, D, '10:00 AM', 'online')
        const resp = payOrder(r.order.id)
        const raw = Buffer.from(JSON.stringify({ event: 'order.paid', payload: { payment: { entity: { id: resp.razorpay_payment_id, order_id: resp.razorpay_order_id } } } }))
        const sig = crypto.createHmac('sha256', 'wh_secret').update(raw).digest('hex')
        const res = await Promise.all([call(userCtl.verifyRazorpay, { userId: uid(0), body: resp }), call(userCtl.razorpayWebhook, { body: raw, headers: { 'x-razorpay-signature': sig } }), call(userCtl.verifyRazorpay, { userId: uid(0), body: resp })])
        assert.ok(res[0].success && res[1].status === 200 && res[2].success)
        const a = await appointmentModel.findById(r.appointmentId)
        assert.equal(a.status, 'confirmed'); assert.equal(refundsFor(resp.razorpay_payment_id), 0)
        await assertSlotInvariant(doc._id)
    }
})

await test('X4. Cancellation vs payment simultaneously (x10): exactly one wins; never cancelled-and-paid; refund at most once', async () => {
    for (let i = 0; i < 10; i++) {
        const doc = await mkDoctor(docN++)
        const r = await book(0, doc._id, D, '10:00 AM', 'online')
        const resp = payOrder(r.order.id)
        const [c] = await Promise.all([call(userCtl.cancelAppointment, { userId: uid(0), body: { appointmentId: String(r.appointmentId) } }), call(userCtl.verifyRazorpay, { userId: uid(0), body: resp })])
        const a = await appointmentModel.findById(r.appointmentId)
        assert.ok(!(a.cancelled && a.payment), 'a paid appointment is never cancelled')
        assert.ok(refundsFor(resp.razorpay_payment_id) <= 1)
        if (a.payment) {
            // payment confirmed first: the cancellation was refused, booking and slot intact
            assert.equal(c.success, false); assert.equal(c.message, R.PAID_CANCELLATION_MESSAGE)
            assert.equal(a.cancelled, false); assert.equal(a.status, 'confirmed'); assert.equal(a.slotLocked, true)
            assert.equal(refundsFor(resp.razorpay_payment_id), 0)
        } else {
            // cancelled while still unpaid: the payment that arrived afterwards is refunded (late-payment path)
            assert.equal(c.success, true); assert.equal(a.cancelled, true); assert.equal(a.paymentStatus, 'refunded')
        }
        await assertSlotInvariant(doc._id)
    }
})

await test('X5. Simultaneous reclaims of an expired slot, mixed request styles (x10): exactly one wins', async () => {
    for (let i = 0; i < 10; i++) {
        const doc = await mkDoctor(docN++)
        const r = await book(0, doc._id, D, '10:00 AM', 'online')
        await expireNow(r.appointmentId)
        const rs = await Promise.all([1, 2, 3, 4, 5, 6].map(u => book(u, doc._id, D, '10:00 AM', u % 2 ? 'online' : undefined)))
        assert.equal(rs.filter(x => x.success).length, 1)
        await assertSlotInvariant(doc._id)
    }
})

await test('D1. Duplicate reconciliation script: dry run writes nothing; apply keeps one, never releases the slot', async () => {
    const { spawnSync } = await import('child_process')
    const prod = mongoose.connection.client.db(MIGRATION_DB)
    const docId = new mongoose.Types.ObjectId()
    await prod.collection('doctors').insertOne({ _id: docId, slots_booked: { '21_11_2026': ['10:00 AM', '10:30 AM'], '8_4_2026': [] } })
    const base = { docId: String(docId), userData: {}, docData: {}, amount: 1, cancelled: false, isCompleted: false }
    await prod.collection('appointments').insertMany([
        { ...base, userId: 'hello', slotDate: '21_11_2026', slotTime: '10:30 AM', date: 1000, payment: false },
        { ...base, userId: 'ronaldo', slotDate: '21_11_2026', slotTime: '10:30 AM', date: 1095, payment: false },
        { ...base, userId: 'k', slotDate: '8_4_2026', slotTime: '01:30 PM', date: 1, payment: false },
        { ...base, userId: 'k', slotDate: '8_4_2026', slotTime: '01:30 PM', date: 2, payment: false },
        { ...base, userId: 'k', slotDate: '8_4_2026', slotTime: '01:30 PM', date: 3, payment: false },
        { ...base, userId: 'p', slotDate: '9_4_2026', slotTime: '05:00 PM', date: 1, payment: false },
        { ...base, userId: 'p2', slotDate: '9_4_2026', slotTime: '05:00 PM', date: 2, payment: true }
    ])
    const snapshot = async () => JSON.stringify([await prod.collection('appointments').find().sort({ _id: 1 }).toArray(), await prod.collection('doctors').find().toArray()])
    const before = await snapshot()
    const runScript = (...args) => spawnSync(process.execPath, [`${BACKEND}/scripts/reconcileDuplicateSlots.js`, ...args],
        { cwd: SANDBOX_CWD, env: { ...process.env, MONGODB_URI: mongod.getUri(), MONGODB_DB_NAME: MIGRATION_DB }, encoding: 'utf8' })
    const dry = runScript('--lock-legacy')
    assert.equal(dry.status, 0, dry.stderr)
    assert.equal(await snapshot(), before, 'dry run must not write')
    const apply = runScript('--apply', '--lock-legacy')
    assert.equal(apply.status, 0, apply.stderr)
    const A = prod.collection('appointments')
    const active = async (d, t) => A.find({ slotDate: d, slotTime: t, cancelled: false }).toArray()
    const nov = await active('21_11_2026', '10:30 AM'); assert.equal(nov.length, 1); assert.equal(nov[0].userId, 'hello'); assert.equal(nov[0].slotLocked, true)
    const red = await A.findOne({ userId: 'ronaldo' }); assert.equal(red.cancelled, true); assert.ok(red.duplicateOf.equals(nov[0]._id))
    assert.equal((await active('8_4_2026', '01:30 PM')).length, 1)
    const apr9 = await active('9_4_2026', '05:00 PM'); assert.equal(apr9.length, 1); assert.equal(apr9[0].payment, true) // paid one kept
    const d = await prod.collection('doctors').findOne({ _id: docId })
    assert.deepEqual(d.slots_booked['21_11_2026'], ['10:00 AM', '10:30 AM'])   // slot NOT released
    assert.deepEqual(d.slots_booked['8_4_2026'], ['01:30 PM'])                 // missing slot re-added
    assert.deepEqual(d.slots_booked['9_4_2026'], ['05:00 PM'])
    assert.equal(await A.countDocuments({}), 7)                                  // nothing deleted
    const again = runScript('--apply', '--lock-legacy'); assert.equal(again.status, 0)  // idempotent
    assert.equal(await A.countDocuments({ cancelled: false }), 3)
})

// ======================= Final review round: new tests =======================

await test('F1. Razorpay refund pending -> stays refund_pending (no new refund) -> processed later -> refunded', async () => {
    const { r, resp } = await lateRefundScenario()
    rz.nextRefundStatus = 'pending'
    const v = await call(userCtl.verifyRazorpay, { userId: uid(0), body: resp })
    rz.nextRefundStatus = undefined
    assert.equal(v.success, false); assert.match(v.message, /being processed/)
    let a = await appointmentModel.findById(r.appointmentId)
    let rec = await refundModel.findOne({ paymentId: resp.razorpay_payment_id })
    assert.equal(a.paymentStatus, 'refund_pending'); assert.equal(rec.status, 'pending')
    assert.ok(rec.refundId); assert.equal(rec.refundStatus, 'pending'); assert.equal(a.refundId, rec.refundId); assert.equal(a.refundStatus, 'pending')
    const calls = rz.refundCalls
    await R.reconcileLatePayments(); await R.reconcileLatePayments()
    assert.equal(rz.refundCalls, calls, 'pending refund must not be re-requested')
    assert.equal((await appointmentModel.findById(r.appointmentId)).paymentStatus, 'refund_pending')
    // Razorpay finishes the refund; a refund.processed webhook triggers a re-sync (status re-read from Razorpay)
    rz.refunds.find(x => x.id === rec.refundId).status = 'processed'
    const raw = Buffer.from(JSON.stringify({ event: 'refund.processed', payload: { refund: { entity: { id: rec.refundId, payment_id: resp.razorpay_payment_id } } } }))
    const sig = crypto.createHmac('sha256', 'wh_secret').update(raw).digest('hex')
    assert.equal((await call(userCtl.razorpayWebhook, { body: raw, headers: { 'x-razorpay-signature': sig } })).status, 200)
    a = await appointmentModel.findById(r.appointmentId); rec = await refundModel.findOne({ paymentId: resp.razorpay_payment_id })
    assert.equal(rec.status, 'processed'); assert.equal(rec.refundStatus, 'processed'); assert.equal(a.paymentStatus, 'refunded')
    assert.equal(refundsFor(resp.razorpay_payment_id), 1); assert.equal(rz.refundCalls, calls)
})

await test('F2. Razorpay refund later FAILS -> next reconcile issues one replacement refund, then processed', async () => {
    const { r, resp } = await lateRefundScenario()
    rz.nextRefundStatus = 'pending'
    await call(userCtl.verifyRazorpay, { userId: uid(0), body: resp })
    rz.nextRefundStatus = undefined
    const first = await refundModel.findOne({ paymentId: resp.razorpay_payment_id })
    rz.refunds.find(x => x.id === first.refundId).status = 'failed'      // Razorpay reports failure
    await makeRefundsDue()
    await R.reconcileLatePayments()
    const rec = await refundModel.findOne({ paymentId: resp.razorpay_payment_id })
    assert.notEqual(rec.refundId, first.refundId); assert.equal(rec.status, 'processed')
    assert.equal(refundsFor(resp.razorpay_payment_id), 1, 'exactly one live refund')
    await makeRefundsDue()
    await R.reconcileLatePayments()
    assert.equal(refundsFor(resp.razorpay_payment_id), 1)
    assert.equal((await appointmentModel.findById(r.appointmentId)).paymentStatus, 'refunded')
})

await test('F3. Refund API error then success on retry (record + appointment states)', async () => {
    const { r, resp } = await lateRefundScenario()
    rz.failNextRefunds = 2
    await call(userCtl.verifyRazorpay, { userId: uid(0), body: resp })
    let rec = await refundModel.findOne({ paymentId: resp.razorpay_payment_id })
    assert.equal(rec.status, 'failed'); assert.equal(rec.attempts, 1); assert.ok(rec.lastError)
    await makeRefundsDue()
    await R.reconcileLatePayments()
    rec = await refundModel.findOne({ paymentId: resp.razorpay_payment_id })
    assert.equal(rec.status, 'failed'); assert.equal(rec.attempts, 2)
    await makeRefundsDue()
    await R.reconcileLatePayments()
    rec = await refundModel.findOne({ paymentId: resp.razorpay_payment_id })
    assert.equal(rec.status, 'processed'); assert.equal(refundsFor(resp.razorpay_payment_id), 1)
    assert.equal((await appointmentModel.findById(r.appointmentId)).paymentStatus, 'refunded')
})

await test('F4. Second payment on a confirmed appointment: refund fails, cron recovers; duplicates never double-refund', async () => {
    const doc = await mkDoctor(docN++)
    const r = await book(0, doc._id, D, '10:00 AM', 'online')
    const first = payOrder(r.order.id)
    assert.ok((await call(userCtl.verifyRazorpay, { userId: uid(0), body: first })).success)
    const order2 = await fakeClient.orders.create({ amount: 50000, currency: 'INR', receipt: String(r.appointmentId) })
    const second = payOrder(order2.id)
    rz.failNextRefunds = 1
    const v = await call(userCtl.verifyRazorpay, { userId: uid(0), body: second })
    assert.ok(v.success) // appointment is (still) paid
    let rec = await refundModel.findOne({ paymentId: second.razorpay_payment_id })
    assert.equal(rec.reason, 'duplicate_payment'); assert.equal(rec.status, 'failed'); assert.equal(refundsFor(second.razorpay_payment_id), 0)
    await makeRefundsDue()
    await R.reconcileLatePayments()
    rec = await refundModel.findOne({ paymentId: second.razorpay_payment_id })
    assert.equal(rec.status, 'processed'); assert.equal(refundsFor(second.razorpay_payment_id), 1)
    // duplicate callbacks / webhook for the second payment
    const raw = Buffer.from(JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: second.razorpay_payment_id, order_id: order2.id } } } }))
    const sig = crypto.createHmac('sha256', 'wh_secret').update(raw).digest('hex')
    await Promise.all([call(userCtl.verifyRazorpay, { userId: uid(0), body: second }), call(userCtl.razorpayWebhook, { body: raw, headers: { 'x-razorpay-signature': sig } }), R.reconcileLatePayments()])
    assert.equal(refundsFor(second.razorpay_payment_id), 1)
    assert.equal(await refundModel.countDocuments({ paymentId: second.razorpay_payment_id }), 1)
    assert.equal(refundsFor(first.razorpay_payment_id), 0, 'the real payment is never refunded')
    const a = await appointmentModel.findById(r.appointmentId)
    assert.equal(a.status, 'confirmed'); assert.equal(a.paymentStatus, 'paid'); assert.equal(a.razorpayPaymentId, first.razorpay_payment_id)
})

await test('F5. Second payment refund intent recorded but process crashed before Razorpay call -> cron refunds once', async () => {
    const doc = await mkDoctor(docN++)
    const r = await book(0, doc._id, D, '10:00 AM', 'online')
    assert.ok((await call(userCtl.verifyRazorpay, { userId: uid(0), body: payOrder(r.order.id) })).success)
    const order2 = await fakeClient.orders.create({ amount: 50000, currency: 'INR', receipt: String(r.appointmentId) })
    const second = payOrder(order2.id)
    await R.ensureRefundIntent({ paymentId: second.razorpay_payment_id, appointmentId: r.appointmentId, amount: 50000, reason: 'duplicate_payment' })
    await refundModel.updateOne({ paymentId: second.razorpay_payment_id }, { $set: { lockUntil: ago(1000) } }) // dead worker's lease
    await Promise.all([R.reconcileLatePayments(), R.reconcileLatePayments()])
    assert.equal(refundsFor(second.razorpay_payment_id), 1)
    assert.equal((await refundModel.findOne({ paymentId: second.razorpay_payment_id })).status, 'processed')
})

// ---- slot consistency repair (crash between appointment write and slots_booked write) ----
await test('C1. Orphan slot (crash after cancel flip, before $pull): released only on a second sighting', async () => {
    const doc = await mkDoctor(docN++)
    await book(0, doc._id, D, '10:00 AM')
    const a = await appointmentModel.findOne({ docId: String(doc._id) })
    await appointmentModel.updateOne({ _id: a._id }, { $set: { cancelled: true, slotLocked: false, status: 'cancelled' } }) // crash: no pull
    await R.repairSlotConsistency({ graceMs: 0 })
    assert.deepEqual(await slotsOf(doc._id, D), ['10:00 AM'], 'first sighting must not release')
    await R.repairSlotConsistency({ graceMs: 0 })
    assert.deepEqual(await slotsOf(doc._id, D), [])
    assert.ok((await book(1, doc._id, D, '10:00 AM')).success)
})

await test('C2. Slot pushed by an in-progress booking is not released once the booking completes', async () => {
    const doc = await mkDoctor(docN++)
    await doctorModel.updateOne({ _id: doc._id }, { $push: { [`slots_booked.${D}`]: '10:00 AM' } }) // booking pushed, insert pending
    await R.repairSlotConsistency({ graceMs: 0 })
    await appointmentModel.create({ userId: uid(0), docId: String(doc._id), slotDate: D, slotTime: '10:00 AM', userData: {}, docData: {}, amount: 1, date: Date.now(), slotLocked: true, status: 'confirmed' })
    await R.repairSlotConsistency({ graceMs: 0 })
    await R.repairSlotConsistency({ graceMs: 0 })
    assert.deepEqual(await slotsOf(doc._id, D), ['10:00 AM'])
})

await test('C3. Missing entry (active holder, slot absent) is re-added; active slots are never released', async () => {
    const doc = await mkDoctor(docN++)
    await book(0, doc._id, D, '10:00 AM'); await book(1, doc._id, D, '11:00 AM')
    await doctorModel.updateOne({ _id: doc._id }, { $pull: { [`slots_booked.${D}`]: '10:00 AM' } })
    const res = await R.repairSlotConsistency({ graceMs: 0 })
    assert.ok(res.added >= 1)
    for (let i = 0; i < 3; i++) await R.repairSlotConsistency({ graceMs: 0 })
    assert.deepEqual((await slotsOf(doc._id, D)).sort(), ['10:00 AM', '11:00 AM'])
    assert.equal((await book(2, doc._id, D, '10:00 AM')).success, false)
})

// ---- migration script ----
const { spawnSync } = await import('child_process')
const prodDb = () => mongoose.connection.client.db(MIGRATION_DB)
const runMigration = (...args) => spawnSync(process.execPath, [`${BACKEND}/scripts/reconcileDuplicateSlots.js`, ...args],
    { cwd: SANDBOX_CWD, env: { ...process.env, MONGODB_URI: mongod.getUri(), MONGODB_DB_NAME: MIGRATION_DB }, encoding: 'utf8' })
const snapshotProd = async () => JSON.stringify([await prodDb().collection('appointments').find().sort({ _id: 1 }).toArray(), await prodDb().collection('doctors').find().sort({ _id: 1 }).toArray()])
const seedAppt = (o) => ({ userData: {}, docData: {}, amount: 1, cancelled: false, isCompleted: false, payment: false, date: 1, ...o })

await test('M1. Crash between slotLocked update and slots_booked repair -> re-running the migration repairs it', async () => {
    await prodDb().dropDatabase()
    const docId = new mongoose.Types.ObjectId()
    await prodDb().collection('doctors').insertOne({ _id: docId, slots_booked: { '25_11_2026': [] } })
    // state left by an interrupted run: already locked, slot entry never written
    await prodDb().collection('appointments').insertOne(seedAppt({ docId: String(docId), userId: 'a', slotDate: '25_11_2026', slotTime: '10:00 AM', slotLocked: true }))
    const dry = runMigration('--lock-legacy')
    assert.equal(dry.status, 0, dry.stdout + dry.stderr); assert.match(dry.stdout, /ADD\s+\S+ 25_11_2026 10:00 AM .*slotLocked=true/)
    const res = runMigration('--apply', '--lock-legacy')
    assert.equal(res.status, 0, res.stdout + res.stderr)
    assert.deepEqual((await prodDb().collection('doctors').findOne({ _id: docId })).slots_booked['25_11_2026'], ['10:00 AM'])
})

await test('M2. Re-running the migration does not alter already-correct records', async () => {
    await prodDb().dropDatabase()
    const docId = new mongoose.Types.ObjectId()
    await prodDb().collection('doctors').insertOne({ _id: docId, slots_booked: { '25_11_2026': ['10:00 AM'] } })
    await prodDb().collection('appointments').insertMany([
        seedAppt({ docId: String(docId), userId: 'a', slotDate: '25_11_2026', slotTime: '10:00 AM', date: 1 }),
        seedAppt({ docId: String(docId), userId: 'b', slotDate: '25_11_2026', slotTime: '10:00 AM', date: 2 }),
        seedAppt({ docId: String(docId), userId: 'c', slotDate: '25_11_2026', slotTime: '11:00 AM' })
    ])
    assert.equal(runMigration('--apply', '--lock-legacy').status, 0)
    const after = await snapshotProd()
    const second = runMigration('--apply', '--lock-legacy')
    assert.equal(second.status, 0, second.stdout)
    assert.equal(await snapshotProd(), after, 'second run must not modify anything')
    assert.match(second.stdout, /Active duplicate groups: 0/)
})

await test('M3. Paid duplicates are reported as UNRESOLVED and never cancelled automatically', async () => {
    await prodDb().dropDatabase()
    const docId = new mongoose.Types.ObjectId()
    await prodDb().collection('doctors').insertOne({ _id: docId, slots_booked: { '25_11_2026': ['10:00 AM'] } })
    await prodDb().collection('appointments').insertMany([
        seedAppt({ docId: String(docId), userId: 'a', slotDate: '25_11_2026', slotTime: '10:00 AM', payment: true, date: 1 }),
        seedAppt({ docId: String(docId), userId: 'b', slotDate: '25_11_2026', slotTime: '10:00 AM', payment: true, date: 2 }),
        seedAppt({ docId: String(docId), userId: 'c', slotDate: '25_11_2026', slotTime: '10:00 AM', date: 3 })
    ])
    const before = await snapshotProd()
    const res = runMigration('--apply', '--lock-legacy')
    assert.equal(res.status, 2, 'exit code 2 = manual action required')
    assert.match(res.stdout, /UNRESOLVED/); assert.match(res.stdout, /Unresolved duplicate groups \(manual action required\): 1/)
    assert.equal(await prodDb().collection('appointments').countDocuments({ cancelled: false }), 3)
    assert.equal(await prodDb().collection('appointments').countDocuments({ slotLocked: true }), 0, 'unresolved slot must not be locked')
    assert.equal(await snapshotProd(), before)
})

await test('M4. Partial failure is reported (exit 1) and a re-run completes the remaining work', async () => {
    await prodDb().dropDatabase()
    const docId = new mongoose.Types.ObjectId()
    await prodDb().collection('doctors').insertOne({ _id: docId, slots_booked: {} })
    await prodDb().collection('appointments').insertMany([
        seedAppt({ docId: String(docId), userId: 'a', slotDate: '25_11_2026', slotTime: '10:00 AM' }),
        seedAppt({ docId: String(new mongoose.Types.ObjectId()), userId: 'x', slotDate: '25_11_2026', slotTime: '11:00 AM' }) // doctor missing
    ])
    const res = runMigration('--apply')
    assert.equal(res.status, 1); assert.match(res.stdout, /not found/)
    assert.deepEqual((await prodDb().collection('doctors').findOne({ _id: docId })).slots_booked['25_11_2026'], ['10:00 AM'])
    const again = runMigration('--apply')
    assert.equal(again.status, 1) // still reports the unfixable record, changes nothing else
    assert.deepEqual((await prodDb().collection('doctors').findOne({ _id: docId })).slots_booked['25_11_2026'], ['10:00 AM'])
})

// ======================= Audit fixes: new tests =======================
const IDX = await imp('config/indexes.js')
const fs = await import('fs')
const path = await import('path')
const http = await import('http')
const istSlotDate = (date) => { const n = R.istDayNumber(date); return `${n % 100}_${Math.floor(n / 100) % 100}_${Math.floor(n / 10000)}` }
const DAY = 24 * 60 * 60 * 1000
// earlier tests leave many recent online bookings; make only the target due for the sweep
const focusSweep = async (id) => {
    await appointmentModel.updateMany({ _id: { $ne: id } }, { $set: { nextOrderCheckAt: new Date(Date.now() + 365 * DAY) } })
    await appointmentModel.updateOne({ _id: id }, { $unset: { nextOrderCheckAt: 1, orderCheckCount: 1 } })
}

await test('I1. Index verification fails when the unique slot index is missing; ensure recreates it', async () => {
    await IDX.verifyRequiredIndexes()
    await appointmentModel.collection.dropIndex('unique_active_slot')
    await assert.rejects(IDX.verifyRequiredIndexes(), /missing index \{"docId":1,"slotDate":1,"slotTime":1\}/)
    await IDX.ensureRequiredIndexes()
    const u = (await appointmentModel.collection.indexes()).find(i => i.name === 'unique_active_slot')
    assert.ok(u.unique); assert.deepEqual(u.partialFilterExpression, { slotLocked: true })
})

await test('I2. Startup index creation fails clearly on a conflicting (non-unique) refund index', async () => {
    await refundModel.collection.dropIndex('paymentId_1')
    await refundModel.collection.createIndex({ paymentId: 1 }, { name: 'paymentId_1' }) // NOT unique
    await assert.rejects(IDX.ensureRequiredIndexes(), /Creating indexes for collection "refunds" failed|must be unique/)
    await refundModel.collection.dropIndex('paymentId_1')
    await IDX.ensureRequiredIndexes()
    assert.ok((await refundModel.collection.indexes()).find(i => i.name === 'paymentId_1').unique)
})

await test('T1. Late payment found by order reconciliation without webhook or verify: slot free -> confirmed', async () => {
    const doc = await mkDoctor(docN++)
    const r = await book(0, doc._id, D, '10:00 AM', 'online')
    await expireNow(r.appointmentId); await R.cleanupExpiredReservations()
    payOrder(r.order.id) // captured at Razorpay, browser never returned, no webhook
    await focusSweep(r.appointmentId)
    const calls = rz.ordersAllCalls
    const res = await R.reconcileRecentOnlineOrders()
    assert.ok(res.checked >= 1 && res.settled >= 1)
    const a = await appointmentModel.findById(r.appointmentId)
    assert.equal(a.status, 'confirmed'); assert.equal(a.payment, true)
    assert.deepEqual(await slotsOf(doc._id, D), ['10:00 AM'])
    const callsAfter = rz.ordersAllCalls
    await R.reconcileRecentOnlineOrders() // backoff: not re-checked immediately
    assert.equal(rz.ordersAllCalls, callsAfter); assert.ok(callsAfter > calls)
})

await test('T2. Crash BEFORE refund intent (nothing recorded), slot rebooked -> reconciliation refunds once, idempotent', async () => {
    const doc = await mkDoctor(docN++)
    const r = await book(0, doc._id, D, '10:00 AM', 'online')
    await expireNow(r.appointmentId); await R.cleanupExpiredReservations()
    assert.ok((await book(1, doc._id, D, '10:00 AM')).success)
    const resp = payOrder(r.order.id)
    await focusSweep(r.appointmentId)
    await R.reconcileRecentOnlineOrders()
    let a = await appointmentModel.findById(r.appointmentId)
    assert.equal(a.payment, false); assert.equal(a.paymentStatus, 'refunded'); assert.equal(refundsFor(resp.razorpay_payment_id), 1)
    await appointmentModel.updateOne({ _id: r.appointmentId }, { $set: { nextOrderCheckAt: ago(1000) } })
    await Promise.all([R.reconcileRecentOnlineOrders(), R.reconcileLatePayments(), call(userCtl.verifyRazorpay, { userId: uid(0), body: resp })])
    assert.equal(refundsFor(resp.razorpay_payment_id), 1)
    assert.equal(await appointmentModel.countDocuments({ docId: String(doc._id), cancelled: false }), 1)
})

await test('T3. Crash AFTER refund intent (appointment intent, no refund record) with sweep + cron racing -> one refund', async () => {
    const { r, resp } = await crashedRefundState(null, { withRecord: false })
    await appointmentModel.updateOne({ _id: r.appointmentId }, { $unset: { refundRecordedAt: 1 } })
    await Promise.all([R.reconcileLatePayments(), R.reconcileRecentOnlineOrders(), R.reconcileLatePayments()])
    assert.equal(refundsFor(resp.razorpay_payment_id), 1)
    assert.equal(await refundModel.countDocuments({ paymentId: resp.razorpay_payment_id }), 1)
    assert.equal((await appointmentModel.findById(r.appointmentId)).paymentStatus, 'refunded')
})

await test('T4. Duplicate payment on a confirmed booking found by reconciliation (no webhook) -> refunded once', async () => {
    const doc = await mkDoctor(docN++)
    const r = await book(0, doc._id, D, '10:00 AM', 'online')
    const first = payOrder(r.order.id)
    assert.ok((await call(userCtl.verifyRazorpay, { userId: uid(0), body: first })).success)
    const order2 = await fakeClient.orders.create({ amount: 50000, currency: 'INR', receipt: String(r.appointmentId) })
    const second = payOrder(order2.id)
    await focusSweep(r.appointmentId)
    await R.reconcileRecentOnlineOrders()
    assert.equal(refundsFor(second.razorpay_payment_id), 1); assert.equal(refundsFor(first.razorpay_payment_id), 0)
    await appointmentModel.updateOne({ _id: r.appointmentId }, { $set: { nextOrderCheckAt: ago(1000) } })
    await R.reconcileRecentOnlineOrders()
    assert.equal(refundsFor(second.razorpay_payment_id), 1)
    assert.equal((await appointmentModel.findById(r.appointmentId)).status, 'confirmed')
})

await test('T5. Reconciliation is bounded: reservations older than the lookback window are not queried', async () => {
    const doc = await mkDoctor(docN++)
    const r = await book(0, doc._id, D, '10:00 AM', 'online')
    await expireNow(r.appointmentId); await R.cleanupExpiredReservations()
    await appointmentModel.updateOne({ _id: r.appointmentId }, { $set: { reservedAt: new Date(Date.now() - 49 * 60 * 60 * 1000) }, $unset: { nextOrderCheckAt: 1 } })
    payOrder(r.order.id)
    await focusSweep(r.appointmentId)
    await appointmentModel.updateOne({ _id: r.appointmentId }, { $set: { reservedAt: new Date(Date.now() - 49 * 60 * 60 * 1000) } })
    const calls = rz.ordersAllCalls
    await R.reconcileRecentOnlineOrders()
    assert.equal(rz.ordersAllCalls, calls)
    assert.equal((await appointmentModel.findById(r.appointmentId)).status, 'expired')
})

// legacy (no slotLocked) active duplicates on one slot, as in production
const legacyPair = async () => {
    const doc = await mkDoctor(docN++)
    await doctorModel.updateOne({ _id: doc._id }, { $set: { [`slots_booked.${D}`]: ['10:00 AM'] } })
    const base = { docId: String(doc._id), slotDate: D, slotTime: '10:00 AM', userData: {}, docData: {}, amount: 500, date: Date.now(), cancelled: false, payment: false, isCompleted: false }
    const ids = Object.values((await appointmentModel.collection.insertMany([{ ...base, userId: uid(0) }, { ...base, userId: uid(1) }])).insertedIds)
    return { doc, ids }
}

await test('L1. Cancelling one of two active (legacy) holders keeps the slot; cancelling the last releases it', async () => {
    const { doc, ids } = await legacyPair()
    const c1 = await call(userCtl.cancelAppointment, { userId: uid(0), body: { appointmentId: String(ids[0]) } })
    assert.deepEqual([c1.success, c1.message], [true, 'Appointment Cancelled'])
    assert.deepEqual(await slotsOf(doc._id, D), ['10:00 AM'], 'slot still held by the other appointment')
    assert.equal((await book(2, doc._id, D, '10:00 AM')).success, false)
    const c2 = await call(docCtl.appointmentCancel, { docId: String(doc._id), body: { appointmentId: String(ids[1]) } })
    assert.equal(c2.success, true)
    assert.deepEqual(await slotsOf(doc._id, D), [])
    assert.ok((await book(2, doc._id, D, '10:00 AM')).success)
})

await test('L2. Concurrent cancellations and bookings (x10, with legacy duplicates): never double-booked, never stuck', async () => {
    for (let i = 0; i < 10; i++) {
        const { doc, ids } = await legacyPair()
        await Promise.all([
            call(userCtl.cancelAppointment, { userId: uid(0), body: { appointmentId: String(ids[0]) } }),
            call(adminCtl.appointmentCancel, { body: { appointmentId: String(ids[1]) } }),
            book(2, doc._id, D, '10:00 AM'), book(3, doc._id, D, '10:00 AM')
        ])
        await assertSlotInvariant(doc._id) // <=1 active holder and slots_booked agrees
        if (await appointmentModel.countDocuments({ docId: String(doc._id), cancelled: false }) === 0) {
            assert.ok((await book(4, doc._id, D, '10:00 AM')).success, 'slot must not be left blocked')
        }
    }
})

await test('L3. Concurrent cancel of a booking and new bookings (x10): exactly consistent', async () => {
    for (let i = 0; i < 10; i++) {
        const doc = await mkDoctor(docN++)
        await book(0, doc._id, D, '10:00 AM')
        const a = await appointmentModel.findOne({ docId: String(doc._id) })
        await Promise.all([call(userCtl.cancelAppointment, { userId: uid(0), body: { appointmentId: String(a._id) } }), book(1, doc._id, D, '10:00 AM'), book(2, doc._id, D, '10:00 AM', 'online')])
        await assertSlotInvariant(doc._id)
    }
})

await test('P1. Razorpay timeout AFTER the refund was created: no blind retry, recorded as processed', async () => {
    const { r, resp } = await lateRefundScenario()
    rz.timeoutAfterRefund = true
    await call(userCtl.verifyRazorpay, { userId: uid(0), body: resp })
    let rec = await refundModel.findOne({ paymentId: resp.razorpay_payment_id })
    assert.equal(rec.status, 'failed'); assert.match(rec.lastError, /Uncertain outcome/)
    assert.ok(rec.nextAttemptAt > new Date(), 'retry is scheduled, not immediate')
    assert.equal(refundsFor(resp.razorpay_payment_id), 1)
    const calls = rz.refundCalls
    await R.reconcileLatePayments()
    assert.equal(rz.refundCalls, calls, 'not retried before it is due')
    await makeRefundsDue(); await R.reconcileLatePayments()
    rec = await refundModel.findOne({ paymentId: resp.razorpay_payment_id })
    assert.equal(rec.status, 'processed'); assert.equal(rz.refundCalls, calls, 'existing refund found, none created')
    assert.equal(refundsFor(resp.razorpay_payment_id), 1)
    assert.equal((await appointmentModel.findById(r.appointmentId)).paymentStatus, 'refunded')
})

await test('P2. Real SDK client: bounded timeout configured below the refund lease; a hung request becomes an uncertain error', async () => {
    process.env.RAZORPAY_TIMEOUT_MS = '10000000'
    assert.equal(R.getRazorpayTimeoutMs(), R.REFUND_LEASE_MS / 4)
    process.env.RAZORPAY_TIMEOUT_MS = '300'
    const client = R.createRazorpayClient()
    assert.equal(client.api.rq.defaults.timeout, 300)
    let hits = 0
    const server = http.createServer(() => { hits++ /* never respond */ })
    await new Promise(res => server.listen(0, '127.0.0.1', res))
    client.api.rq.defaults.baseURL = `http://127.0.0.1:${server.address().port}`
    const started = Date.now()
    let caught
    try { await client.payments.refund('pay_timeout_test', { amount: 100 }) } catch (e) { caught = e }
    server.closeAllConnections?.(); server.close()
    delete process.env.RAZORPAY_TIMEOUT_MS
    assert.ok(caught, 'request must fail'); assert.ok(Date.now() - started < 5000, 'must time out quickly')
    assert.equal(hits, 1, 'request reached the server (outcome unknown to the client)')
    assert.ok(caught instanceof TypeError, `SDK surfaces timeouts as TypeError, got ${caught?.constructor?.name}`)
    assert.equal(R.isUncertainError(caught), true)
    assert.equal(R.isUncertainError({ statusCode: 400, error: { code: 'BAD_REQUEST_ERROR' } }), false)
})

await test('Q1. >50 due refund records processed in one run; manual_required and Razorpay-pending never block or re-poll', async () => {
    const origList = fakeClient.payments.fetchMultipleRefund
    fakeClient.payments.fetchMultipleRefund = async (...a) => { rz.listCalls = (rz.listCalls || 0) + 1; return origList(...a) }
    const mk = (n, extra) => Array.from({ length: n }, (_, i) => {
        const pid = `pay_bulk_${extra.tag}_${i}`
        rz.payments.set(pid, { id: pid, order_id: 'order_bulk', status: 'captured', amount: 1000, currency: 'INR', amount_refunded: 0 })
        return { paymentId: pid, appointmentId: 'bulk', amount: 1000, reason: 'duplicate_payment', status: extra.status, attempts: extra.attempts || 0 }
    })
    await refundModel.insertMany([...mk(60, { tag: 'manual', status: 'manual_required', attempts: 10 }), ...mk(70, { tag: 'due', status: 'pending' })])
    const calls0 = rz.refundCalls
    await R.reconcileLatePayments()
    assert.equal(await refundModel.countDocuments({ paymentId: /^pay_bulk_due_/, status: 'processed' }), 70)
    assert.equal(await refundModel.countDocuments({ paymentId: /^pay_bulk_manual_/, status: 'manual_required' }), 60)
    assert.equal(rz.refundCalls - calls0, 70)
    // Razorpay-pending refunds are re-checked on a backoff, not every minute
    rz.nextRefundStatus = 'pending'
    await refundModel.insertMany(mk(55, { tag: 'rzpending', status: 'pending' }))
    await R.reconcileLatePayments()
    rz.nextRefundStatus = undefined
    assert.equal(await refundModel.countDocuments({ paymentId: /^pay_bulk_rzpending_/, status: 'pending', nextAttemptAt: { $gt: new Date() } }), 55)
    const lists = rz.listCalls
    await R.reconcileLatePayments(); await R.reconcileLatePayments()
    assert.equal(rz.listCalls, lists, 'no Razorpay polling before the next scheduled check')
    fakeClient.payments.fetchMultipleRefund = origList
})

await test('Q2. Missing payment id: resolved from the Razorpay order when possible; otherwise flagged once for manual action', async () => {
    const { r, resp } = await lateRefundScenario()
    await appointmentModel.updateOne({ _id: r.appointmentId }, { $set: { status: 'expired', paymentStatus: 'refund_pending', razorpayOrderId: r.order.id }, $unset: { refundPaymentId: 1, refundAmount: 1, refundRecordedAt: 1 } })
    await R.reconcileLatePayments()
    let a = await appointmentModel.findById(r.appointmentId)
    assert.equal(a.refundPaymentId, resp.razorpay_payment_id); assert.equal(a.refundAmount, 50000); assert.equal(a.paymentStatus, 'refunded')
    assert.equal(refundsFor(resp.razorpay_payment_id), 1)
    // no order / no payment anywhere -> manual_required once, then no further work
    const doc = await mkDoctor(docN++)
    const x = await appointmentModel.create({ userId: uid(0), docId: String(doc._id), slotDate: D, slotTime: '05:00 PM', userData: {}, docData: {}, amount: 500, date: Date.now(), cancelled: true, payment: false, paymentMethod: 'online', status: 'expired', paymentStatus: 'refund_pending' })
    await R.reconcileLatePayments()
    a = await appointmentModel.findById(x._id)
    assert.equal(a.refundStatus, 'manual_required'); assert.equal(a.paymentStatus, 'refund_failed'); assert.ok(a.refundRecordedAt)
    const flaggedAt = a.refundRecordedAt.getTime()
    await R.reconcileLatePayments()
    assert.equal((await appointmentModel.findById(x._id)).refundRecordedAt.getTime(), flaggedAt)
})

await test('Z1. IST date boundaries: day number and repair scope use Asia/Kolkata, not server UTC', async () => {
    assert.equal(R.istDayNumber(new Date('2026-11-18T18:29:59Z')), 20261118)  // 23:59:59 IST
    assert.equal(R.istDayNumber(new Date('2026-11-18T18:30:00Z')), 20261119)  // 00:00 IST next day, UTC still 18th
    const now = new Date('2026-11-18T19:00:00Z')                               // IST 19 Nov 00:30, UTC 18 Nov
    assert.equal(R.isInRepairScope('19_11_2026', now), true)
    assert.equal(R.isInRepairScope('18_11_2026', now), true)                   // one-day margin across midnight
    assert.equal(R.isInRepairScope('17_11_2026', now), false)
    assert.equal(R.isInRepairScope('20_11_2026', new Date('2026-11-19T18:45:00Z')), true)
    assert.equal(R.isInRepairScope('18_11_2026', new Date('2026-11-19T18:45:00Z')), false)
    assert.equal(R.isInRepairScope('bad', now), false)
})

await test('Z2. Orphan sightings are shared in the DB: multiple instances release an orphan once; held/old slots untouched', async () => {
    const doc = await mkDoctor(docN++)
    const today = istSlotDate(new Date())
    const old = istSlotDate(new Date(Date.now() - 3 * DAY))
    await doctorModel.updateOne({ _id: doc._id }, { $set: { [`slots_booked.${today}`]: ['10:00 AM', '11:00 AM'], [`slots_booked.${old}`]: ['10:00 AM'] } })
    // 11:00 AM is held by an appointment booked long ago (outside the 60-day detection scan)
    await appointmentModel.create({ userId: uid(0), docId: String(doc._id), slotDate: today, slotTime: '11:00 AM', userData: {}, docData: {}, amount: 1, date: Date.now() - 100 * DAY })
    await R.repairSlotConsistency({ graceMs: 0 })     // instance A: first sighting only
    assert.ok(await slotOrphanModel.exists({ key: `${doc._id}|${today}|10:00 AM` }))
    assert.deepEqual((await slotsOf(doc._id, today)).sort(), ['10:00 AM', '11:00 AM'])
    const runs = await Promise.all([1, 2, 3].map(() => R.repairSlotConsistency({ graceMs: 0 })))  // instances B, C, D
    assert.ok(runs.reduce((s, x) => s + x.released, 0) >= 1) // other tests' orphans may also be released
    assert.equal(await slotOrphanModel.countDocuments({ key: `${doc._id}|${today}|10:00 AM` }), 0)
    assert.deepEqual(await slotsOf(doc._id, today), ['11:00 AM'], 'held slot never released')
    assert.deepEqual(await slotsOf(doc._id, old), ['10:00 AM'], 'out-of-scope dates untouched')
    await R.repairSlotConsistency({ graceMs: 0 }); await R.repairSlotConsistency({ graceMs: 0 })
    assert.deepEqual(await slotsOf(doc._id, today), ['11:00 AM'])
})

await test('Z3. Orphan grace period is measured from the stored first sighting', async () => {
    const doc = await mkDoctor(docN++)
    const today = istSlotDate(new Date())
    await doctorModel.updateOne({ _id: doc._id }, { $set: { [`slots_booked.${today}`]: ['02:00 PM'] } })
    const t0 = new Date()
    await R.repairSlotConsistency({ now: t0 })
    await R.repairSlotConsistency({ now: new Date(t0.getTime() + 60 * 1000) })       // 1 min later: within 2 min grace
    assert.deepEqual(await slotsOf(doc._id, today), ['02:00 PM'])
    await R.repairSlotConsistency({ now: new Date(t0.getTime() + 3 * 60 * 1000) })   // 3 min later
    assert.deepEqual(await slotsOf(doc._id, today), [])
})

await test('C1m. Manual capture: authorized payment within the hold is captured by the server once and confirmed', async () => {
    const doc = await mkDoctor(docN++)
    const r = await book(0, doc._id, D, '10:00 AM', 'online')
    const resp = authorizeOrder(r.order.id)
    const captures = rz.captureCalls
    const v = await call(userCtl.verifyRazorpay, { userId: uid(0), body: resp })
    assert.ok(v.success, v.message)
    assert.equal(rz.captureCalls - captures, 1)
    assert.equal(rz.payments.get(resp.razorpay_payment_id).status, 'captured')
    const a = await appointmentModel.findById(r.appointmentId)
    assert.equal(a.status, 'confirmed'); assert.equal(a.razorpayPaymentId, resp.razorpay_payment_id)
    await Promise.all([call(userCtl.verifyRazorpay, { userId: uid(0), body: resp }), R.reconcileRecentOnlineOrders()])
    assert.equal(rz.captureCalls - captures, 1, 'never captured twice')
})

await test('C2m. Manual capture: authorized payment for a lapsed reservation is NOT captured and NOT refunded', async () => {
    const doc = await mkDoctor(docN++)
    const r = await book(0, doc._id, D, '10:00 AM', 'online')
    await expireNow(r.appointmentId); await R.cleanupExpiredReservations() // order still 'created': expired, slot released
    const resp = authorizeOrder(r.order.id)
    const captures = rz.captureCalls; const refunds = rz.refunds.length
    const v = await call(userCtl.verifyRazorpay, { userId: uid(0), body: resp })
    assert.equal(v.success, false); assert.match(v.message, /not captured/)
    await focusSweep(r.appointmentId)
    await R.reconcileRecentOnlineOrders(); await R.reconcileLatePayments()
    assert.equal(rz.captureCalls, captures); assert.equal(rz.refunds.length, refunds)
    const a = await appointmentModel.findById(r.appointmentId)
    assert.equal(a.status, 'expired'); assert.equal(a.payment, false); assert.equal(a.uncapturedPaymentId, resp.razorpay_payment_id)
    assert.equal(rz.payments.get(resp.razorpay_payment_id).status, 'authorized')
})

await test('C3m. Manual capture: authorized payment found by expiry cron while the hold is still active is captured and confirmed', async () => {
    const doc = await mkDoctor(docN++)
    const r = await book(0, doc._id, D, '10:00 AM', 'online')
    const auth = authorizeOrder(r.order.id)  // browser closed right after authorization
    await expireNow(r.appointmentId)
    setPaymentCreatedAt(auth.razorpay_payment_id, new Date(Date.now() - 2 * 60 * 1000)) // made during the hold
    const res = await R.cleanupExpiredReservations()
    assert.equal(res.reconciled, 1)
    const a = await appointmentModel.findById(r.appointmentId)
    assert.equal(a.status, 'confirmed'); assert.equal(a.payment, true)
})

// ======================= Reproduced Chrome/Edge double booking =======================
// Root cause: slot times came from the browser's toLocaleTimeString(), so two browsers sent
// "10:00 AM" and "10:00 am" for the same slot, and exact-string guards treated them as different slots.

await test('B1. Same slot sent in different browser spellings simultaneously (x10): exactly one reservation', async () => {
    const spellings = [['10:00 AM', '10:00 am'], ['10:00 AM', '10:00 AM'], ['10:00 am', '10:00'], ['02:30 PM', '14:30'], ['2:30 pm', '02:30 PM']]
    for (let i = 0; i < 10; i++) {
        const [a, b] = spellings[i % spellings.length]
        const doc = await mkDoctor(docN++)
        const [r1, r2] = await Promise.all([book(0, doc._id, D, a), book(1, doc._id, D, b)])
        assert.equal([r1, r2].filter(r => r.success).length, 1, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`)
        const loser = r1.success ? r2 : r1
        assert.equal(loser.message, 'Slot not available')
        const active = await appointmentModel.find({ docId: String(doc._id), cancelled: false }).lean()
        assert.equal(active.length, 1)
        assert.match(active[0].slotTime, /^\d{2}:\d{2} (AM|PM)$/, 'stored in canonical form')
        assert.deepEqual(await slotsOf(doc._id, D), [active[0].slotTime])
    }
})

await test('B2. 20 simultaneous requests in mixed spellings and users: never more than one active reservation', async () => {
    const doc = await mkDoctor(docN++)
    const variants = ['10:00 AM', '10:00 am', '10:00 AM', '10:00', '10:00 a.m.', '10:00AM', '10:00 Am']
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => book(i % 12, doc._id, D, variants[i % variants.length])))
    assert.equal(rs.filter(r => r.success).length, 1)
    assert.equal(await appointmentModel.countDocuments({ docId: String(doc._id), cancelled: false }), 1)
    assert.equal(await appointmentModel.countDocuments({ docId: String(doc._id), slotLocked: true }), 1)
    assert.deepEqual(await slotsOf(doc._id, D), ['10:00 AM'])
})

await test('B3. Legacy lowercase data: "10:00 am" entry blocks "10:00 AM"; cancelling the legacy holder frees it', async () => {
    const doc = await mkDoctor(docN++)
    await doctorModel.updateOne({ _id: doc._id }, { $set: { [`slots_booked.${D}`]: ['10:00 am'] } })
    const [legacyId] = Object.values((await appointmentModel.collection.insertMany([{ userId: uid(0), docId: String(doc._id), slotDate: D, slotTime: '10:00 am', userData: {}, docData: {}, amount: 500, date: Date.now(), cancelled: false, payment: false, isCompleted: false }])).insertedIds)
    assert.equal((await book(1, doc._id, D, '10:00 AM')).success, false)
    assert.equal((await book(1, doc._id, D, '10:00 AM')).success, false)
    await call(userCtl.cancelAppointment, { userId: uid(0), body: { appointmentId: String(legacyId) } })
    assert.deepEqual(await slotsOf(doc._id, D), [], 'legacy spelling released')
    const r = await book(1, doc._id, D, '10:00 AM')
    assert.ok(r.success)
    assert.deepEqual(await slotsOf(doc._id, D), ['10:00 AM'])
})

await test('B4. Cancelling a legacy "10:00 am" duplicate never releases the canonical holder of the same slot', async () => {
    const doc = await mkDoctor(docN++)
    assert.ok((await book(0, doc._id, D, '10:00 AM')).success)
    const [legacyId] = Object.values((await appointmentModel.collection.insertMany([{ userId: uid(1), docId: String(doc._id), slotDate: D, slotTime: '10:00 am', userData: {}, docData: {}, amount: 500, date: Date.now(), cancelled: false, payment: false, isCompleted: false }])).insertedIds)
    await doctorModel.updateOne({ _id: doc._id }, { $push: { [`slots_booked.${D}`]: '10:00 am' } })
    await call(userCtl.cancelAppointment, { userId: uid(1), body: { appointmentId: String(legacyId) } })
    assert.ok((await slotsOf(doc._id, D)).includes('10:00 AM'), 'active reservation keeps its slot')
    assert.equal((await book(2, doc._id, D, '10:00 AM')).success, false)
    await assertSlotInvariant(doc._id)
})

await test('B5. Invalid or off-grid slots are rejected', async () => {
    const doc = await mkDoctor(docN++)
    for (const [d, t] of [[D, '10:15 AM'], [D, '25:00'], [D, '13:00 PM'], ['31_2_2026', '10:00 AM'], ['2026-11-20', '10:00 AM'], [D, { $gt: '' }]]) {
        const r = await call(userCtl.bookAppointment, { userId: uid(0), body: { docId: String(doc._id), slotDate: d, slotTime: t } })
        assert.equal(r.success, false, `${d} ${JSON.stringify(t)}`)
    }
    assert.equal(await appointmentModel.countDocuments({ docId: String(doc._id) }), 0)
})

await test('B6. Canonical slot helpers', async () => {
    const cases = { '10:00 AM': '10:00 AM', '10:00 am': '10:00 AM', '10:00 AM': '10:00 AM', '10:00': '10:00 AM', '9:30 pm': '09:30 PM', '21:30': '09:30 PM', '12:00 AM': '12:00 AM', '00:30': '12:30 AM', '12:30 p.m.': '12:30 PM', '13:00 PM': null, 'noon': null }
    for (const [input, out] of Object.entries(cases)) assert.equal(R.canonicalSlotTime(input), out, input)
    assert.equal(R.canonicalSlotDate('08_04_2026'), '8_4_2026'); assert.equal(R.canonicalSlotDate('29_2_2026'), null); assert.equal(R.canonicalSlotDate('29_2_2028'), '29_2_2028')
    assert.ok(R.slotTimeVariants('10:00 AM').includes('10:00 am') && R.slotTimeVariants('10:00 AM').includes('10:00'))
})

// ======================= Payment ownership and hold validity =======================

await test('O1. Two users and one slot: only the reservation owner can create or verify its payment', async () => {
    const doc = await mkDoctor(docN++)
    const a = await book(0, doc._id, D, '10:00 AM')
    assert.ok(a.success)
    assert.equal((await book(1, doc._id, D, '10:00 am')).success, false, 'second user cannot reserve')
    const bOrder = await call(userCtl.paymentRazorpay, { userId: uid(1), body: { appointmentId: String(a.appointmentId) } })
    assert.deepEqual([bOrder.success, bOrder.message], [false, 'Unauthorized action'])
    const resp = payOrder(a.order.id)
    const bVerify = await call(userCtl.verifyRazorpay, { userId: uid(1), body: resp })
    assert.deepEqual([bVerify.success, bVerify.message], [false, 'Unauthorized action'])
    assert.equal((await appointmentModel.findById(a.appointmentId)).status, 'pending', 'unchanged by another user')
    const aVerify = await call(userCtl.verifyRazorpay, { userId: uid(0), body: resp })
    assert.ok(aVerify.success)
    const appt = await appointmentModel.findById(a.appointmentId)
    assert.equal(appt.status, 'confirmed'); assert.equal(appt.payment, true); assert.equal(appt.userId, uid(0))
    assert.equal(await appointmentModel.countDocuments({ docId: String(doc._id), payment: true }), 1)
})

await test('O2. Already-paid appointment cannot start another payment', async () => {
    const doc = await mkDoctor(docN++)
    const a = await book(0, doc._id, D, '10:00 AM')
    assert.ok((await call(userCtl.verifyRazorpay, { userId: uid(0), body: payOrder(a.order.id) })).success)
    const again = await call(userCtl.paymentRazorpay, { userId: uid(0), body: { appointmentId: String(a.appointmentId) } })
    assert.equal(again.success, false)
})

await test('O3. Payment made AFTER the hold expired (cron not run yet) never confirms the stale hold directly', async () => {
    const doc = await mkDoctor(docN++)
    const a = await book(0, doc._id, D, '10:00 AM')
    await expireNow(a.appointmentId)                 // still 'pending' in the DB
    const resp = payOrder(a.order.id)                // created_at = now, after expiresAt
    assert.ok((await book(1, doc._id, D, '10:00 AM')).success, 'another user reclaims the expired slot first')
    const v = await call(userCtl.verifyRazorpay, { userId: uid(0), body: resp })
    assert.equal(v.success, false)
    assert.equal(refundsFor(resp.razorpay_payment_id), 1)
    const stale = await appointmentModel.findById(a.appointmentId)
    assert.equal(stale.payment, false); assert.equal(stale.status, 'expired')
    assert.equal(await appointmentModel.countDocuments({ docId: String(doc._id), cancelled: false }), 1)
    await assertSlotInvariant(doc._id)
})

await test('O4. Payment after expiry with the slot still free: hold closed, slot re-claimed atomically, one booking', async () => {
    const doc = await mkDoctor(docN++)
    const a = await book(0, doc._id, D, '10:00 AM')
    await expireNow(a.appointmentId)
    const resp = payOrder(a.order.id)
    const v = await call(userCtl.verifyRazorpay, { userId: uid(0), body: resp })
    assert.ok(v.success, v.message)
    const appt = await appointmentModel.findById(a.appointmentId)
    assert.equal(appt.status, 'confirmed'); assert.equal(appt.slotLocked, true); assert.equal(appt.cancelled, false)
    assert.equal(refundsFor(resp.razorpay_payment_id), 0)
    await assertSlotInvariant(doc._id)
})

await test('O5. Payment made DURING the hold but verified after expiry is honoured (no other holder)', async () => {
    const doc = await mkDoctor(docN++)
    const a = await book(0, doc._id, D, '10:00 AM')
    const resp = payOrder(a.order.id)
    await expireNow(a.appointmentId)
    setPaymentCreatedAt(resp.razorpay_payment_id, new Date(Date.now() - 2 * 60 * 1000))
    const v = await call(userCtl.verifyRazorpay, { userId: uid(0), body: resp })
    assert.ok(v.success)
    assert.equal((await appointmentModel.findById(a.appointmentId)).status, 'confirmed')
})

await test('O6. Legacy appointment cancelled before its payment arrived: refunded, never marked paid', async () => {
    const doc = await mkDoctor(docN++)
    const [legacyId] = Object.values((await appointmentModel.collection.insertMany([{ userId: uid(0), docId: String(doc._id), slotDate: D, slotTime: '06:00 PM', userData: {}, docData: {}, amount: 500, date: Date.now(), cancelled: false, payment: false, isCompleted: false }])).insertedIds)
    const p = await call(userCtl.paymentRazorpay, { userId: uid(0), body: { appointmentId: String(legacyId) } })
    assert.ok(p.success)
    await call(userCtl.cancelAppointment, { userId: uid(0), body: { appointmentId: String(legacyId) } })
    const resp = payOrder(p.order.id)
    const v = await call(userCtl.verifyRazorpay, { userId: uid(0), body: resp })
    assert.equal(v.success, false)
    assert.equal((await appointmentModel.findById(legacyId)).payment, false)
    assert.equal(refundsFor(resp.razorpay_payment_id), 1)
    assert.equal((await refundModel.findOne({ paymentId: resp.razorpay_payment_id })).reason, 'cancelled_appointment')
})

// ---- migration: legacy spellings ----
// fresh migration target DB with the real unique_active_slot index (so collisions are real)
const freshMigrationDb = async () => {
    await prodDb().dropDatabase()
    await prodDb().collection('appointments').createIndex({ docId: 1, slotDate: 1, slotTime: 1 }, { name: 'unique_active_slot', unique: true, partialFilterExpression: { slotLocked: true } })
    return new mongoose.Types.ObjectId()
}

await test('M5. Reproduced case (two PAID, both slotLocked, "10:00 AM" vs "10:00 am"): UNRESOLVED, deferred, no index failure', async () => {
    const docId = await freshMigrationDb()
    await prodDb().collection('doctors').insertOne({ _id: docId, slots_booked: { '23_11_2026': ['10:00 am', '10:00 AM'], '24_11_2026': ['11:00 am'] } })
    await prodDb().collection('appointments').insertMany([
        seedAppt({ docId: String(docId), userId: 'chrome', slotDate: '23_11_2026', slotTime: '10:00 AM', payment: true, slotLocked: true, date: 1 }),
        seedAppt({ docId: String(docId), userId: 'edge', slotDate: '23_11_2026', slotTime: '10:00 am', payment: true, slotLocked: true, date: 2 }),
        seedAppt({ docId: String(docId), userId: 'solo', slotDate: '24_11_2026', slotTime: '11:00 am', date: 3 })
    ])
    const before = await snapshotProd()
    const dry = runMigration()
    assert.equal(dry.status, 2); assert.match(dry.stdout, /Active duplicate groups: 1/); assert.match(dry.stdout, /DEFER/)
    assert.equal(await snapshotProd(), before, 'dry run writes nothing')
    const res = runMigration('--apply')
    assert.equal(res.status, 2, res.stdout)                 // manual action needed, NOT a failure
    assert.match(res.stdout, /Failures: 0/); assert.doesNotMatch(res.stdout, /duplicate key/)
    const A = prodDb().collection('appointments')
    assert.equal(await A.countDocuments({ cancelled: false, payment: true }), 2, 'paid duplicates are not cancelled automatically')
    assert.equal((await A.findOne({ userId: 'edge' })).slotTime, '10:00 am', 'deferred until resolved')
    assert.equal((await A.findOne({ userId: 'chrome' })).slotTime, '10:00 AM')
    assert.equal((await A.findOne({ userId: 'solo' })).slotTime, '11:00 AM')
    const d = await prodDb().collection('doctors').findOne({ _id: docId })
    assert.deepEqual(d.slots_booked['23_11_2026'], ['10:00 AM'], 'slot stays booked'); assert.deepEqual(d.slots_booked['24_11_2026'], ['11:00 AM'])
    const after = await snapshotProd()
    const again = runMigration('--apply')
    assert.equal(again.status, 2); assert.equal(await snapshotProd(), after, 'rerun changes nothing')
    // once a human resolves the group (cancels one WITHOUT releasing the slot), the rerun completes
    await A.updateOne({ userId: 'edge' }, { $set: { cancelled: true, status: 'cancelled', slotLocked: false } })
    const resolved = runMigration('--apply')
    assert.equal(resolved.status, 0, resolved.stdout)
    assert.equal((await A.findOne({ userId: 'edge' })).slotTime, '10:00 AM')
    assert.deepEqual((await prodDb().collection('doctors').findOne({ _id: docId })).slots_booked['23_11_2026'], ['10:00 AM'])
})

await test('M6. Resolvable mixed-spelling pairs with both records slotLocked: no unique-index conflict, exit 0', async () => {
    const docId = await freshMigrationDb()
    await prodDb().collection('doctors').insertOne({ _id: docId, slots_booked: { '23_11_2026': ['10:00 am', '10:00 AM', '11:00 AM', '11:00 am'] } })
    await prodDb().collection('appointments').insertMany([
        // paid record uses the canonical spelling, unpaid duplicate the legacy one
        seedAppt({ docId: String(docId), userId: 'paidA', slotDate: '23_11_2026', slotTime: '10:00 AM', payment: true, slotLocked: true, date: 2 }),
        seedAppt({ docId: String(docId), userId: 'unpaidA', slotDate: '23_11_2026', slotTime: '10:00 am', slotLocked: true, date: 1 }),
        // paid record uses the legacy spelling, unpaid duplicate the canonical one
        seedAppt({ docId: String(docId), userId: 'paidB', slotDate: '23_11_2026', slotTime: '11:00 am', payment: true, slotLocked: true, date: 2 }),
        seedAppt({ docId: String(docId), userId: 'unpaidB', slotDate: '23_11_2026', slotTime: '11:00 AM', slotLocked: true, date: 1 })
    ])
    const res = runMigration('--apply')
    assert.equal(res.status, 0, res.stdout); assert.match(res.stdout, /Failures: 0/)
    const A = prodDb().collection('appointments')
    for (const kept of ['paidA', 'paidB']) {
        const k = await A.findOne({ userId: kept })
        assert.equal(k.cancelled, false); assert.equal(k.slotLocked, true); assert.equal(k.payment, true)
    }
    assert.equal((await A.findOne({ userId: 'paidB' })).slotTime, '11:00 AM')
    for (const red of ['unpaidA', 'unpaidB']) {
        const r = await A.findOne({ userId: red })
        assert.equal(r.cancelled, true); assert.equal(r.slotLocked, false); assert.ok(r.duplicateOf)
    }
    assert.deepEqual((await prodDb().collection('doctors').findOne({ _id: docId })).slots_booked['23_11_2026'], ['10:00 AM', '11:00 AM'])
    const after = await snapshotProd()
    assert.equal(runMigration('--apply').status, 0); assert.equal(await snapshotProd(), after, 'idempotent')
})

await test('M7. Rerun after an interrupted apply (duplicate cancelled, respelling/array not yet done) completes safely', async () => {
    const docId = await freshMigrationDb()
    await prodDb().collection('doctors').insertOne({ _id: docId, slots_booked: { '23_11_2026': ['10:00 am', '10:00 AM'] } })
    await prodDb().collection('appointments').insertMany([
        seedAppt({ docId: String(docId), userId: 'kept', slotDate: '23_11_2026', slotTime: '10:00 AM', payment: true, slotLocked: true, date: 2 }),
        // state left by a crash right after phase 1: cancelled + unlocked, still legacy spelling
        seedAppt({ docId: String(docId), userId: 'red', slotDate: '23_11_2026', slotTime: '10:00 am', cancelled: true, status: 'cancelled', slotLocked: false, duplicateOf: 'x', date: 1 })
    ])
    const res = runMigration('--apply', '--lock-legacy')
    assert.equal(res.status, 0, res.stdout)
    const A = prodDb().collection('appointments')
    assert.equal((await A.findOne({ userId: 'red' })).slotTime, '10:00 AM')
    assert.equal((await A.findOne({ userId: 'kept' })).cancelled, false)
    assert.deepEqual((await prodDb().collection('doctors').findOne({ _id: docId })).slots_booked['23_11_2026'], ['10:00 AM'])
    const after = await snapshotProd()
    assert.equal(runMigration('--apply', '--lock-legacy').status, 0); assert.equal(await snapshotProd(), after)
})

await test('M9. --apply refuses to run without an explicit MONGODB_DB_NAME (no default target)', async () => {
    const docId = await freshMigrationDb()
    await prodDb().collection('doctors').insertOne({ _id: docId, slots_booked: { '23_11_2026': ['10:00 am'] } })
    const before = await snapshotProd()
    const env = { ...process.env, MONGODB_URI: mongod.getUri() }
    delete env.MONGODB_DB_NAME
    const res = spawnSync(process.execPath, [`${BACKEND}/scripts/reconcileDuplicateSlots.js`, '--apply'], { cwd: SANDBOX_CWD, env, encoding: 'utf8' })
    assert.equal(res.status, 1); assert.match(res.stderr, /Refusing --apply/)
    assert.equal(await snapshotProd(), before)
})

await test('M8. Unexpected unique-index conflict is reported (exit 1) and nothing is modified for that record', async () => {
    const docId = await freshMigrationDb()
    await prodDb().collection('doctors').insertOne({ _id: docId, slots_booked: { '23_11_2026': ['10:00 AM'] } })
    await prodDb().collection('appointments').insertMany([
        seedAppt({ docId: String(docId), userId: 'holder', slotDate: '23_11_2026', slotTime: '10:00 AM', payment: true, slotLocked: true, date: 1 }),
        // inconsistent legacy record: cancelled but still slotLocked, other spelling
        seedAppt({ docId: String(docId), userId: 'odd', slotDate: '23_11_2026', slotTime: '10:00 am', cancelled: true, slotLocked: true, date: 2 })
    ])
    const res = runMigration('--apply')
    assert.equal(res.status, 1, res.stdout); assert.match(res.stdout, /normalise .*duplicate key/)
    const A = prodDb().collection('appointments')
    assert.equal((await A.findOne({ userId: 'odd' })).slotTime, '10:00 am')
    const h = await A.findOne({ userId: 'holder' })
    assert.equal(h.cancelled, false); assert.equal(h.slotLocked, true)
    assert.deepEqual((await prodDb().collection('doctors').findOne({ _id: docId })).slots_booked['23_11_2026'], ['10:00 AM'])
})

// ======================= Historical paid duplicate: cancel + refund service =======================
// legacy cash-flow pair later paid online, both slotLocked, different spellings (as in prescripto_test)
const legacyPaidPair = async () => {
    const doc = await mkDoctor(docN++)
    await doctorModel.updateOne({ _id: doc._id }, { $set: { [`slots_booked.${D}`]: ['10:00 am', '10:00 AM'] } })
    const base = { docId: String(doc._id), slotDate: D, userData: {}, docData: {}, amount: 50, cancelled: false, payment: true, isCompleted: false, slotLocked: true, paymentMethod: 'cash', status: 'confirmed', paymentStatus: 'paid' }
    const ids = Object.values((await appointmentModel.collection.insertMany([
        { ...base, userId: uid(0), slotTime: '10:00 am', date: 1000 },
        { ...base, userId: uid(1), slotTime: '10:00 AM', date: 2000 }
    ])).insertedIds)
    const pay = async (id) => { const o = await fakeClient.orders.create({ amount: 5000, currency: 'INR', receipt: String(id) }); return { order: o.id, ...payOrder(o.id) } }
    return { doc, keepId: ids[0], cancelId: ids[1], keepPay: await pay(ids[0]), cancelPay: await pay(ids[1]) }
}

await test('H1. Paid duplicate: loser cancelled + refunded exactly once; winner and its slot untouched; stale callbacks harmless', async () => {
    const { doc, keepId, cancelId, keepPay, cancelPay } = await legacyPaidPair()
    const res = await R.cancelPaidDuplicateAndRefund({ appointmentId: cancelId, keepAppointmentId: keepId, paymentId: cancelPay.razorpay_payment_id, orderId: cancelPay.order })
    assert.equal(res.appointment.cancelled, true); assert.equal(res.appointment.payment, false); assert.equal(res.appointment.paymentStatus, 'refunded')
    assert.equal(res.appointment.duplicateOf, String(keepId)); assert.ok(res.appointment.refundId)
    assert.equal(res.refund.status, 'processed'); assert.equal(res.refund.reason, 'duplicate_booking'); assert.equal(res.refund.amount, 5000)
    assert.equal(refundsFor(cancelPay.razorpay_payment_id), 1); assert.equal(refundsFor(keepPay.razorpay_payment_id), 0)
    const kept = await appointmentModel.findById(keepId)
    assert.equal(kept.cancelled, false); assert.equal(kept.payment, true); assert.equal(kept.slotLocked, true)
    assert.ok((await slotsOf(doc._id, D)).length >= 1, 'slot still booked for the winner')
    assert.equal((await book(5, doc._id, D, '10:00 AM')).success, false, 'slot unavailable to other users')
    // stale browser callback + webhook + reconciliation for the refunded payment
    const raw = Buffer.from(JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: cancelPay.razorpay_payment_id, order_id: cancelPay.order } } } }))
    const sig = crypto.createHmac('sha256', 'wh_secret').update(raw).digest('hex')
    const [v] = await Promise.all([
        call(userCtl.verifyRazorpay, { userId: uid(1), body: cancelPay }),
        call(userCtl.razorpayWebhook, { body: raw, headers: { 'x-razorpay-signature': sig } }),
        R.reconcileLatePayments(), makeRefundsDue().then(() => R.reconcileLatePayments())
    ])
    assert.equal(v.success, false)
    const after = await appointmentModel.findById(cancelId)
    assert.equal(after.cancelled, true); assert.equal(after.payment, false); assert.equal(after.status, 'cancelled')
    assert.equal(refundsFor(cancelPay.razorpay_payment_id), 1)
    // re-running the resolution is idempotent
    await R.cancelPaidDuplicateAndRefund({ appointmentId: cancelId, keepAppointmentId: keepId, paymentId: cancelPay.razorpay_payment_id, orderId: cancelPay.order })
    assert.equal(refundsFor(cancelPay.razorpay_payment_id), 1)
    assert.equal(await refundModel.countDocuments({ paymentId: cancelPay.razorpay_payment_id }), 1)
})

await test('H2. Resolution refuses unsafe inputs without changing anything', async () => {
    const { keepId, cancelId, keepPay, cancelPay } = await legacyPaidPair()
    const snapshot = async () => JSON.stringify(await appointmentModel.find({ _id: { $in: [keepId, cancelId] } }).sort({ _id: 1 }).lean())
    const before = await snapshot()
    const calls = rz.refundCalls
    const bad = [
        { appointmentId: cancelId, keepAppointmentId: cancelId, paymentId: cancelPay.razorpay_payment_id, orderId: cancelPay.order },  // same appointment
        { appointmentId: cancelId, keepAppointmentId: keepId, paymentId: keepPay.razorpay_payment_id, orderId: keepPay.order },        // winner's payment
        { appointmentId: cancelId, keepAppointmentId: keepId, paymentId: keepPay.razorpay_payment_id, orderId: cancelPay.order },      // payment/order mismatch
        { appointmentId: keepId, keepAppointmentId: new mongoose.Types.ObjectId(), paymentId: keepPay.razorpay_payment_id, orderId: keepPay.order } // unknown keep
    ]
    for (const input of bad) await assert.rejects(R.cancelPaidDuplicateAndRefund(input))
    // a refund this app did not create (e.g. made in the dashboard) blocks automatic resolution
    await fakeClient.payments.refund(cancelPay.razorpay_payment_id, { amount: 5000 })
    await assert.rejects(R.cancelPaidDuplicateAndRefund({ appointmentId: cancelId, keepAppointmentId: keepId, paymentId: cancelPay.razorpay_payment_id, orderId: cancelPay.order }), /did not create/)
    assert.equal(await snapshot(), before)
    assert.equal(rz.refundCalls, calls + 1, 'only the simulated external refund was made')
})

await test('H3. Crash after the atomic cancel (before the refund record): cron completes the refund once; re-run resumes', async () => {
    const { keepId, cancelId, cancelPay } = await legacyPaidPair()
    // exactly the state the atomic cancel step writes
    await appointmentModel.updateOne({ _id: cancelId }, { $set: { cancelled: true, status: 'cancelled', slotLocked: false, payment: false, paymentStatus: 'refund_pending', refundPaymentId: cancelPay.razorpay_payment_id, refundAmount: 5000, duplicateOf: String(keepId) } })
    await Promise.all([R.reconcileLatePayments(), R.cancelPaidDuplicateAndRefund({ appointmentId: cancelId, keepAppointmentId: keepId, paymentId: cancelPay.razorpay_payment_id, orderId: cancelPay.order })])
    assert.equal(refundsFor(cancelPay.razorpay_payment_id), 1)
    assert.equal((await appointmentModel.findById(cancelId)).paymentStatus, 'refunded')
    assert.equal((await appointmentModel.findById(keepId)).cancelled, false)
})

await test('H4. Resolution script guards: explicit *_test database and Razorpay Test Mode key required', async () => {
    const run = (env) => spawnSync(process.execPath, [`${BACKEND}/scripts/resolveDuplicatePayment.js`, '--apply'], { cwd: SANDBOX_CWD, env: { ...process.env, MONGODB_URI: mongod.getUri(), ...env }, encoding: 'utf8' })
    const noDb = { ...process.env }; delete noDb.MONGODB_DB_NAME
    assert.match(run({ MONGODB_DB_NAME: '' }).stderr, /must be set explicitly/)
    for (const name of ['prescripto', 'prescripto_live', 'production']) {
        const r = run({ MONGODB_DB_NAME: name }); assert.equal(r.status, 1); assert.match(r.stderr, /not a test database/)
    }
    const live = run({ MONGODB_DB_NAME: 'prescripto_test', RAZORPAY_KEY_ID: 'rzp_live_x' })
    assert.equal(live.status, 1); assert.match(live.stderr, /not a Razorpay Test Mode key/)
})

await test('M10. Migration --apply refuses the production database name "prescripto"', async () => {
    const before = await snapshotProd()
    const res = spawnSync(process.execPath, [`${BACKEND}/scripts/reconcileDuplicateSlots.js`, '--apply'], { cwd: SANDBOX_CWD, env: { ...process.env, MONGODB_URI: mongod.getUri(), MONGODB_DB_NAME: 'prescripto' }, encoding: 'utf8' })
    assert.equal(res.status, 1); assert.match(res.stderr, /Refusing --apply on the production database/)
    assert.equal(await mongoose.connection.client.db('prescripto').collection('appointments').countDocuments(), 0)
    assert.equal(await snapshotProd(), before)
})

// ======================= Payment failure must not end the reservation =======================
// Root cause (fixed): Checkout's payment.failed handler called /release-reservation, whose
// handler ran failPendingReservation() and released the slot on the first failed attempt.

// reservation with `minutes` left on its ORIGINAL deadline
const reserveWithRemaining = async (minutes) => {
    const doc = await mkDoctor(docN++)
    const r = await book(0, doc._id, D, '10:00 AM')
    const deadline = new Date(Date.now() + minutes * 60 * 1000)
    await appointmentModel.updateOne({ _id: r.appointmentId }, { $set: { expiresAt: deadline } })
    return { doc, r, deadline }
}
const reportFailure = (r, i = 0) => call(userCtl.reportPaymentFailure, { userId: uid(i), body: { appointmentId: String(r.appointmentId) } })
const assertStillReserved = async (doc, r, deadline) => {
    const a = await appointmentModel.findById(r.appointmentId)
    assert.equal(a.status, 'pending'); assert.equal(a.paymentStatus, 'pending'); assert.equal(a.payment, false)
    assert.equal(a.cancelled, false); assert.equal(a.slotLocked, true)
    assert.equal(a.expiresAt.getTime(), deadline.getTime(), 'original deadline unchanged (not restarted or extended)')
    assert.deepEqual(await slotsOf(doc._id, D), ['10:00 AM'])
    assert.equal((await book(3, doc._id, D, '10:00 AM')).success, false, 'still unavailable to other users')
    assert.equal((await book(4, doc._id, D, '10:00 am')).success, false)
}

await test('PF1. Payment rejected with 3 minutes remaining: slot stays reserved, deadline unchanged', async () => {
    const { doc, r, deadline } = await reserveWithRemaining(3)
    failAttempt(r.order.id)
    const rep = await reportFailure(r)
    assert.ok(rep.success); assert.equal(rep.reservationActive, true)
    await R.cleanupExpiredReservations(); await R.reconcileRecentOnlineOrders(); await R.repairSlotConsistency({ graceMs: 0 })
    await assertStillReserved(doc, r, deadline)
    assert.equal((await appointmentModel.findById(r.appointmentId)).paymentFailureCount, 1)
})

await test('PF2. Payment rejected with 1 minute remaining: slot stays reserved (legacy /release-reservation path too)', async () => {
    const { doc, r, deadline } = await reserveWithRemaining(1)
    failAttempt(r.order.id)
    const userRoute = (await imp('routes/userRoute.js')).default
    const legacyHandler = userRoute.stack.find(l => l.route?.path === '/release-reservation').route.stack.at(-1).handle
    assert.equal(legacyHandler, userCtl.reportPaymentFailure, 'old route is wired to the non-releasing handler')
    assert.ok((await call(legacyHandler, { userId: uid(0), body: { appointmentId: String(r.appointmentId) } })).success)
    await R.cleanupExpiredReservations()
    await assertStillReserved(doc, r, deadline)
})

await test('PF3. After the ORIGINAL deadline the reservation expires and the slot is released', async () => {
    const { doc, r, deadline } = await reserveWithRemaining(3)
    failAttempt(r.order.id)
    await reportFailure(r)
    assert.equal((await appointmentModel.findById(r.appointmentId)).expiresAt.getTime(), deadline.getTime())
    await R.cleanupExpiredReservations()
    assert.equal((await appointmentModel.findById(r.appointmentId)).status, 'pending', 'not before the deadline')
    await appointmentModel.updateOne({ _id: r.appointmentId }, { $set: { expiresAt: new Date(Date.now() - 1000) } }) // deadline passes
    await R.cleanupExpiredReservations()
    const a = await appointmentModel.findById(r.appointmentId)
    assert.equal(a.status, 'expired'); assert.equal(a.paymentStatus, 'unpaid'); assert.equal(a.slotLocked, false)
    assert.deepEqual(await slotsOf(doc._id, D), [])
    assert.ok((await book(1, doc._id, D, '10:00 AM')).success)
})

await test('PF4. Failed attempt, then successful retry before expiry on the same order: confirmed exactly once', async () => {
    const { doc, r } = await reserveWithRemaining(3)
    failAttempt(r.order.id)
    await reportFailure(r)
    const resume = await call(userCtl.paymentRazorpay, { userId: uid(0), body: { appointmentId: String(r.appointmentId) } })
    assert.ok(resume.success); assert.equal(resume.order.id, r.order.id, 'retry reuses the reservation order')
    const resp = payOrder(r.order.id)
    const [v1, v2] = await Promise.all([call(userCtl.verifyRazorpay, { userId: uid(0), body: resp }), call(userCtl.verifyRazorpay, { userId: uid(0), body: resp })])
    assert.ok(v1.success && v2.success)
    const a = await appointmentModel.findById(r.appointmentId)
    assert.equal(a.status, 'confirmed'); assert.equal(a.payment, true); assert.equal(a.razorpayPaymentId, resp.razorpay_payment_id)
    assert.equal(refundsFor(resp.razorpay_payment_id), 0)
    // a late failure report after success changes nothing
    const late = await reportFailure(r)
    assert.equal(late.success, false)
    assert.equal((await appointmentModel.findById(r.appointmentId)).status, 'confirmed')
    await assertSlotInvariant(doc._id)
})

await test('PF5. Duplicate / concurrent failure callbacks never release or corrupt a valid reservation', async () => {
    const { doc, r, deadline } = await reserveWithRemaining(3)
    failAttempt(r.order.id); failAttempt(r.order.id)
    const results = await Promise.all([...Array(6)].map(() => reportFailure(r)).concat([R.cleanupExpiredReservations(), R.reconcileRecentOnlineOrders()]))
    assert.ok(results.slice(0, 6).every(x => x.success))
    await assertStillReserved(doc, r, deadline)
    assert.equal((await appointmentModel.findById(r.appointmentId)).paymentFailureCount, 6)
})

await test('PF6. Success after expiry following a failure: late-payment logic (re-claim if free, refund if taken)', async () => {
    // slot free -> re-claimed and confirmed
    const a1 = await reserveWithRemaining(3)
    failAttempt(a1.r.order.id); await reportFailure(a1.r)
    await expireNow(a1.r.appointmentId)
    const v1 = await call(userCtl.verifyRazorpay, { userId: uid(0), body: payOrder(a1.r.order.id) })
    assert.ok(v1.success)
    assert.equal((await appointmentModel.findById(a1.r.appointmentId)).status, 'confirmed')
    await assertSlotInvariant(a1.doc._id)
    // slot taken by another user after expiry -> refunded, no overbooking
    const a2 = await reserveWithRemaining(3)
    failAttempt(a2.r.order.id); await reportFailure(a2.r)
    await expireNow(a2.r.appointmentId)
    assert.ok((await book(1, a2.doc._id, D, '10:00 AM')).success)
    const resp = payOrder(a2.r.order.id)
    const v2 = await call(userCtl.verifyRazorpay, { userId: uid(0), body: resp })
    assert.equal(v2.success, false)
    assert.equal(refundsFor(resp.razorpay_payment_id), 1)
    assert.equal(await appointmentModel.countDocuments({ docId: String(a2.doc._id), cancelled: false }), 1)
    await assertSlotInvariant(a2.doc._id)
})

await test('PF7. Explicit cancellation of the pending reservation releases the slot', async () => {
    const { doc, r } = await reserveWithRemaining(3)
    failAttempt(r.order.id); await reportFailure(r)
    const c = await call(userCtl.cancelAppointment, { userId: uid(0), body: { appointmentId: String(r.appointmentId) } })
    assert.deepEqual([c.success, c.message], [true, 'Appointment Cancelled'])
    const a = await appointmentModel.findById(r.appointmentId)
    assert.equal(a.cancelled, true); assert.equal(a.status, 'cancelled'); assert.equal(a.slotLocked, false)
    assert.deepEqual(await slotsOf(doc._id, D), [])
    assert.ok((await book(1, doc._id, D, '10:00 AM')).success)
})

// ======================= Paid appointments cannot be cancelled (no refund flow yet) =======================
const cancelAs = {
    patient: (appointmentId, userIndex = 0) => call(userCtl.cancelAppointment, { userId: uid(userIndex), body: { appointmentId: String(appointmentId) } }),
    doctor: (appointmentId, docId) => call(docCtl.appointmentCancel, { docId: String(docId), body: { appointmentId: String(appointmentId) } }),
    admin: (appointmentId) => call(adminCtl.appointmentCancel, { body: { appointmentId: String(appointmentId) } })
}
// online reservation paid and confirmed through the real verify path
const paidAppointment = async () => {
    const doc = await mkDoctor(docN++)
    const r = await book(0, doc._id, D, '10:00 AM')
    assert.ok((await call(userCtl.verifyRazorpay, { userId: uid(0), body: payOrder(r.order.id) })).success)
    return { doc, id: r.appointmentId }
}
// legacy appointment paid through the old pay-online path (payment: true, no status field)
const legacyPaidAppointment = async () => {
    const doc = await mkDoctor(docN++)
    await doctorModel.updateOne({ _id: doc._id }, { $set: { [`slots_booked.${D}`]: ['10:00 AM'] } })
    const [id] = Object.values((await appointmentModel.collection.insertMany([{ userId: uid(0), docId: String(doc._id), slotDate: D, slotTime: '10:00 AM', userData: {}, docData: {}, amount: 500, date: Date.now(), cancelled: false, payment: true, isCompleted: false }])).insertedIds)
    return { doc, id }
}
const stateOf = async (id, docId) => JSON.stringify([await appointmentModel.findById(id).lean(), (await doctorModel.findById(docId).lean()).slots_booked])

await test('CP1. Unpaid appointment: patient cancellation succeeds and releases the slot', async () => {
    const doc = await mkDoctor(docN++)
    const r = await book(0, doc._id, D, '10:00 AM')
    const c = await cancelAs.patient(r.appointmentId)
    assert.deepEqual([c.success, c.message], [true, 'Appointment Cancelled'])
    const a = await appointmentModel.findById(r.appointmentId)
    assert.equal(a.cancelled, true); assert.equal(a.slotLocked, false); assert.equal(a.paymentStatus, 'unpaid')
    assert.deepEqual(await slotsOf(doc._id, D), [])
    assert.ok((await book(1, doc._id, D, '10:00 AM')).success)
})

await test('CP2. Paid appointment: patient cancellation rejected, no record or slot changes', async () => {
    const { doc, id } = await paidAppointment()
    const before = await stateOf(id, doc._id)
    const c = await cancelAs.patient(id)
    assert.deepEqual([c.success, c.message], [false, R.PAID_CANCELLATION_MESSAGE])
    assert.equal(await stateOf(id, doc._id), before, 'appointment and slots_booked unchanged')
    const a = await appointmentModel.findById(id)
    assert.equal(a.cancelled, false); assert.equal(a.status, 'confirmed'); assert.equal(a.payment, true); assert.equal(a.slotLocked, true)
    assert.equal((await book(1, doc._id, D, '10:00 AM')).success, false, 'slot still unavailable')
})

await test('CP3. Paid appointment: doctor cancellation rejected (online and legacy paid records)', async () => {
    for (const make of [paidAppointment, legacyPaidAppointment]) {
        const { doc, id } = await make()
        const before = await stateOf(id, doc._id)
        const c = await cancelAs.doctor(id, doc._id)
        assert.deepEqual([c.success, c.message], [false, R.PAID_CANCELLATION_MESSAGE])
        assert.equal(await stateOf(id, doc._id), before)
    }
})

await test('CP4. Paid appointment: admin cancellation rejected (online and legacy paid records)', async () => {
    for (const make of [paidAppointment, legacyPaidAppointment]) {
        const { doc, id } = await make()
        const before = await stateOf(id, doc._id)
        const c = await cancelAs.admin(id)
        assert.deepEqual([c.success, c.message], [false, R.PAID_CANCELLATION_MESSAGE])
        assert.equal(await stateOf(id, doc._id), before)
    }
})

await test('CP5. Unpaid appointments: doctor and admin cancellation still work (pending reservation and legacy unpaid)', async () => {
    const d1 = await mkDoctor(docN++)
    const r1 = await book(0, d1._id, D, '10:00 AM')
    assert.deepEqual([(await cancelAs.doctor(r1.appointmentId, d1._id)).success], [true])
    assert.deepEqual(await slotsOf(d1._id, D), [])
    const d2 = await mkDoctor(docN++)
    await doctorModel.updateOne({ _id: d2._id }, { $set: { [`slots_booked.${D}`]: ['11:00 AM'] } })
    const [legacyId] = Object.values((await appointmentModel.collection.insertMany([{ userId: uid(0), docId: String(d2._id), slotDate: D, slotTime: '11:00 AM', userData: {}, docData: {}, amount: 500, date: Date.now(), cancelled: false, payment: false, isCompleted: false }])).insertedIds)
    assert.equal((await cancelAs.admin(legacyId)).success, true)
    assert.equal((await appointmentModel.findById(legacyId)).cancelled, true)
    assert.deepEqual(await slotsOf(d2._id, D), [])
})

await test('CP6. 12 concurrent cancellations (patient/doctor/admin) of a paid appointment plus bookings: all refused, nothing released', async () => {
    const { doc, id } = await paidAppointment()
    const before = await stateOf(id, doc._id)
    const attempts = Array.from({ length: 12 }, (_, i) => [cancelAs.patient(id), cancelAs.doctor(id, doc._id), cancelAs.admin(id)][i % 3])
    const results = await Promise.all([...attempts, book(1, doc._id, D, '10:00 AM'), book(2, doc._id, D, '10:00 am')])
    results.slice(0, 12).forEach(r => assert.deepEqual([r.success, r.message], [false, R.PAID_CANCELLATION_MESSAGE]))
    assert.ok(results.slice(12).every(r => r.success === false), 'slot never became bookable')
    assert.equal(await stateOf(id, doc._id), before)
    await assertSlotInvariant(doc._id)
})

await test('CP7. Payment confirmation racing patient/doctor/admin cancellations (x10): never cancelled while paid, slot consistent', async () => {
    for (let i = 0; i < 10; i++) {
        const doc = await mkDoctor(docN++)
        const r = await book(0, doc._id, D, '10:00 AM')
        const resp = payOrder(r.order.id)
        await Promise.all([
            call(userCtl.verifyRazorpay, { userId: uid(0), body: resp }),
            cancelAs.patient(r.appointmentId), cancelAs.doctor(r.appointmentId, doc._id), cancelAs.admin(r.appointmentId)
        ])
        const a = await appointmentModel.findById(r.appointmentId)
        assert.ok(!(a.cancelled && a.payment), `iteration ${i}: paid appointment must not be cancelled`)
        if (a.payment) { assert.equal(a.slotLocked, true); assert.ok((await slotsOf(doc._id, D)).includes('10:00 AM')) }
        assert.ok(refundsFor(resp.razorpay_payment_id) <= 1)
        await assertSlotInvariant(doc._id)
    }
})

await test('CP8. UI rules: Cancel hidden for paid appointments in the patient app and in every admin/doctor view', async () => {
    const fsMod = requireBackend('fs')
    const PROJECT = requireBackend('path').resolve(BACKEND, '..')
    for (const app of ['frontend', 'admin']) {
        const rules = await import(pathToFileURL(`${PROJECT}/${app}/src/utils/appointmentRules.js`).href)
        assert.equal(rules.canCancelAppointment({ payment: false, cancelled: false, isCompleted: false }), true, `${app}: unpaid active`)
        assert.equal(rules.canCancelAppointment({ payment: true, cancelled: false, isCompleted: false }), false, `${app}: paid`)
        assert.equal(rules.canCancelAppointment({ payment: true, status: 'confirmed', paymentMethod: 'online' }), false, `${app}: paid online`)
        assert.equal(rules.canCancelAppointment({ payment: false, cancelled: true }), false, `${app}: already cancelled`)
        assert.equal(rules.canCancelAppointment({ payment: false, isCompleted: true }), false, `${app}: completed`)
        assert.equal(rules.canCancelAppointment({ payment: false, paymentStatus: 'refunded', cancelled: true }), false)
        assert.equal(rules.isPaidAppointment({ payment: true }), true); assert.equal(rules.isPaidAppointment({ payment: false }), false)
        assert.match(rules.PAID_CANCELLATION_NOTICE, /contact support|through support/)
    }
    // every UI place that renders a Cancel action gates it with canCancelAppointment(item)
    const views = ['frontend/src/pages/MyAppointments.jsx', 'admin/src/pages/Admin/AllAppointments.jsx', 'admin/src/pages/Admin/Dashboard.jsx', 'admin/src/pages/Doctor/DoctorAppointments.jsx', 'admin/src/pages/Doctor/DoctorDashboard.jsx']
    for (const view of views) {
        const src = fsMod.readFileSync(`${PROJECT}/${view}`, 'utf8')
        assert.match(src, /import \{[^}]*canCancelAppointment[^}]*\} from '[./]+\/utils\/appointmentRules'/, `${view} imports the rule`)
        assert.ok(src.includes('canCancelAppointment(item)'), `${view} gates Cancel with the rule`)
        assert.ok(src.includes('PAID_CANCELLATION_NOTICE'), `${view} explains why paid appointments cannot be cancelled`)
    }
    const patient = fsMod.readFileSync(`${PROJECT}/frontend/src/pages/MyAppointments.jsx`, 'utf8')
    assert.match(patient, /\{canCancelAppointment\(item\) && \(\s*<button\s+onClick=\{\(\) => cancelAppointment\(item\._id\)\}/, 'patient Cancel button rendered only when allowed')
})

// ---- real server.js startup (child process, in-memory DB, NO .env in cwd) ----
const SERVER_DB = 'prescripto_server_startup_test'
const serverDb = () => mongoose.connection.client.db(SERVER_DB)
// extraEnv values of `undefined` remove that variable; onStarted runs while the server is up
const startServerProcess = (extraEnv = {}, onStarted) => new Promise((resolve) => {
    assert.ok(!fs.existsSync(path.join(SANDBOX_CWD, '.env')), 'sandbox cwd must not contain a .env file')
    const { spawn } = requireBackend('child_process')
    const env = { ...process.env, MONGODB_URI: mongod.getUri(), MONGODB_DB_NAME: SERVER_DB, PORT: '4791', ...extraEnv }
    for (const key of ['NODE_ENV', 'RENDER', 'ALLOWED_ORIGINS']) if (!(key in extraEnv)) delete env[key]
    for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key]
    const child = spawn(process.execPath, [`${BACKEND}/server.js`], { cwd: SANDBOX_CWD, env })
    let out = ''
    let finished = false
    const done = async (result) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        let extra = {}
        if (result.started && onStarted) {
            try { extra = { checks: await onStarted() } } catch (error) { extra = { checkError: error } }
        }
        child.kill()
        resolve({ ...result, ...extra, out })
    }
    child.stdout.on('data', d => { out += d; if (out.includes('Server Started')) done({ started: true }) })
    child.stderr.on('data', d => { out += d })
    child.on('exit', code => done({ started: false, code }))
    const timer = setTimeout(() => done({ started: false, code: 'timeout' }), 30000)
})

await test('I3. server.js refuses to start (exit 1) when a required index cannot be created', async () => {
    await serverDb().dropDatabase()
    await serverDb().collection('appointments').createIndex({ docId: 1, slotDate: 1, slotTime: 1 }, { name: 'unique_active_slot' }) // non-unique
    const res = await startServerProcess()
    assert.equal(res.started, false, res.out); assert.equal(res.code, 1, res.out)
    assert.match(res.out, /required database indexes could not be created or verified/)
    assert.doesNotMatch(res.out, /Server Started/)
})

await test('I4. server.js starts only after required indexes are verified; reports obsolete refund_reconcile without dropping it', async () => {
    await serverDb().dropDatabase()
    await serverDb().collection('appointments').createIndex({ paymentStatus: 1 }, { name: 'refund_reconcile', partialFilterExpression: { paymentStatus: { $in: ['refund_pending', 'refund_failed'] } } })
    const res = await startServerProcess()
    assert.equal(res.started, true, res.out)
    assert.ok(res.out.indexOf('Required database indexes verified') < res.out.indexOf('Server Started'))
    assert.match(res.out, /obsolete index "refund_reconcile"/)
    const names = (await serverDb().collection('appointments').indexes()).map(i => i.name)
    assert.ok(names.includes('unique_active_slot') && names.includes('refund_reconcile'), 'obsolete index must NOT be dropped')
    assert.ok((await serverDb().collection('refunds').indexes()).find(i => i.name === 'paymentId_1').unique)
    await serverDb().dropDatabase()
})

// ======================= Audit fixes: orphan race, DB name guard, CORS =======================

await test('Z4. Race: another instance releases the slot between this run reading it and recording a sighting -> no stale sighting', async () => {
    const doc = await mkDoctor(docN++)
    const today = istSlotDate(new Date())
    await doctorModel.updateOne({ _id: doc._id }, { $set: { [`slots_booked.${today}`]: ['03:00 PM'] } })
    const key = `${doc._id}|${today}|03:00 PM`
    const originalCreate = slotOrphanModel.create
    let injected = 0
    // exactly the interleaving behind the flaky Z2: the release (pull + sighting cleanup by
    // instance B) lands after this run listed the slot but before it writes its sighting
    slotOrphanModel.create = async function (...args) {
        if (args[0]?.key === key && injected++ === 0) {
            await doctorModel.updateOne({ _id: doc._id }, { $pull: { [`slots_booked.${today}`]: '03:00 PM' } })
            await slotOrphanModel.deleteMany({ key })
        }
        return originalCreate.apply(this, args)
    }
    try {
        await R.repairSlotConsistency({ graceMs: 0 })
    } finally {
        slotOrphanModel.create = originalCreate
    }
    assert.equal(injected, 1, 'the race was exercised')
    assert.equal(await slotOrphanModel.countDocuments({ key }), 0, 'no sighting may survive for a released slot')
    assert.deepEqual(await slotsOf(doc._id, today), [])
})

await test('Z5. Concurrent repair runs (x15, 4 instances each): orphan released once, held slot kept, no leftover sightings', async () => {
    for (let i = 0; i < 15; i++) {
        const doc = await mkDoctor(docN++)
        const today = istSlotDate(new Date())
        await doctorModel.updateOne({ _id: doc._id }, { $set: { [`slots_booked.${today}`]: ['10:00 AM', '11:00 AM'] } })
        await appointmentModel.create({ userId: uid(0), docId: String(doc._id), slotDate: today, slotTime: '11:00 AM', userData: {}, docData: {}, amount: 1, date: Date.now() })
        await R.repairSlotConsistency({ graceMs: 0 })                 // first sighting
        await Promise.all([1, 2, 3, 4].map(() => R.repairSlotConsistency({ graceMs: 0 })))
        assert.equal(await slotOrphanModel.countDocuments({ key: `${doc._id}|${today}|10:00 AM` }), 0, `iteration ${i}`)
        assert.deepEqual(await slotsOf(doc._id, today), ['11:00 AM'], `iteration ${i}`)
    }
})

await test('E1. Production without MONGODB_DB_NAME refuses to start (never falls back to prescripto_test)', async () => {
    for (const prodEnv of [{ RENDER: 'true' }, { NODE_ENV: 'production' }]) {
        const res = await startServerProcess({ ...prodEnv, MONGODB_DB_NAME: undefined })
        assert.equal(res.started, false, res.out); assert.equal(res.code, 1, res.out)
        assert.match(res.out, /MONGODB_DB_NAME is not set/)
        assert.doesNotMatch(res.out, /MongoDB database: prescripto_test/)
    }
})

await test('E2. Production with an explicit MONGODB_DB_NAME starts on that database; local default stays prescripto_test', async () => {
    const prod = await startServerProcess({ RENDER: 'true', MONGODB_DB_NAME: SERVER_DB, ALLOWED_ORIGINS: 'https://app.example.com' })
    assert.equal(prod.started, true, prod.out); assert.match(prod.out, new RegExp(`MongoDB database: ${SERVER_DB}`))
    const local = await startServerProcess({ MONGODB_DB_NAME: undefined })
    assert.equal(local.started, true, local.out); assert.match(local.out, /MongoDB database: prescripto_test/)
})

const originAllowed = async (origin) => {
    const res = await fetch('http://127.0.0.1:4791/', { headers: { Origin: origin } })
    return res.headers.get('access-control-allow-origin') === origin
}

await test('K1. CORS in production: env-configured and built-in production origins only; no localhost, "*" ignored', async () => {
    const res = await startServerProcess({ RENDER: 'true', ALLOWED_ORIGINS: 'https://app.example.com/, *' }, async () => ({
        envOrigin: await originAllowed('https://app.example.com'),
        builtIn: await originAllowed('https://prescripto-1-sw58.onrender.com'),
        localhost5174: await originAllowed('http://localhost:5174'),
        localhost5175: await originAllowed('http://localhost:5175'),
        evil: await originAllowed('https://evil.example.com')
    }))
    assert.equal(res.started, true, res.out); assert.ifError(res.checkError)
    assert.deepEqual(res.checks, { envOrigin: true, builtIn: true, localhost5174: false, localhost5175: false, evil: false })
    assert.match(res.out, /ALLOWED_ORIGINS="\*" is ignored in production/)
})

await test('K2. CORS locally: localhost 5173/5174/5175 allowed, others blocked; "*" still works for local development', async () => {
    const res = await startServerProcess({}, async () => ({
        l5173: await originAllowed('http://localhost:5173'),
        l5174: await originAllowed('http://localhost:5174'),
        l5175: await originAllowed('http://localhost:5175'),
        evil: await originAllowed('https://evil.example.com')
    }))
    assert.equal(res.started, true, res.out); assert.ifError(res.checkError)
    assert.deepEqual(res.checks, { l5173: true, l5174: true, l5175: true, evil: false })
    const any = await startServerProcess({ ALLOWED_ORIGINS: '*' }, async () => ({ evil: await originAllowed('https://evil.example.com') }))
    assert.deepEqual(any.checks, { evil: true })
})

for (const [s, n, e] of results) console.log(`${s}  ${n}${e ? '\n' + e : ''}`)
const failed = results.filter(r => r[0] === 'FAIL').length
console.log(`\n${results.length - failed}/${results.length} passed`)
await mongoose.disconnect(); await mongod.stop()
process.exit(failed ? 1 : 0)
