import multer from 'multer'

const storage = multer.diskStorage({
    filename: function(req, file, callback) {
        callback(null, `${Date.now()}-${file.originalname}`)
    }
})

const fileFilter = (req, file, callback) => {
    if (file.mimetype.startsWith('image/')) {
        callback(null, true)
    } else {
        callback(new Error('Only image files are allowed'), false)
    }
}

const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter
})

export default upload