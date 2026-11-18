import mongoose from "mongoose";

const appointmentSchema = new mongoose.Schema({
    userId: {type: String, required: true},
    docId: {type: String, required: true},
    slotDate: {type: String, required: true},
    slotTime: {type: String, required: true},
    userData: {type: Object, required: true},
    docData: {type: Object, required: true},
    amount: {type: Number, required: true},
    date: {type: Number, required: true},
    cancelled: {type: Boolean, default: false},
    payment: {type: Boolean, default: false},
    isCompleted: {type: Boolean, default: false},

    // --- Slot reservation / online payment hold (all optional, no defaults, so legacy records are untouched) ---
    paymentMethod: {type: String},          // 'cash' | 'online'
    status: {type: String},                 // 'pending' | 'confirmed' | 'expired' | 'failed' | 'cancelled'
    paymentStatus: {type: String},          // 'pending' | 'paid' | 'unpaid' | 'failed' | 'refund_pending' | 'refunded' | 'refund_failed'
    reservedAt: {type: Date},
    expiresAt: {type: Date},
    slotLocked: {type: Boolean},            // true while this appointment holds the doctor's slot (drives the unique index)
    razorpayOrderId: {type: String},
    razorpayPaymentId: {type: String},
    paidAt: {type: Date},
    settlingPaymentId: {type: String},      // idempotency lock for late-payment settlement
    settlingAt: {type: Date},               // lease timestamp; stale leases are resumed by cron
    settlingAmount: {type: Number},         // amount paid (paise) for the payment being settled
    settlingSlotClaimed: {type: Boolean},   // written BEFORE re-claiming the slot, so a crash can be resumed
    // Late-payment refund: intent (refundPaymentId/refundAmount) plus a mirror of the
    // durable refund record in the refunds collection (see refundModel.js)
    refundId: {type: String},
    refundStatus: {type: String},
    refundPaymentId: {type: String},
    refundAmount: {type: Number},           // paise
    refundLastError: {type: String},
    refundRecordedAt: {type: Date},         // durable refund record created for the intent above
    uncapturedPaymentId: {type: String},    // authorized-only payment that was deliberately NOT captured
    duplicateOf: {type: String},
    lastPaymentFailureAt: {type: Date},     // last failed Razorpay attempt (informational; never releases the slot)
    paymentFailureCount: {type: Number},            // appointment that kept the slot when this duplicate was cancelled
    // Webhook-independent reconciliation of this appointment's Razorpay orders
    orderCheckCount: {type: Number},
    nextOrderCheckAt: {type: Date}
})

// Database-level safeguard: at most one slot-holding appointment per doctor/date/time.
// Partial so that cancelled/expired records and legacy records (no slotLocked field) are not indexed.
appointmentSchema.index(
    { docId: 1, slotDate: 1, slotTime: 1 },
    { unique: true, partialFilterExpression: { slotLocked: true }, name: 'unique_active_slot' }
)

// Used by the expiry checks / cron cleanup
appointmentSchema.index(
    { status: 1, expiresAt: 1 },
    { partialFilterExpression: { status: 'pending' }, name: 'pending_reservation_expiry' }
)

// Used by the bounded reconciliation sweep of recent online reservations
appointmentSchema.index(
    { reservedAt: 1 },
    { partialFilterExpression: { paymentMethod: 'online' }, name: 'online_order_reconcile' }
)

const appointmentModel = mongoose.models.appointment || mongoose.model('appointment', appointmentSchema)
export default appointmentModel
