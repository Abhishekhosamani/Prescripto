import validator from 'validator'
import bcrypt from 'bcrypt'
import userModel from '../models/userModel.js'
import jwt from 'jsonwebtoken'
import { cloudinary, connectCloudinary } from '../config/cloudinary.js'
import doctorModel from '../models/doctorModel.js'
import appointmentModel from '../models/appointmentModel.js'
import razorpay from 'razorpay'
import fs from 'fs'
import {
    getReservationMinutes, isValidSlotInput, canonicalSlotDate, canonicalSlotTime, claimSlot, releaseSlot, cancelAndReleaseSlot, PAID_CANCELLATION_MESSAGE,
    failPendingReservation, createRazorpayOrder, getRazorpay, verifyPaymentSignature,
    verifyWebhookSignature, settlePaidOrder, syncRefund
} from '../utils/slotReservation.js'

// API to register user
const registerUser = async (req, res) => {

    try {

        const { name, email, password } = req.body

        if (!name || !email || !password) {
            return res.json({ success: false, message: "Missing Details" })
        }

        // validating email format
        if (!validator.isEmail(email)) {
            return res.json({ success: false, message: "enter a valid email" })
        }

        // validating strong password
        if (password.length < 8) {
            return res.json({ success: false, message: "enter a strong password" })
        }

        // hashing user password
        const salt = await bcrypt.genSalt(10)
        const hashedPassword = await bcrypt.hash(password, salt)

        const userData = {
            name,
            email,
            password: hashedPassword
        }

        const newUser = new userModel(userData)
        const user = await newUser.save()

        const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET)

        res.json({ success: true, token })

    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error.message })
    }
}

// API for user login
const loginUser = async (req, res) => {

    try {

        const { email, password } = req.body
        const user = await userModel.findOne({ email })

        if (!user) {
            return res.json({ success: false, message: 'User does not exist' })
        }

        const isMatch = await bcrypt.compare(password, user.password)

        if (isMatch) {
            const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET)
            res.json({ success: true, token })
        } else {
            res.json({ success: false, message: "Invalid credentials" })
        }

    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error.message })
    }
}

// API to get user profile data
const getProfile = async (req, res) => {

    try {

        // const {userId} = req.body
        const userId = req.userId
        const userData = await userModel.findById(userId).select('-password')

        res.json({ success: true, userData })

    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error.message })
    }
}

// API to update user profile
const updateProfile = async (req, res) => {
    const imageFile = req.file
    try {

        const { name, phone, address, dob, gender } = req.body
        const userId = req.userId

        if (name !== undefined && (!name || !name.trim())) {
            return res.json({ success: false, message: "Name cannot be empty" })
        }

        const updateData = {}

        if (name !== undefined) updateData.name = name.trim()
        if (phone !== undefined) updateData.phone = phone
        if (dob !== undefined) updateData.dob = dob
        if (gender !== undefined) updateData.gender = gender

        if (address !== undefined) {
            let parsedAddress = address
            if (typeof address === 'string') {
                try {
                    parsedAddress = JSON.parse(address)
                } catch (parseError) {
                    return res.json({ success: false, message: "Invalid address format: must be valid JSON" })
                }
            }
            updateData.address = parsedAddress
        }

        if (imageFile) {
            let currentConfig = cloudinary.config()
            if (!currentConfig.cloud_name || !currentConfig.api_key || !currentConfig.api_secret) {
                connectCloudinary()
                currentConfig = cloudinary.config()
            }

            if (!currentConfig.cloud_name || !currentConfig.api_key || !currentConfig.api_secret) {
                console.error("Profile image upload failed: Cloudinary configuration is incomplete on the server.", {
                    hasCloudName: Boolean(currentConfig.cloud_name),
                    hasApiKey: Boolean(currentConfig.api_key),
                    hasApiSecret: Boolean(currentConfig.api_secret),
                    commit: (process.env.RENDER_GIT_COMMIT || 'unknown').slice(0, 7),
                    instance: process.env.RENDER_INSTANCE_ID || 'local'
                })
                return res.json({ success: false, message: "Image upload service is not configured on the server" })
            }

            try {
                // upload image to cloudinary
                const imageUpload = await cloudinary.uploader.upload(imageFile.path, { resource_type: 'image' })
                updateData.image = imageUpload.secure_url
            } catch (uploadError) {
                console.error("Cloudinary upload failed:", uploadError.message || uploadError)
                return res.json({ success: false, message: "Failed to upload image. Please try again." })
            }
        }

        // Single database update avoiding redundant queries and avoiding field overwrite
        await userModel.findByIdAndUpdate(userId, updateData)

        res.json({ success: true, message: "Profile Updated" })

    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error.message })
    } finally {
        if (imageFile && imageFile.path) {
            fs.unlink(imageFile.path, () => {})
        }
    }
}


