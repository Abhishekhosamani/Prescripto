import { useContext, useEffect } from 'react'
import { DoctorContext } from '../../context/DoctorContext'
import { AppContext } from '../../context/AppContext'

const DoctorAppointments = () => {
  const { dToken, appointments, getAppointments, completeAppointment, cancelAppointment } = useContext(DoctorContext)
  const { calculateAge, slotDateFormat, currency } = useContext(AppContext)

  useEffect(() => {
    if (dToken) getAppointments()
  }, [dToken])

  const StatusCell = ({ item }) => {
    if (item.cancelled) return <span className='px-2.5 py-1 rounded-full text-xs font-medium bg-red-50 text-red-500 border border-red-100'>Cancelled</span>
    if (item.isCompleted) return <span className='px-2.5 py-1 rounded-full text-xs font-medium bg-green-50 text-green-600 border border-green-100'>Completed</span>
    return (
      <div className='flex gap-1.5'>
        <button
          onClick={() => cancelAppointment(item._id)}
          className='text-xs px-2.5 py-1 rounded-full border border-red-200 text-red-400 hover:bg-red-50 transition-all'
        >
          Cancel
        </button>
        <button
          onClick={() => completeAppointment(item._id)}
          className='text-xs px-2.5 py-1 rounded-full border border-green-200 text-green-500 hover:bg-green-50 transition-all'
        >
          Done
        </button>
      </div>
    )
  }

  const listed = [...appointments].reverse()

  return (
    <div className='m-6'>
      <div className='mb-5'>
        <h1 className='text-xl font-bold text-gray-800'>My Appointments</h1>
        <p className='text-sm text-gray-400 mt-0.5'>{appointments.length} appointment{appointments.length !== 1 ? 's' : ''} total</p>
      </div>

      <div className='bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden'>
        {/* Table Header */}
        <div className='hidden sm:grid grid-cols-[0.5fr_2fr_0.8fr_0.8fr_2.5fr_1fr_1.5fr] py-3 px-6 bg-gray-50 border-b border-gray-100 text-xs font-semibold text-gray-500 uppercase tracking-wide'>
          <p>#</p>
          <p>Patient</p>
          <p>Payment</p>
          <p>Age</p>
          <p>Date & Time</p>
          <p>Fees</p>
          <p>Action</p>
        </div>

        {listed.length === 0 ? (
          <div className='text-center py-16 text-gray-400'>
            <p className='text-4xl mb-3'>📋</p>
            <p className='font-medium'>No appointments yet</p>
          </div>
        ) : (
          listed.map((item, index) => (
            <div
              key={index}
              className='flex flex-wrap gap-2 sm:grid sm:grid-cols-[0.5fr_2fr_0.8fr_0.8fr_2.5fr_1fr_1.5fr] items-center text-sm text-gray-600 py-3.5 px-6 border-b border-gray-50 hover:bg-indigo-50/30 transition-colors'
            >
              <p className='hidden sm:block text-gray-400 font-medium'>{index + 1}</p>

              <div className='flex items-center gap-2.5'>
                <img className='w-8 h-8 rounded-full object-cover border border-gray-100' src={item.userData.image} alt="" />
                <p className='font-medium text-gray-800 truncate'>{item.userData.name}</p>
              </div>

              {item.status === 'pending' && item.paymentMethod === 'online' && !item.payment ? (
                <span className='text-xs font-medium px-2 py-0.5 rounded-full border w-fit bg-yellow-50 text-yellow-600 border-yellow-200'>
                  Awaiting Payment
                </span>
              ) : (
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full border w-fit ${item.payment ? 'bg-blue-50 text-blue-500 border-blue-100' : 'bg-gray-50 text-gray-500 border-gray-200'}`}>
                  {item.paymentStatus === 'refunded' ? 'Refunded'
                    : ['refund_pending', 'refund_failed'].includes(item.paymentStatus) ? 'Refund pending'
                    : item.payment ? 'Paid Online' : 'Unpaid'}
                </span>
              )}

              <p className='hidden sm:block text-gray-500'>{calculateAge(item.userData.dob)} yrs</p>

              <p className='text-gray-500 text-xs sm:text-sm'>
                {slotDateFormat(item.slotDate)}<br className='sm:hidden' />
                <span className='text-gray-400'> {item.slotTime}</span>
              </p>

              <p className='font-semibold text-gray-800'>{currency}{item.amount}</p>

              <StatusCell item={item} />
            </div>
          ))
        )}
      </div>
    </div>
  )
}

export default DoctorAppointments
