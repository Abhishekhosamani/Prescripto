import React from 'react'
import { assets } from '../assets/assets'

const Contact = () => {
  return (
    <div>
      {/* Header */}
      <div className='text-center text-2xl pt-10 text-gray-500'>
        <p>CONTACT <span className='text-gray-700 font-semibold'>US</span></p>
      </div>

      {/* Content */}
      <div className='my-10 flex flex-col justify-center md:flex-row gap-10 mb-28 text-sm'>
        <img className='w-full md:max-w-[360px] rounded-2xl shadow-md object-cover' src={assets.contact_image} alt="Contact" />

        <div className='flex flex-col justify-center items-start gap-6'>

          <div>
            <p className='font-semibold text-base text-gray-800 mb-3'>OUR OFFICE</p>
            <div className='flex flex-col gap-2 text-gray-500'>
              <p>📍 54709 Willms Station, Suite 350</p>
              <p className='pl-6'>Washington, USA</p>
              <p className='mt-1'>📞 (415) 555-0132</p>
              <p>✉️ prescripto@gmail.com</p>
            </div>
          </div>

          <hr className='w-full border-gray-200' />

          <div>
            <p className='font-semibold text-base text-gray-800 mb-3'>CAREERS AT PRESCRIPTO</p>
            <p className='text-gray-500 mb-4'>Learn more about our teams and job openings.</p>
            <button className='border border-primary text-primary px-8 py-3 rounded-full text-sm font-medium hover:bg-primary hover:text-white transition-all duration-300'>
              Explore Jobs
            </button>
          </div>

        </div>
      </div>
    </div>
  )
}

export default Contact
