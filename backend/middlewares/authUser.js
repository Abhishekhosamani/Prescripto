import jwt from "jsonwebtoken"
import fs from "fs"

// user authentication middleware
const authUser = async (req, res, next) => {
    try {

         const {token} = req.headers
         if(!token) {
            if (req.file && req.file.path) fs.unlink(req.file.path, () => {})
            return res.json({success:false, message:'Not Authorized Login Again'})
         }
         const token_decode = jwt.verify(token, process.env.JWT_SECRET)
        //  req.body.userId = token_decode.id
         req.userId = token_decode.id
         next()

    } catch (error) {
        if (req.file && req.file.path) fs.unlink(req.file.path, () => {})
        console.log(error)
        res.json({success:false, message:error.message})
    }
}

export default authUser