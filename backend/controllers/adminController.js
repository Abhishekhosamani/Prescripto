import validator from "validator"
import bcrypt from "bcrypt"
import { cloudinary, connectCloudinary } from "../config/cloudinary.js"
import doctorModel from "../models/doctorModel.js"
import jwt from "jsonwebtoken"
import appointmentModel from "../models/appointmentModel.js"
import userModel from "../models/userModel.js"
import fs from "fs"



// API for adding doctor 
const addDoctor = async (req, res) => {
    const imageFile = req.file
    try{

        const {name, email, password, speciality, degree, experience, about, fees, address} = req.body

        // checking for all data to add doctor
        if(!name || !email || !password || !speciality || !degree || !experience || !about || !fees || !address || !imageFile) {
            return res.json({success:false, message:"Missing Details"})
        }

        // validating email format
        if(!validator.isEmail(email)) {
            return res.json({success:false, message:"Please enter a valid email"})
        }

        // checking existing doctor
        const existingDoc = await doctorModel.findOne({ email })
        if (existingDoc) {
            return res.json({ success: false, message: "Doctor with this email already exists" })
        }

        // validating strong password
        if(password.length < 8) {
            return res.json({success:false, message:"Please enter a strong password"})
        }

        // hashing doctor password
        const salt = await bcrypt.genSalt(10)
        const hashedPassword = await bcrypt.hash(password, salt)

        let currentConfig = cloudinary.config()
        if (!currentConfig.cloud_name || !currentConfig.api_key || !currentConfig.api_secret) {
            connectCloudinary()
            currentConfig = cloudinary.config()
        }

        if (!currentConfig.cloud_name || !currentConfig.api_key || !currentConfig.api_secret) {
            console.error("Doctor image upload failed: Cloudinary configuration is incomplete on the server.", {
                hasCloudName: Boolean(currentConfig.cloud_name),
                hasApiKey: Boolean(currentConfig.api_key),
                hasApiSecret: Boolean(currentConfig.api_secret)
            })
            return res.json({ success: false, message: "Image upload service is not configured on the server" })
        }

        let imageUrl
        try {
            // upload image to cloudinary
            const imageUpload = await cloudinary.uploader.upload(imageFile.path, {resource_type:"image"})
            imageUrl = imageUpload.secure_url
        } catch (uploadError) {
            console.error("Cloudinary upload failed:", uploadError.message || uploadError)
            return res.json({ success: false, message: "Failed to upload doctor image. Please try again." })
        }

        const doctorData = {
            name,
            email,
            image:imageUrl,
            password:hashedPassword,
            speciality,
            degree,
            experience,
            about,
            fees,
            address:JSON.parse(address),
            date:Date.now()
        }

        const newDoctor = new doctorModel(doctorData)
        await newDoctor.save()

        res.json({success:true, message:"Doctor Added"})

    } catch (error) {
        console.log(error)
        res.json({success:false, message:error.message})
    } finally {
        if (imageFile && imageFile.path) {
            fs.unlink(imageFile.path, () => {})
        }
    }
}

// API For admin Login
const loginAdmin = async (req, res) => {
    try {
        const {email, password} = req.body
        
        if(email === process.env.ADMIN_EMAIL && password === process.env.ADMIN_PASSWORD) {

            const token = jwt.sign(email+password, process.env.JWT_SECRET)
            res.json({success:true, token})

        } else {
            res.json({success:false, message:"Invalid credentials"})
        }

    } catch (error) {
        console.log(error)
        res.json({success:false, message:error.message})
    }
}

// API to get all doctors list for admin panel
const allDoctors = async (req, res) => {
    try {

        const doctors = await doctorModel.find({}).select('-password')
        res.json({success:true, doctors})

    } catch (error) {
        console.log(error)
        res.json({success:false, message:error.message})
    }
}

// API to get all appointments list
const appointmentsAdmin = async(req, res) => {

    try {

        const appointments = await appointmentModel.find({})
        res.json({success: true, appointments})
        
    } catch (error) {
        console.log(error)
        res.json({success:false, message:error.message})
    }
}

// API for appointment cancellation
const appointmentCancel = async (req, res) => {

    try {

        const { appointmentId } = req.body

        const appointmentData = await appointmentModel.findById(appointmentId)

        await appointmentModel.findByIdAndUpdate(appointmentId, { cancelled: true })

        // releasing doctor slot

        const { docId, slotDate, slotTime } = appointmentData

        const doctorData = await doctorModel.findById(docId)

        let slots_booked = doctorData.slots_booked

        slots_booked[slotDate] = slots_booked[slotDate].filter(e => e !== slotTime)

        await doctorModel.findByIdAndUpdate(docId, { slots_booked })

        res.json({ success: true, message: 'Appointment Cancelled' })

    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error.message })
    }
}

// API to get dashboard data for admin panel
const adminDashboard = async (req, res) => {
    
    try {

        const [doctorsCount, usersCount, appointmentsCount, latestAppointments] = await Promise.all([
            doctorModel.countDocuments(),
            userModel.countDocuments(),
            appointmentModel.countDocuments(),
            appointmentModel.find({}).sort({ date: -1 }).limit(5)
        ])

        const dashData = {
            doctors: doctorsCount,
            appointments: appointmentsCount,
            patients: usersCount,
            latestAppointments
        }

        res.json({success: true, dashData})

    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error.message })
    }
}

export {addDoctor, loginAdmin, allDoctors, appointmentsAdmin, appointmentCancel, adminDashboard}