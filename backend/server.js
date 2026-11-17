import express from 'express'
import cors from 'cors'
import 'dotenv/config'
import connectDB from './config/mongodb.js'
import connectCloudinary from './config/cloudinary.js'
import adminRouter from './routes/adminRoute.js'
import doctorRouter from './routes/doctorRoute.js'
import userRouter from './routes/userRoute.js'
import chatbotRouter from './routes/chatbotRoute.js'

// app config
const app = express()
const port = process.env.PORT || 4000

// CORS configuration
const defaultOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'https://prescripto-1-sw58.onrender.com',
  'https://prescripto-admin-fjj8.onrender.com'
]

const envOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim().replace(/\/$/, '')).filter(Boolean)
  : []

const allowedOrigins = Array.from(new Set([...defaultOrigins, ...envOrigins]))

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g. mobile apps, curl, server-to-server, Render health checks)
    if (!origin) return callback(null, true);

    const normalizedOrigin = origin.replace(/\/$/, '');
    if (allowedOrigins.includes(normalizedOrigin) || process.env.ALLOWED_ORIGINS === '*') {
      return callback(null, true);
    }

    const isAllowed = allowedOrigins.some(o => o.toLowerCase() === normalizedOrigin.toLowerCase());
    if (isAllowed) {
      return callback(null, true);
    }

    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'token', 'aToken', 'dToken']
}))

// middlewares
app.use(express.json())

// api endpoints
app.use('/api/admin', adminRouter)
app.use('/api/doctor', doctorRouter)
app.use('/api/user', userRouter)
app.use('/api/chatbot', chatbotRouter)

// health check endpoints
app.get('/', (req, res) => {
  res.send('API WORKING')
})

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() })
})

// global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled Server Error:', err)
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal Server Error'
  })
})

const startServer = async () => {
  try {
    connectCloudinary()
    await connectDB()
    app.listen(port, () => console.log("Server Started", port))
  } catch (error) {
    console.error("Server startup aborted due to database connection error:", error.message)
    process.exit(1)
  }
}

startServer()