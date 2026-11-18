import mongoose from "mongoose";

// Shared (multi-instance) record of when a slots_booked entry was first seen
// without any holding appointment. The slot-repair job releases an entry only
// after it has stayed orphaned for a grace period across runs/instances.
const slotOrphanSchema = new mongoose.Schema({
    key: {type: String, required: true, unique: true},  // `${docId}|${slotDate}|${slotTime}`
    docId: {type: String, required: true},
    slotDate: {type: String, required: true},
    slotTime: {type: String, required: true},
    firstSeenAt: {type: Date, required: true}
})

const slotOrphanModel = mongoose.models.slotorphan || mongoose.model('slotorphan', slotOrphanSchema)
export default slotOrphanModel
