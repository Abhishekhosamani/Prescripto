import React from 'react'
import { specialityData } from '../assets/assets'
import { Link } from 'react-router-dom'

const SpecialityMenu = () => {
  return (
    <div className='flex flex-col items-center gap-4 py-16 text-gray-800' id='speciality'>
      <h1 className='text-3xl font-semibold'>Find by Speciality</h1>
      <p className='sm:w-1/3 text-center text-sm text-gray-500'>
        Simply browse through our extensive list of trusted doctors, schedule your appointment hassle-free.
      </p>
      <div className='flex sm:justify-center gap-5 pt-5 w-full overflow-x-auto pb-2'>
        {specialityData.map((item, index) => (
          <Link
            onClick={() => window.scrollTo(0, 0)}
            className='flex flex-col items-center text-xs cursor-pointer flex-shrink-0 hover:-translate-y-2 transition-all duration-300 group'
            key={index}
            to={`/doctors/${item.speciality}`}
          >
            <div className='w-20 h-20 sm:w-24 sm:h-24 rounded-full bg-blue-50 group-hover:bg-primary/10 flex items-center justify-center mb-3 transition-all duration-300 shadow-sm group-hover:shadow-md'>
              <img className='w-12 sm:w-14' src={item.image} alt={item.speciality} />
            </div>
            <p className='text-gray-600 group-hover:text-primary font-medium transition-colors duration-300'>{item.speciality}</p>
          </Link>
        ))}
      </div>
    </div>
  )
}

export default SpecialityMenu
