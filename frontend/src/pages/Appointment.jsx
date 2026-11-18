import React, { useContext, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { AppContext } from '../context/AppContext'
import { assets } from '../assets/assets'
import RelatedDoctors from '../components/RelatedDoctors'
import { toast } from 'react-toastify'
import axios from 'axios'

// Canonical slot time "hh:mm AM", independent of the browser locale (must match the backend).
const formatSlotTime = (date) => {
  const hours = date.getHours()
  const hour12 = hours % 12 === 0 ? 12 : hours % 12
  return `${String(hour12).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`
}

// Normalises older stored spellings ("10:00 am", "10:00\u202fAM", "10:00") for comparison.
const normaliseSlotTime = (value) => {
  const m = String(value).replace(/[\u202f\u00a0]/g, ' ').trim().toLowerCase().match(/^(\d{1,2}):(\d{2})\s*(?:([ap])\.?\s*m\.?)?$/)
  if (!m) return value
  let hours = Number(m[1])
  if (m[3] === 'a' && hours === 12) hours = 0
  if (m[3] === 'p' && hours !== 12) hours += 12
  const date = new Date(2000, 0, 1, hours, Number(m[2]))
  return formatSlotTime(date)
}

const Appointment = () => {
  const { docId } = useParams()
  const { doctors, currencySymbol, backendUrl, token, setToken, getDoctorsData } = useContext(AppContext)
  const daysOfWeek = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']
  const navigate = useNavigate()

  const [docInfo, setDocInfo] = useState(null)
  const [docSlots, setDocSlots] = useState([])
  const [slotIndex, setSlotIndex] = useState(0)
  const [slotTime, setSlotTime] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const fetchDocInfo = async () => {
    const docInfo = doctors.find(doc => doc._id === docId)
    setDocInfo(docInfo)
  }

  const getAvailableSlots = async () => {
    if (!docInfo) return
    setDocSlots([])

    let today = new Date()

    for (let i = 0; i < 7; i++) {
      let currentDate = new Date(today)
      currentDate.setDate(today.getDate() + i)

      let endTime = new Date()
      endTime.setDate(today.getDate() + i)
      endTime.setHours(21, 0, 0, 0)

      if (today.getDate() === currentDate.getDate()) {
        currentDate.setHours(currentDate.getHours() > 10 ? currentDate.getHours() + 1 : 10)
        currentDate.setMinutes(currentDate.getMinutes() > 30 ? 30 : 0)
      } else {
        currentDate.setHours(10)
        currentDate.setMinutes(0)
      }

      let timeSlots = []

      while (currentDate < endTime) {
        let formattedTime = formatSlotTime(currentDate)
        let day = currentDate.getDate()
        let month = currentDate.getMonth() + 1
        let year = currentDate.getFullYear()
        const slotDate = day + "_" + month + "_" + year
        const isSlotAvailable = !(docInfo.slots_booked?.[slotDate]?.some(t => normaliseSlotTime(t) === formattedTime))

        if (isSlotAvailable) {
          timeSlots.push({ dateTime: new Date(currentDate), time: formattedTime })
        }

        currentDate.setMinutes(currentDate.getMinutes() + 30)
      }

      setDocSlots(prev => ([...prev, timeSlots]))
    }
  }

  // Opens Razorpay for a slot reserved by "Book & Pay Online"
  const openReservationCheckout = (order, appointmentId, expiresAt) => {
    if (!window.Razorpay) {
      toast.error('Payment gateway not loaded. Please refresh the page.')
      return navigate('/my-appointments')
    }
    const secondsLeft = Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000)
    const options = {
      key: import.meta.env.VITE_RAZORPAY_KEY_ID,
      amount: order.amount,
      currency: order.currency,
      name: 'Appointment Payment',
      description: 'Appointment Payment',
      order_id: order.id,
      receipt: order.receipt,
      ...(secondsLeft > 0 ? { timeout: secondsLeft } : {}),
      handler: async (response) => {
        try {
          const { data } = await axios.post(backendUrl + '/api/user/verifyRazorpay', response, { headers: { token } })
          data.success ? toast.success('Appointment Booked') : toast.error(data.message)
        } catch (error) {
          console.log(error)
          toast.error(error.message)
        }
        getDoctorsData()
        navigate('/my-appointments')
      },
      modal: {
        ondismiss: () => {
          toast.info('Slot reserved. Complete payment from My Appointments before the reservation expires.')
          navigate('/my-appointments')
        }
      }
    }
    const rzp = new window.Razorpay(options)
    // A failed/rejected attempt does NOT end the reservation: Checkout stays open for a
    // retry, and the slot is held until the original expiry. The backend only records it.
    rzp.on('payment.failed', () => {
      const until = new Date(expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      toast.warn(`Payment failed. Your slot is held until ${until} — you can retry.`)
      axios.post(backendUrl + '/api/user/payment-failed', { appointmentId }, { headers: { token } }).catch(error => console.log(error))
    })
    rzp.open()
  }

  // Online payment is mandatory: booking reserves the slot and opens Razorpay.
  const bookAppointment = async () => {
    if (!token) {
      toast.warn('Login to book appointment')
      return navigate('/login')
    }

    if (!slotTime) {
      return toast.warn('Please select a time slot')
    }

    if (!docId.match(/^[a-f\d]{24}$/i)) {
      return toast.warn('Backend not connected. Add real doctors via the admin panel to enable booking.')
    }

    if (!docSlots[slotIndex] || !docSlots[slotIndex][0]) {
      return toast.warn('No slots available for the selected day')
    }

    if (isSubmitting) return
    setIsSubmitting(true)

    try {
      const date = docSlots[slotIndex][0].dateTime
      let day = date.getDate()
      let month = date.getMonth() + 1
      let year = date.getFullYear()
      const slotDate = day + "_" + month + "_" + year

      const payload = { docId, slotDate, slotTime, paymentMethod: 'online' }
      const { data } = await axios.post(backendUrl + '/api/user/book-appointment', payload, { headers: { token } })
      if (data.success) {
        toast.success(data.message)
        openReservationCheckout(data.order, data.appointmentId, data.expiresAt)
      } else {
        toast.error(data.message)
        if (data.message && data.message.toLowerCase().includes('user not found')) {
          localStorage.removeItem('token')
          setToken(false)
          navigate('/login')
        }
      }
    } catch (error) {
      console.log(error)
      toast.error(error.message)
    } finally {
      setIsSubmitting(false)
    }
  }

  useEffect(() => { fetchDocInfo() }, [doctors, docId])
  useEffect(() => { getAvailableSlots() }, [docInfo])

  return docInfo && (
    <div>
      {/* Doctor Details */}
      <div className='flex flex-col sm:flex-row gap-5'>
        <div className='flex-shrink-0'>
          <img className='bg-primary w-full sm:w-72 rounded-2xl object-cover object-top' src={docInfo.image} alt={docInfo.name} />
        </div>

        <div className='flex-1 border border-gray-100 rounded-2xl p-6 bg-white shadow-sm'>
          {/* Name & Degree */}
          <div className='flex items-center gap-2'>
            <p className='text-2xl font-semibold text-gray-900'>{docInfo.name}</p>
            <img className='w-5' src={assets.verified_icon} alt="verified" />
          </div>

          <div className='flex items-center gap-2 mt-1 text-sm text-gray-500'>
            <p>{docInfo.degree} — {docInfo.speciality}</p>
            <span className='px-2 py-0.5 border border-gray-200 rounded-full text-xs text-gray-500'>{docInfo.experience}</span>
          </div>

          {/* About */}
          <div className='mt-4'>
            <p className='flex items-center gap-1 text-sm font-semibold text-gray-800'>
              About <img className='w-4' src={assets.info_icon} alt="" />
            </p>
            <p className='text-sm text-gray-500 max-w-[700px] mt-1 leading-relaxed'>{docInfo.about}</p>
          </div>

          {/* Fee */}
          <div className='mt-4 inline-flex items-center gap-2 bg-blue-50 text-primary px-4 py-2 rounded-full text-sm font-medium'>
            <span>Appointment fee:</span>
            <span className='font-semibold'>{currencySymbol} {docInfo.fees}</span>
          </div>
        </div>
      </div>

      {/* Booking Slots */}
      <div className='mt-8 bg-white border border-gray-100 rounded-2xl p-6 shadow-sm sm:ml-0'>
        <p className='font-semibold text-gray-800 mb-4'>Select a Slot</p>

        {/* Day Picker */}
        <div className='flex gap-3 overflow-x-auto pb-2'>
          {docSlots.map((item, index) => item[0] && (
            <button
              key={index}
              onClick={() => { setSlotIndex(index); setSlotTime('') }}
              className={`flex flex-col items-center py-3 px-4 min-w-[64px] rounded-xl border transition-all duration-200 ${
                slotIndex === index
                  ? 'bg-primary text-white border-primary shadow-md'
                  : 'border-gray-200 text-gray-600 hover:border-primary hover:text-primary'
              }`}
            >
              <span className='text-xs font-medium'>{daysOfWeek[item[0].dateTime.getDay()]}</span>
              <span className='text-lg font-bold leading-none mt-1'>{item[0].dateTime.getDate()}</span>
            </button>
          ))}
        </div>

        {/* Time Picker */}
        <div className='flex flex-wrap gap-2 mt-4'>
          {docSlots[slotIndex]?.length > 0 ? docSlots[slotIndex].map((item, index) => (
            <button
              key={index}
              onClick={() => setSlotTime(item.time)}
              className={`text-xs font-medium px-4 py-2 rounded-full border transition-all duration-200 ${
                item.time === slotTime
                  ? 'bg-primary text-white border-primary shadow-sm'
                  : 'border-gray-200 text-gray-500 hover:border-primary hover:text-primary'
              }`}
            >
              {item.time.toLowerCase()}
            </button>
          )) : (
            <p className='text-sm text-gray-400'>No available slots for this day</p>
          )}
        </div>

        {/* Book Button */}
        <button
          onClick={bookAppointment}
          disabled={isSubmitting}
          className='mt-6 bg-primary text-white text-sm font-medium px-10 py-3 rounded-full hover:opacity-90 hover:shadow-lg transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed'
        >
          {isSubmitting ? 'Reserving slot...' : 'Book & Pay Online'}
        </button>
      </div>

      {/* Related Doctors */}
      <RelatedDoctors docId={docId} speciality={docInfo.speciality} />
    </div>
  )
}

export default Appointment
