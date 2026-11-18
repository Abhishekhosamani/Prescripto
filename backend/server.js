import express from 'express'
import cors from 'cors'
import 'dotenv/config'
import connectDB from './config/mongodb.js'
import connectCloudinary, { cloudinary } from './config/cloudinary.js'
import adminRouter from './routes/adminRoute.js'
import doctorRouter from './routes/doctorRoute.js'
import userRouter from './routes/userRoute.js'
import chatbotRouter from './routes/chatbotRoute.js'
import { razorpayWebhook } from './controllers/userController.js'
import startReservationCleanup from './jobs/reservationCleanup.js'
import { ensureRequiredIndexes } from './config/indexes.js'
import { isProduction } from './config/environment.js'

// app config
const app = express()
const port = process.env.PORT || 4000

// CORS configuration
// Local development origins (Vite dev servers) are allowed only outside production.
const localOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175'
]
const productionDefaultOrigins = [
  'https://prescripto-1-sw58.onrender.com',
  'https://prescripto-admin-fjj8.onrender.com'
]
const production = isProduction()
const defaultOrigins = production ? productionDefaultOrigins : [...localOrigins, ...productionDefaultOrigins]

// ALLOWED_ORIGINS: comma-separated list of extra allowed origins (e.g. the production
// frontend and admin URLs). "*" (any origin) is honoured only outside production.
const envOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim().replace(/\/$/, '')).filter(o => o && o !== '*')
  : []
const wildcardRequested = (process.env.ALLOWED_ORIGINS || '').split(',').some(o => o.trim() === '*')
const allowAnyOrigin = process.env.ALLOWED_ORIGINS?.trim() === '*' && !production
if (production && wildcardRequested) {
  console.warn('ALLOWED_ORIGINS="*" is ignored in production; list the frontend and admin URLs explicitly.')
}
if (production && envOrigins.length === 0) {
  console.warn('ALLOWED_ORIGINS is not set in production; only the built-in production origins are allowed.')
}

const allowedOrigins = Array.from(new Set([...defaultOrigins, ...envOrigins]))

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g. mobile apps, curl, server-to-server, Render health checks)
    if (!origin) return callback(null, true);

    const normalizedOrigin = origin.replace(/\/$/, '');
    if (allowedOrigins.includes(normalizedOrigin) || allowAnyOrigin) {
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

// Razorpay webhook needs the raw body for signature verification, so it is
// registered before express.json()
app.post('/api/user/razorpay-webhook', express.raw({ type: 'application/json' }), razorpayWebhook)

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
  const c = cloudinary.config()
  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    commit: (process.env.RENDER_GIT_COMMIT || 'unknown').slice(0, 7),
    instance: process.env.RENDER_INSTANCE_ID || 'local',
    cloudinaryConfigured: Boolean(c.cloud_name && c.api_key && c.api_secret)
  })
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
  } catch (error) {
    console.error("Server startup aborted due to database connection error:", error.message)
    process.exit(1)
  }

  // Booking, payment and refund safety depends on these indexes: verify them
  // before accepting any request or starting background jobs.
  try {
    await ensureRequiredIndexes()
  } catch (error) {
    console.error("Server startup aborted: required database indexes could not be created or verified.\n" + error.message)
    process.exit(1)
  }

  startReservationCleanup()
  app.listen(port, () => console.log("Server Started", port))
}

startServer()