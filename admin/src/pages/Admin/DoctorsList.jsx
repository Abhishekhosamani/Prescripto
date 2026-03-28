import React, { useContext, useEffect } from 'react'
import { AdminContext } from '../../context/AdminContext'
import { useNavigate } from 'react-router-dom'

const DoctorsList = () => {
  const { doctors, aToken, getAllDoctors, changeAvailability } = useContext(AdminContext)
  const navigate = useNavigate()

  useEffect(() => {
    if (aToken) getAllDoctors()
  }, [aToken])

  return (
    <div className='m-6'>
      <div className='flex items-center justify-between mb-6'>
        <div>
          <h1 className='text-xl font-bold text-gray-800'>Doctors List</h1>
          <p className='text-sm text-gray-400 mt-0.5'>{doctors.length} doctor{doctors.length !== 1 ? 's' : ''} registered</p>
        </div>
        <button
          onClick={() => navigate('/add-doctor')}
          className='bg-primary text-white text-sm font-medium px-5 py-2.5 rounded-xl hover:bg-indigo-600 transition-all shadow-sm hover:shadow-md'
        >
          + Add Doctor
        </button>
      </div>

      {doctors.length === 0 ? (
        <div className='flex flex-col items-center justify-center py-24 bg-white rounded-2xl border border-dashed border-gray-200'>
          <div className='text-5xl mb-4'>👨‍⚕️</div>
          <p className='text-gray-600 font-semibold text-lg mb-1'>No doctors yet</p>
          <p className='text-gray-400 text-sm mb-6'>Start by adding your first doctor to the platform</p>
          <button
            onClick={() => navigate('/add-doctor')}
            className='bg-primary text-white text-sm font-medium px-8 py-3 rounded-xl hover:bg-indigo-600 transition-all shadow-sm'
          >
            Add First Doctor
          </button>
        </div>
      ) : (
        <div className='grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4'>
          {doctors.map((item, index) => (
            <div
              key={index}
              className='bg-white border border-gray-100 rounded-2xl overflow-hidden shadow-sm hover:shadow-lg transition-all duration-300 group'
            >
              <div className='overflow-hidden bg-indigo-50 h-44'>
                <img
                  className='w-full h-full object-cover object-top group-hover:scale-105 transition-all duration-500'
                  src={item.image}
                  alt={item.name}
                />
              </div>
              <div className='p-4'>
                <p className='text-gray-800 font-semibold text-sm truncate'>{item.name}</p>
                <p className='text-gray-400 text-xs mt-0.5 mb-3'>{item.speciality}</p>
                <label className='flex items-center gap-2 cursor-pointer group/toggle'>
                  <div className='relative'>
                    <input
                      onChange={() => changeAvailability(item._id)}
                      type="checkbox"
                      className='sr-only'
                      checked={item.available}
                      readOnly
                    />
                    <div className={`w-9 h-5 rounded-full transition-colors duration-200 ${item.available ? 'bg-primary' : 'bg-gray-200'}`}>
                      <div className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow-sm transition-transform duration-200 ${item.available ? 'translate-x-4' : 'translate-x-0'}`} />
                    </div>
                  </div>
                  <span className={`text-xs font-medium ${item.available ? 'text-primary' : 'text-gray-400'}`}>
                    {item.available ? 'Available' : 'Unavailable'}
                  </span>
                </label>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default DoctorsList
