import mongoose from "mongoose";

// Durable refund intent. One document per Razorpay payment (unique paymentId), so
// a refund can never be requested twice by repeated callbacks, cron runs or crashes.
const refundSchema = new mongoose.Schema({
    paymentId: {type: String, required: true, unique: true},
    appointmentId: {type: String, required: true},
    amount: {type: Number, required: true},     // paise to refund in total
    reason: {type: String, required: true},     // 'late_payment' | 'duplicate_payment'
    status: {type: String, required: true},     // 'pending' | 'processed' | 'failed' | 'manual_required'
    refundId: {type: String},                   // latest Razorpay refund id
    refundStatus: {type: String},               // latest Razorpay refund status (pending / processed / failed)
    attempts: {type: Number, default: 0},       // failed attempts only
    checks: {type: Number, default: 0},         // status checks while Razorpay reports the refund pending
    nextAttemptAt: {type: Date},                // retry / re-check schedule (backoff)
    lockUntil: {type: Date},                    // lease: one worker talks to Razorpay at a time
    lastError: {type: String}
}, { timestamps: true })

refundSchema.index({ status: 1 }, { name: 'refund_status' })
refundSchema.index({ status: 1, nextAttemptAt: 1 }, { name: 'refund_due' })

const refundModel = mongoose.models.refund || mongoose.model('refund', refundSchema)
export default refundModel