// API to book appointment
const bookAppointment = async (req, res) => {

    try {

        const { docId, paymentMethod } = req.body
        const userId = req.userId

        // Online payment is mandatory: cash / COD / pay-at-clinic is rejected here,
        // not only hidden in the UI. (A missing method means online.)
        if (paymentMethod !== undefined && paymentMethod !== 'online') {
            return res.json({ success: false, message: "Online payment is required to book an appointment. Cash / pay at clinic is not available." })
        }

        // Canonical slot key, independent of the browser's locale/time format
        const slotDate = canonicalSlotDate(req.body.slotDate)
        const slotTime = canonicalSlotTime(req.body.slotTime)
        if (!slotDate || !slotTime || !isValidSlotInput(slotDate, slotTime) || !/:(00|30) /.test(slotTime)) {
            return res.json({ success: false, message: "Invalid slot" })
        }

        const docData = await doctorModel.findById(docId).select('-password')

        if (!docData) {
            return res.json({ success: false, message: "Doctor not found" })
        }

        if (!docData.available) {
            return res.json({ success: false, message: "Doctor not available" })
        }

        const userData = await userModel.findById(userId).select('-password')

        if (!userData) {
            return res.json({ success: false, message: "User not found. Please log out and register again." })
        }

        // atomically claim the slot (reclaims it if held by an expired online reservation)
        const claim = await claimSlot(docId, slotDate, slotTime)
        if (!claim.ok) {
            return res.json({ success: false, message: "Slot not available" })
        }

        const docDataPlain = docData.toObject()
        delete docDataPlain.slots_booked

        const now = Date.now()
        const appointmentData = {
            userId,
            docId,
            userData,
            docData: docDataPlain,
            amount: docData.fees,
            slotTime,
            slotDate,
            date: now,
            slotLocked: true,
            // created as a reservation only; confirmed solely by verified payment
            paymentMethod: 'online',
            status: 'pending',
            paymentStatus: 'pending',
            reservedAt: new Date(now),
            expiresAt: new Date(now + getReservationMinutes() * 60 * 1000)
        }

        let newAppointment
        try {
            newAppointment = new appointmentModel(appointmentData)
            await newAppointment.save()
        } catch (saveError) {
            // unique index backstop: another live appointment already holds this slot
            if (saveError?.code === 11000) {
                return res.json({ success: false, message: "Slot not available" })
            }
            await releaseSlot(docId, slotDate, slotTime)
            throw saveError
        }

        // create the Razorpay order only after the slot reservation succeeded
        try {
            const order = await createRazorpayOrder(newAppointment)
            await appointmentModel.updateOne({ _id: newAppointment._id, status: 'pending' }, { $set: { razorpayOrderId: order.id } })
            return res.json({
                success: true,
                message: `Slot reserved. Complete payment within ${getReservationMinutes()} minutes.`,
                appointmentId: newAppointment._id,
                expiresAt: newAppointment.expiresAt,
                order
            })
        } catch (orderError) {
            console.log(orderError)
            await failPendingReservation(newAppointment._id)
            return res.json({ success: false, message: "Failed to initiate payment. Please try again." })
        }

    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error.message })
    }
}

