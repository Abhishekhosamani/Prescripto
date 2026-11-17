import React, { useContext, useEffect, useState } from 'react'
import { AppContext } from '../context/AppContext'
import axios from 'axios'
import { toast } from 'react-toastify'
import { useNavigate } from 'react-router-dom'

const MyAppointments = () => {
  const { backendUrl, token, getDoctorsData } = useContext(AppContext)
  const [appointments, setAppointments] = useState([])
  const [cancellingId, setCancellingId] = useState(null)
  const [payingId, setPayingId] = useState(null)
  const months = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  const navigate = useNavigate()

  const slotDateFormat = (slotDate) => {
    const dateArray = slotDate.split('_')
    return dateArray[0] + " " + months[Number(dateArray[1])] + " " + dateArray[2]
  }

  const getUserAppointments = async () => {
    try {
      const { data } = await axios.get(backendUrl + '/api/user/appointments', { headers: { token } })
      if (data.success) {
        setAppointments(data.appointments.reverse())
      }
    } catch (error) {
      console.log(error)
      toast.error(error.message)
    }
  }

  const cancelAppointment = async (appointmentId) => {
    if (cancellingId) return
    setCancellingId(appointmentId)
    try {
      const { data } = await axios.post(backendUrl + '/api/user/cancel-appointment', { appointmentId }, { headers: { token } })
      if (data.success) {
        toast.success(data.message)
        getUserAppointments()
        getDoctorsData()
      } else {
        toast.error(data.message)
      }
    } catch (error) {
      console.log(error)
      toast.error(error.message)
    } finally {
      setCancellingId(null)
    }
  }

  const initPay = (order) => {
    const options = {
      key: import.meta.env.VITE_RAZORPAY_KEY_ID,
      amount: order.amount,
      currency: order.currency,
      name: 'Appointment Payment',
      description: 'Appointment Payment',
      order_id: order.id,
      receipt: order.receipt,
      handler: async (response) => {
        try {
          const { data } = await axios.post(backendUrl + '/api/user/verifyRazorpay', response, { headers: { token } })
          if (data.success) {
            getUserAppointments()
            navigate('/my-appointments')
          }
        } catch (error) {
          console.log(error)
          toast.error(error.message)
        }
      }
    }
    if (!window.Razorpay) {
      return toast.error('Payment gateway not loaded. Please refresh the page.')
    }
    const rzp = new window.Razorpay(options)
    rzp.open()
  }

  const appointmentRazorpay = async (appointmentId) => {
    if (payingId) return
    setPayingId(appointmentId)
    try {
      const { data } = await axios.post(backendUrl + '/api/user/payment-razorpay', { appointmentId }, { headers: { token } })
      if (data.success) {
        initPay(data.order)
      }
    } catch (error) {
      console.log(error)
      toast.error(error.message || 'Failed to initiate payment')
    } finally {
      setPayingId(null)
    }
  }

  useEffect(() => {
    if (token) {
      getUserAppointments()
    }
  }, [token])

  const StatusBadge = ({ item }) => {
    if (item.isCompleted) return <span className='px-3 py-1 rounded-full text-xs font-medium bg-green-50 text-green-600 border border-green-200'>Completed</span>
    if (item.cancelled) return <span className='px-3 py-1 rounded-full text-xs font-medium bg-red-50 text-red-500 border border-red-200'>Cancelled</span>
    if (item.payment) return <span className='px-3 py-1 rounded-full text-xs font-medium bg-blue-50 text-blue-500 border border-blue-200'>Paid</span>
    return <span className='px-3 py-1 rounded-full text-xs font-medium bg-yellow-50 text-yellow-600 border border-yellow-200'>Pending Payment</span>
  }

  return (
    <div className='max-w-3xl'>
      <p className='pb-4 mt-8 text-lg font-semibold text-gray-800 border-b border-gray-200'>My Appointments</p>

      {appointments.length === 0 && (
        <div className='text-center py-16 text-gray-400'>
          <p className='text-5xl mb-4'>📅</p>
          <p className='text-base font-medium'>No appointments yet</p>
          <p className='text-sm mt-1'>Book a doctor to get started</p>
        </div>
      )}

      <div className='flex flex-col gap-4 mt-4'>
        {appointments.map((item, index) => (
          <div
            key={index}
            className='flex flex-col sm:flex-row gap-4 p-4 border border-gray-100 rounded-2xl bg-white shadow-sm hover:shadow-md transition-shadow duration-200'
          >
            {/* Doctor Image */}
            <img
              className='w-28 h-28 rounded-xl object-cover object-top bg-indigo-50 flex-shrink-0'
              src={item.docData?.image}
              alt={item.docData?.name}
            />

            {/* Info */}
            <div className='flex-1 min-w-0'>
              <div className='flex items-start justify-between gap-2 flex-wrap'>
                <div>
                  <p className='font-semibold text-gray-800 text-base'>{item.docData?.name}</p>
                  <p className='text-sm text-primary mt-0.5'>{item.docData?.speciality}</p>
                </div>
                <StatusBadge item={item} />
              </div>

              <div className='mt-3 flex flex-col gap-1 text-xs text-gray-500'>
                <p>📍 {item.docData?.address?.line1}{item.docData?.address?.line2 ? `, ${item.docData.address.line2}` : ''}</p>
                <p>🗓 {slotDateFormat(item.slotDate)} &nbsp;|&nbsp; 🕐 {item.slotTime}</p>
              </div>

              {/* Action Buttons */}
              <div className='flex flex-wrap gap-2 mt-4'>
                {!item.cancelled && !item.payment && !item.isCompleted && (
                  <button
                    onClick={() => appointmentRazorpay(item._id)}
                    disabled={payingId === item._id}
                    className='text-xs font-medium px-5 py-2 rounded-full border border-primary text-primary hover:bg-primary hover:text-white transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed'
                  >
                    {payingId === item._id ? 'Processing...' : 'Pay Online'}
                  </button>
                )}
                {!item.cancelled && !item.isCompleted && (
                  <button
                    onClick={() => cancelAppointment(item._id)}
                    disabled={cancellingId === item._id}
                    className='text-xs font-medium px-5 py-2 rounded-full border border-gray-200 text-gray-500 hover:border-red-400 hover:text-red-500 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed'
                  >
                    {cancellingId === item._id ? 'Cancelling...' : 'Cancel'}
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default MyAppointments
