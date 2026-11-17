import { v2 as cloudinary } from 'cloudinary'
import 'dotenv/config'

const configureCloudinary = () => {
    const cloudName = process.env.CLOUDINARY_NAME || process.env.CLOUDINARY_CLOUD_NAME
    const apiKey = process.env.CLOUDINARY_API_KEY
    const apiSecret = process.env.CLOUDINARY_SECRET_KEY || process.env.CLOUDINARY_API_SECRET

    const configObj = { secure: true }
    if (cloudName) configObj.cloud_name = cloudName
    if (apiKey) configObj.api_key = apiKey
    if (apiSecret) configObj.api_secret = apiSecret

    cloudinary.config(configObj)

    const currentConfig = cloudinary.config()
    return Boolean(currentConfig.cloud_name && currentConfig.api_key && currentConfig.api_secret)
}

// Ensure Cloudinary is configured as soon as this module is imported
configureCloudinary()

const connectCloudinary = () => {
    const isConfigured = configureCloudinary()
    const currentConfig = cloudinary.config()

    if (isConfigured) {
        console.log(`Cloudinary configured successfully (cloud_name: "${currentConfig.cloud_name}")`)
    } else {
        const missing = []
        if (!currentConfig.cloud_name) missing.push('CLOUDINARY_NAME / CLOUDINARY_CLOUD_NAME')
        if (!currentConfig.api_key) missing.push('CLOUDINARY_API_KEY')
        if (!currentConfig.api_secret) missing.push('CLOUDINARY_SECRET_KEY / CLOUDINARY_API_SECRET')
        console.warn(`[WARNING] Cloudinary configuration incomplete. Missing: ${missing.join(', ')}. Image uploads will fail until configured.`)
    }

    return isConfigured
}

export { cloudinary, connectCloudinary }
export default connectCloudinary