// API to get user appointments for frontend my-appointments page
const listAppointment = async (req, res) => {

    try {

        const userId = req.userId
        const appointments = await appointmentModel.find({ userId })

        res.json({ success: true, appointments })

    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error.message })
    }
}

// API to cancel appointment
const cancelAppointment = async (req, res) => {

    try {

        const { appointmentId } = req.body
        const userId = req.userId

        const appointmentData = await appointmentModel.findById(appointmentId)

        if (!appointmentData) {
            return res.json({ success: false, message: "Appointment not found" })
        }

        // verify appointment user
        if (appointmentData.userId.toString() !== userId.toString()) {
            return res.json({ success: false, message: "Unauthorized action" })
        }

        // mark cancelled and release doctor slot (atomic; only releases if this call cancelled it).
        // Paid appointments are refused inside the same atomic update (no refund flow yet).
        const result = await cancelAndReleaseSlot(appointmentId)
        if (result.outcome === 'paid') {
            return res.json({ success: false, message: PAID_CANCELLATION_MESSAGE })
        }

        res.json({ success: true, message: 'Appointment Cancelled' })

    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error.message })
    }
}

// API to make payment of appointment using razorpay
const paymentRazorpay = async (req, res) => {

    try {

        const razorpayInstance = getRazorpay()

        const { appointmentId } = req.body

        const appointmentData = await appointmentModel.findById(appointmentId)

        if (!appointmentData || appointmentData.cancelled) {
            return res.json({ success: false, message: "Appointment Cancelled or not found" })
        }

        // only the owner of the appointment / reservation may pay for it
        if (String(appointmentData.userId) !== String(req.userId)) {
            return res.json({ success: false, message: "Unauthorized action" })
        }

        if (appointmentData.payment) {
            return res.json({ success: false, message: "Appointment is already paid" })
        }

        // online reservation: payment is only allowed while the hold is active
        const isOnlineReservation = appointmentData.paymentMethod === 'online'
        if (isOnlineReservation) {
            if (appointmentData.status !== 'pending' || !appointmentData.expiresAt || appointmentData.expiresAt <= new Date()) {
                return res.json({ success: false, message: "Reservation expired. Please book the slot again." })
            }

            // reuse the existing order so a resumed checkout cannot create a second payable order
            if (appointmentData.razorpayOrderId) {
                const existingOrder = await razorpayInstance.orders.fetch(appointmentData.razorpayOrderId)
                if (existingOrder?.status === 'paid' || existingOrder?.status === 'attempted') {
                    // a captured or authorized payment may already exist: settle it instead of collecting again
                    const result = await settlePaidOrder({ orderId: existingOrder.id })
                    const current = await appointmentModel.findById(appointmentId).select('status').lean()
                    if (existingOrder.status === 'paid' || current?.status !== 'pending') {
                        return res.json({ success: false, message: result.message })
                    }
                }
                if (existingOrder) {
                    return res.json({ success: true, order: existingOrder, expiresAt: appointmentData.expiresAt })
                }
            }
        }

        // creating options for razorpay payment
        const options = {
            amount: appointmentData.amount * 100,
            currency: process.env.CURRENCY,
            receipt: appointmentId,
        }

        // creation of an order
        const order = await razorpayInstance.orders.create(options)

        if (isOnlineReservation) {
            await appointmentModel.updateOne({ _id: appointmentId, status: 'pending' }, { $set: { razorpayOrderId: order.id } })
            return res.json({ success: true, order, expiresAt: appointmentData.expiresAt })
        }

        res.json({ success: true, order })

    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error.message })
    }

}

// API to verify payment of razorpay
const verifyRazorpay = async (req, res) => {

    try {

        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body

        // never trust frontend success alone: verify the checkout signature first
        if (!verifyPaymentSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature)) {
            return res.json({ success: false, message: "Payment verification failed" })
        }

        // order status is fetched from Razorpay; settlement is idempotent
        const result = await settlePaidOrder({ orderId: razorpay_order_id, paymentId: razorpay_payment_id, userId: req.userId })
        res.json(result)

    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error.message })
    }
}

