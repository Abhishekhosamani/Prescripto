import validator from 'validator'
import bcrypt from 'bcrypt'
import userModel from '../models/userModel.js'
import jwt from 'jsonwebtoken'
import { cloudinary, connectCloudinary } from '../config/cloudinary.js'
import doctorModel from '../models/doctorModel.js'
import appointmentModel from '../models/appointmentModel.js'
import razorpay from 'razorpay'
import fs from 'fs'

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
                    hasApiSecret: Boolean(currentConfig.api_secret)
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

        const { docId, slotDate, slotTime } = req.body
        const userId = req.userId

        const docData = await doctorModel.findById(docId).select('-password')

        if (!docData) {
            return res.json({ success: false, message: "Doctor not found" })
        }

        if (!docData.available) {
            return res.json({ success: false, message: "Doctor not available" })
        }

        let slots_booked = docData.slots_booked

        // checking for slot availability
        if (slots_booked[slotDate]) {
            if (slots_booked[slotDate].includes(slotTime)) {
                return res.json({ success: false, message: "Slot not available" })
            } else {
                slots_booked[slotDate].push(slotTime)
            }
        } else {
            slots_booked[slotDate] = []
            slots_booked[slotDate].push(slotTime)
        }

        const userData = await userModel.findById(userId).select('-password')

        if (!userData) {
            return res.json({ success: false, message: "User not found. Please log out and register again." })
        }

        const docDataPlain = docData.toObject()
        delete docDataPlain.slots_booked

        const appointmentData = {
            userId,
            docId,
            userData,
            docData: docDataPlain,
            amount: docData.fees,
            slotTime,
            slotDate,
            date: Date.now()
        }

        const newAppointment = new appointmentModel(appointmentData)
        await newAppointment.save()

        // save new slots data in docData
        await doctorModel.findByIdAndUpdate(docId, { slots_booked })

        res.json({ success: true, message: 'Appointment Booked' })

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

        await appointmentModel.findByIdAndUpdate(appointmentId, { cancelled: true })

        // releasing doctor slot
        const { docId, slotDate, slotTime } = appointmentData

        const doctorData = await doctorModel.findById(docId)

        if (doctorData && doctorData.slots_booked && doctorData.slots_booked[slotDate]) {
            let slots_booked = doctorData.slots_booked
            slots_booked[slotDate] = slots_booked[slotDate].filter(e => e !== slotTime)
            await doctorModel.findByIdAndUpdate(docId, { slots_booked })
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

        const razorpayInstance = new razorpay({
            key_id: process.env.RAZORPAY_KEY_ID,
            key_secret: process.env.RAZORPAY_KEY_SECRET
        })

        const { appointmentId } = req.body

        const appointmentData = await appointmentModel.findById(appointmentId)

        if (!appointmentData || appointmentData.cancelled) {
            return res.json({ success: false, message: "Appointment Cancelled or not found" })
        }

        // creating options for razorpay payment
        const options = {
            amount: appointmentData.amount * 100,
            currency: process.env.CURRENCY,
            receipt: appointmentId,
        }

        // creation of an order
        const order = await razorpayInstance.orders.create(options)

        res.json({ success: true, order })

    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error.message })
    }

}

// API to verify payment of razorpay
const verifyRazorpay = async (req, res) => {

    try {

        const razorpayInstance = new razorpay({
            key_id: process.env.RAZORPAY_KEY_ID,
            key_secret: process.env.RAZORPAY_KEY_SECRET
        })

        const {razorpay_order_id} = req.body
        const orderInfo = await razorpayInstance.orders.fetch(razorpay_order_id)

        if (orderInfo.status === 'paid') {
            await appointmentModel.findByIdAndUpdate(orderInfo.receipt, {payment: true})
            res.json({success:true, message: "Payment Successful"})
        } else {
            res.json({success:false, message: "Payment failed"})
        }

    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error.message })
    }
}

export { registerUser, loginUser, getProfile, updateProfile, bookAppointment, listAppointment, cancelAppointment, paymentRazorpay, verifyRazorpay }