import React, { useContext, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { AppContext } from '../context/AppContext'

const Doctors = () => {
  const { speciality } = useParams()
  const [filterDoc, setFilterDoc] = useState([])
  const [showFilter, setShowFilter] = useState(false)
  const navigate = useNavigate()

  const { doctors, isLiveData, getDoctorsData } = useContext(AppContext)

  const applyFilter = () => {
    if (speciality) {
      setFilterDoc(doctors.filter(doc => doc.speciality === speciality))
    } else {
      setFilterDoc(doctors)
    }
  }

  useEffect(() => {
    applyFilter()
  }, [doctors, speciality])

  const specialities = [
    'General physician',
    'Gynecologist',
    'Dermatologist',
    'Pediatricians',
    'Neurologist',
    'Gastroenterologist',
  ]

  return (
    <div>
      {/* Live / Demo indicator */}
      {!isLiveData && (
        <div className='flex items-center justify-between bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5 mb-5 text-sm'>
          <span className='text-amber-700'>Showing demo doctors — start the backend to see real doctors</span>
          <button
            onClick={getDoctorsData}
            className='text-xs font-medium px-3 py-1 rounded-full bg-amber-100 text-amber-700 hover:bg-amber-200 transition-all border border-amber-200'
          >
            Refresh
          </button>
        </div>
      )}
      {isLiveData && (
        <div className='flex items-center justify-between mb-5'>
          <p className='text-gray-500'>Browse through the doctors specialist.</p>
          <button
            onClick={getDoctorsData}
            className='text-xs font-medium px-3 py-1 rounded-full border border-gray-200 text-gray-500 hover:bg-gray-50 transition-all'
          >
            ↻ Refresh
          </button>
        </div>
      )}
      <div className='flex flex-col sm:flex-row items-start gap-5'>

        {/* Filter Toggle (mobile) */}
        <button
          className={`py-2 px-5 border rounded-full text-sm font-medium transition-all sm:hidden ${showFilter ? 'bg-primary text-white border-primary' : 'border-gray-300 text-gray-600'}`}
          onClick={() => setShowFilter(prev => !prev)}
        >
          {showFilter ? 'Hide Filters' : 'Show Filters'}
        </button>

        {/* Sidebar */}
        <div className={`flex-col gap-2 text-sm ${showFilter ? 'flex' : 'hidden sm:flex'} min-w-[180px]`}>
          <p className='font-semibold text-gray-700 mb-1 hidden sm:block'>Speciality</p>
          {specialities.map((s) => (
            <p
              key={s}
              onClick={() => s === speciality ? navigate('/doctors') : navigate(`/doctors/${s}`)}
              className={`pl-4 py-2 pr-10 border rounded-xl transition-all cursor-pointer text-sm ${
                speciality === s
                  ? 'bg-primary text-white border-primary shadow-md'
                  : 'border-gray-200 text-gray-600 hover:bg-indigo-50 hover:border-primary'
              }`}
            >
              {s}
            </p>
          ))}
        </div>

        {/* Doctor Cards */}
        <div className='w-full grid grid-cols-auto gap-4 gap-y-6'>
          {filterDoc.length > 0 ? filterDoc.map((item, index) => (
            <div
              onClick={() => navigate(`/appointment/${item._id}`)}
              className='border border-blue-100 rounded-xl overflow-hidden cursor-pointer hover:shadow-xl hover:-translate-y-2 transition-all duration-300 bg-white group'
              key={index}
            >
              <div className='overflow-hidden bg-blue-50'>
                <img className='w-full group-hover:scale-105 transition-all duration-500' src={item.image} alt={item.name} />
              </div>
              <div className='p-4'>
                <div className={`flex items-center gap-2 text-xs mb-1 ${item.available ? 'text-green-500' : 'text-gray-400'}`}>
                  <span className={`w-2 h-2 rounded-full ${item.available ? 'bg-green-500' : 'bg-gray-400'}`}></span>
                  <span>{item.available ? 'Available' : 'Not Available'}</span>
                </div>
                <p className='text-gray-900 font-semibold text-base truncate'>{item.name}</p>
                <p className='text-gray-500 text-sm mt-0.5'>{item.speciality}</p>
              </div>
            </div>
          )) : (
            <p className='text-gray-400 col-span-full text-center py-10'>No doctors found for this speciality.</p>
          )}
        </div>
      </div>
    </div>
  )
}

export default Doctors