// API called when a Razorpay payment attempt fails (or is rejected) in Checkout.
// A failed attempt is NOT a cancellation: the reservation stays pending and unpaid
// until its ORIGINAL expiresAt, so the user can retry with the same order. Nothing
// here changes status, expiresAt, slotLocked or slots_booked; the slot is released
// only by expiry (cron / reclaim) or by an explicit cancellation.
const reportPaymentFailure = async (req, res) => {

    try {

        const { appointmentId } = req.body
        const userId = req.userId

        const appointmentData = await appointmentModel.findById(appointmentId)

        if (!appointmentData) {
            return res.json({ success: false, message: "Appointment not found" })
        }

        if (appointmentData.userId.toString() !== userId.toString()) {
            return res.json({ success: false, message: "Unauthorized action" })
        }

        if (appointmentData.paymentMethod !== 'online' || appointmentData.status !== 'pending') {
            return res.json({ success: false, message: "No active reservation" })
        }

        // another attempt on the same order may already have succeeded (or be authorized): settle it
        if (appointmentData.razorpayOrderId) {
            const order = await getRazorpay().orders.fetch(appointmentData.razorpayOrderId)
            if (order?.status === 'paid' || order?.status === 'attempted') {
                const result = await settlePaidOrder({ orderId: order.id, userId })
                const current = await appointmentModel.findById(appointmentId).select('status').lean()
                if (current?.status !== 'pending') return res.json(result)
            }
        }

        // record the failed attempt only; never touches the reservation or its deadline
        await appointmentModel.updateOne(
            { _id: appointmentId, status: 'pending' },
            { $set: { lastPaymentFailureAt: new Date() }, $inc: { paymentFailureCount: 1 } }
        )

        const expired = !appointmentData.expiresAt || appointmentData.expiresAt <= new Date()
        res.json({
            success: true,
            message: expired
                ? "Payment failed and the reservation has expired."
                : "Payment failed. Your slot is still reserved, so you can retry before the reservation expires.",
            expiresAt: appointmentData.expiresAt,
            reservationActive: !expired
        })

    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error.message })
    }
}

// Razorpay webhook (payment.captured / order.paid). Configure in the Razorpay dashboard
// with RAZORPAY_WEBHOOK_SECRET. Receives the raw body (see server.js).
const razorpayWebhook = async (req, res) => {

    try {

        const secret = process.env.RAZORPAY_WEBHOOK_SECRET
        if (!secret) {
            return res.status(503).json({ success: false, message: "Webhook not configured" })
        }

        const rawBody = Buffer.isBuffer(req.body) ? req.body : null
        if (!verifyWebhookSignature(rawBody, req.headers['x-razorpay-signature'], secret)) {
            return res.status(400).json({ success: false, message: "Invalid signature" })
        }

        const event = JSON.parse(rawBody.toString('utf8'))

        if (event.event === 'payment.captured' || event.event === 'order.paid') {
            const payment = event.payload?.payment?.entity
            const orderId = payment?.order_id || event.payload?.order?.entity?.id
            if (orderId) {
                await settlePaidOrder({ orderId, paymentId: payment?.id })
            }
        } else if (event.event === 'refund.processed' || event.event === 'refund.failed') {
            // optional: re-sync our refund record (status is re-read from Razorpay, never from the event)
            const refundPaymentId = event.payload?.refund?.entity?.payment_id
            if (refundPaymentId) await syncRefund(refundPaymentId, { ignoreSchedule: true })
        }

        res.json({ success: true })

    } catch (error) {
        console.log(error)
        // non-2xx makes Razorpay retry; settlement is idempotent
        res.status(500).json({ success: false, message: error.message })
    }
}

export { registerUser, loginUser, getProfile, updateProfile, bookAppointment, listAppointment, cancelAppointment, paymentRazorpay, verifyRazorpay, reportPaymentFailure, razorpayWebhook }