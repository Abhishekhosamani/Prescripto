import React, { useContext, useEffect } from 'react'
import { AdminContext } from '../../context/AdminContext'
import { AppContext } from '../../context/AppContext'
import { canCancelAppointment, PAID_CANCELLATION_NOTICE } from '../../utils/appointmentRules'

const AllAppointments = () => {
  const { aToken, appointments, getAllAppointments, cancelAppointment } = useContext(AdminContext)
  const { calculateAge, slotDateFormat, currency } = useContext(AppContext)

  useEffect(() => {
    if (aToken) getAllAppointments()
  }, [aToken])

  const StatusBadge = ({ item }) => {
    if (item.cancelled) return <span className='px-2.5 py-1 rounded-full text-xs font-medium bg-red-50 text-red-500 border border-red-100'>Cancelled</span>
    if (item.isCompleted) return <span className='px-2.5 py-1 rounded-full text-xs font-medium bg-green-50 text-green-600 border border-green-100'>Completed</span>
    // paid appointments cannot be cancelled in the app (no refund flow yet)
    if (!canCancelAppointment(item)) return (
      <span title={PAID_CANCELLATION_NOTICE} className='px-2.5 py-1 rounded-full text-xs font-medium bg-blue-50 text-blue-500 border border-blue-100 cursor-help'>
        Paid · no cancel
      </span>
    )
    if (item.status === 'pending' && item.paymentMethod === 'online' && !item.payment) return (
      <div className='flex items-center gap-1.5'>
        <span className='px-2.5 py-1 rounded-full text-xs font-medium bg-yellow-50 text-yellow-600 border border-yellow-200'>Awaiting Payment</span>
        <button
          onClick={() => cancelAppointment(item._id)}
          className='px-2.5 py-1 rounded-full text-xs font-medium bg-gray-50 text-gray-500 border border-gray-200 hover:bg-red-50 hover:text-red-500 hover:border-red-200 transition-all'
        >
          Cancel
        </button>
      </div>
    )
    return (
      <button
        onClick={() => cancelAppointment(item._id)}
        className='px-2.5 py-1 rounded-full text-xs font-medium bg-gray-50 text-gray-500 border border-gray-200 hover:bg-red-50 hover:text-red-500 hover:border-red-200 transition-all'
      >
        Cancel
      </button>
    )
  }

  return (
    <div className='m-6'>
      <div className='mb-5'>
        <h1 className='text-xl font-bold text-gray-800'>All Appointments</h1>
        <p className='text-sm text-gray-400 mt-0.5'>{appointments.length} appointment{appointments.length !== 1 ? 's' : ''} total</p>
      </div>

      <div className='bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden'>
        {/* Table Header */}
        <div className='hidden sm:grid grid-cols-[0.5fr_2.5fr_0.8fr_2.5fr_2.5fr_1fr_1.2fr] py-3 px-6 bg-gray-50 border-b border-gray-100 text-xs font-semibold text-gray-500 uppercase tracking-wide'>
          <p>#</p>
          <p>Patient</p>
          <p>Age</p>
          <p>Date & Time</p>
          <p>Doctor</p>
          <p>Fees</p>
          <p>Status</p>
        </div>

        {appointments.length === 0 ? (
          <div className='text-center py-16 text-gray-400'>
            <p className='text-4xl mb-3'>📅</p>
            <p className='font-medium'>No appointments yet</p>
          </div>
        ) : (
          appointments.map((item, index) => (
            <div
              key={index}
              className='flex flex-wrap gap-2 sm:grid sm:grid-cols-[0.5fr_2.5fr_0.8fr_2.5fr_2.5fr_1fr_1.2fr] items-center text-sm text-gray-600 py-3.5 px-6 border-b border-gray-50 hover:bg-indigo-50/30 transition-colors'
            >
              <p className='hidden sm:block text-gray-400 font-medium'>{index + 1}</p>

              <div className='flex items-center gap-2.5'>
                <img className='w-8 h-8 rounded-full object-cover border border-gray-100' src={item.userData.image} alt="" />
                <p className='font-medium text-gray-800 truncate'>{item.userData.name}</p>
              </div>

              <p className='hidden sm:block text-gray-500'>{calculateAge(item.userData.dob)} yrs</p>

              <p className='text-gray-500 text-xs sm:text-sm'>
                {slotDateFormat(item.slotDate)}<br className='sm:hidden' />
                <span className='text-gray-400'> {item.slotTime}</span>
              </p>

              <div className='flex items-center gap-2.5'>
                <img className='w-8 h-8 rounded-full object-cover bg-gray-100 border border-gray-100' src={item.docData.image} alt="" />
                <p className='font-medium text-gray-700 truncate'>{item.docData.name}</p>
              </div>

              <p className='font-semibold text-gray-800'>
                {currency}{item.amount}
                <span className={`block text-xs font-normal ${item.payment ? 'text-blue-500' : 'text-gray-400'}`}>
                  {item.paymentStatus === 'refunded' ? 'Refunded'
                    : ['refund_pending', 'refund_failed'].includes(item.paymentStatus) ? 'Refund pending'
                    : item.payment ? 'Paid Online' : 'Unpaid'}
                </span>
              </p>

              <StatusBadge item={item} />
            </div>
          ))
        )}
      </div>
    </div>
  )
}

export default AllAppointments
