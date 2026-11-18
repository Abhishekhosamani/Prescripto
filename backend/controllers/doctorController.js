import doctorModel from "../models/doctorModel.js"
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import appointmentModel from "../models/appointmentModel.js"
import { cancelAndReleaseSlot, getExpiredHeldSlots, PAID_CANCELLATION_MESSAGE } from "../utils/slotReservation.js"

const changeAvailability = async (req, res) => {
    try {

        const {docId} = req.body

        const docData = await doctorModel.findById(docId)
        await doctorModel.findByIdAndUpdate(docId, {available: !docData.available})
        res.json({success:true, message:'Availability Changed'})

    } catch (error) {
        console.log(error)
        res.json({success:false, message:error.message})
    }
}

const doctorList = async (req, res) => {

    try {

        const doctors = await doctorModel.find({}).select(['-password', '-email'])

        // backend expiry check: slots held by expired (not yet cleaned up) online
        // reservations are shown as available. Response only; nothing is written here.
        const expiredHolds = await getExpiredHeldSlots()
        if (expiredHolds.length > 0) {
            const doctorsById = new Map(doctors.map(doc => [String(doc._id), doc]))
            for (const hold of expiredHolds) {
                const slots = doctorsById.get(String(hold.docId))?.slots_booked?.[hold.slotDate]
                if (Array.isArray(slots)) {
                    doctorsById.get(String(hold.docId)).slots_booked[hold.slotDate] = slots.filter(time => time !== hold.slotTime)
                }
            }
        }

        res.json({success:true, doctors})

    } catch (error) {
        console.log(error)
        res.json({success:false, message:error.message})
    }
}

// API for doctor login
const loginDoctor = async (req, res) => {

    try {

        const {email, password} = req.body
        const doctor = await doctorModel.findOne({email})

        if (!doctor) {
            return res.json({success: false, message: 'Invalid credentials'})
        }

        const isMatch = await bcrypt.compare(password, doctor.password)

        if (isMatch) {

            const token = jwt.sign({id: doctor._id}, process.env.JWT_SECRET)

            res.json({success: true, token})

        } else {
           return res.json({success: false, message: 'Invalid credentials'})
        }

    } catch (error) {
        console.log(error)
        res.json({success:false, message:error.message})
    }
}

// API to get doctor appointment for doctor panel
const appointmentsDoctor = async (req, res) => {

    try {

        const docId = req.docId
        const appointments = await appointmentModel.find({docId})

        res.json({success: true, appointments})

    } catch (error) {
        console.log(error)
        res.json({success:false, message:error.message})
    }
}

// API to mark appointment completed for doctor panel
const appointmentComplete = async (req, res) => {

    try {

        const {appointmentId} = req.body
        const docId = req.docId

        const appointmentData = await appointmentModel.findById(appointmentId)

        if (appointmentData && appointmentData.docId.toString() === docId.toString()) {
            
            await appointmentModel.findByIdAndUpdate(appointmentId, {isCompleted: true})
            return res.json({success: true, message: 'Appointment Completed'})

        } else {
            return res.json({success: false, message: 'Mark Failed'})
        }

    } catch (error) {
        console.log(error)
        res.json({success:false, message:error.message})
    }
}

// API to cancel appointment completed for doctor panel
const appointmentCancel = async (req, res) => {

    try {

        const {appointmentId} = req.body
        const docId = req.docId

        const appointmentData = await appointmentModel.findById(appointmentId)

        if (appointmentData && appointmentData.docId.toString() === docId.toString()) {
            
            // mark cancelled and release doctor slot (atomic; only releases if this call cancelled it).
            // Paid appointments are refused inside the same atomic update (no refund flow yet).
            const result = await cancelAndReleaseSlot(appointmentId)
            if (result.outcome === 'paid') {
                return res.json({success: false, message: PAID_CANCELLATION_MESSAGE})
            }

            return res.json({success: true, message: 'Appointment Cancelled'})

        } else {
            return res.json({success: false, message: 'Cancellation Failed'})
        }

    } catch (error) {
        console.log(error)
        res.json({success:false, message:error.message})
    }
}

// API to get dashboard data for doctor panel
const doctorDashboard = async (req, res) => {

    try {

        const docId = req.docId

        const appointments = await appointmentModel.find({docId})

        let earnings = 0

        appointments.map((item)=>{
            if (item.isCompleted || item.payment) {
                earnings += item.amount
            }
        })

        let patients = []

        appointments.map((item)=>{
            if (!patients.includes(item.userId)) {
                patients.push(item.userId)
            }
        })

        const dashData = {
            earnings,
            appointments: appointments.length,
            patients: patients.length,
            latestAppointments: appointments.reverse().slice(0, 5)
        }

        res.json({success: true, dashData})

    } catch (error) {
        console.log(error)
        res.json({success:false, message:error.message})
    }
}

// API to get profile for doctor profile
const doctorProfile = async (req, res) => {

    try {

        const docId = req.docId
        const profileData = await doctorModel.findById(docId).select('-password')

        res.json({success : true, profileData})

    } catch (error) {
        console.log(error)
        res.json({success:false, message:error.message})
    }
}

// API to update doctor pofile data from doctor panel
const updateDoctorProfile = async (req, res) => {

    try {

        const {fees, address, available} = req.body
        const docId = req.docId

        await doctorModel.findByIdAndUpdate(docId, {fees, address, available})

        res.json({success: true, message: 'Profile Updated'})

    } catch (error) {
        console.log(error)
        res.json({success:false, message:error.message})
    }
}


export {changeAvailability, doctorList, loginDoctor, appointmentsDoctor, appointmentComplete, appointmentCancel, doctorDashboard, doctorProfile, updateDoctorProfile}