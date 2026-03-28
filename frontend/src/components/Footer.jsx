import React from 'react'
import { assets } from '../assets/assets'
import { NavLink } from 'react-router-dom'

const Footer = () => {
  return (
    <div className='md:mx-10'>
      <div className='flex flex-col sm:grid grid-cols-[3fr_1fr_1fr] gap-14 my-10 mt-40 text-sm'>

        {/* Left Section */}
        <div>
          <img className='mb-5 w-40' src={assets.logo} alt="Prescripto" />
          <p className='w-full md:w-2/3 text-gray-500 leading-7'>
            Your trusted partner in managing healthcare needs conveniently and efficiently. Book appointments with top doctors in your area.
          </p>
        </div>

        {/* Center Section */}
        <div>
          <p className='text-base font-semibold text-gray-800 mb-5'>COMPANY</p>
          <ul className='flex flex-col gap-3 text-gray-500'>
            <li><NavLink to='/' className='hover:text-primary transition-colors duration-200'>Home</NavLink></li>
            <li><NavLink to='/about' className='hover:text-primary transition-colors duration-200'>About us</NavLink></li>
            <li><NavLink to='/contact' className='hover:text-primary transition-colors duration-200'>Contact us</NavLink></li>
            <li><span className='hover:text-primary transition-colors duration-200 cursor-pointer'>Privacy policy</span></li>
          </ul>
        </div>

        {/* Right Section */}
        <div>
          <p className='text-base font-semibold text-gray-800 mb-5'>GET IN TOUCH</p>
          <ul className='flex flex-col gap-3 text-gray-500'>
            <li className='hover:text-primary transition-colors duration-200 cursor-pointer'>+1-212-456-7890</li>
            <li className='hover:text-primary transition-colors duration-200 cursor-pointer'>prescripto@gmail.com</li>
          </ul>
        </div>
      </div>

      {/* Copyright */}
      <div>
        <hr className='border-gray-200' />
        <p className='py-5 text-sm text-center text-gray-500'>
          Copyright © 2025 Prescripto. All rights reserved.
        </p>
      </div>
    </div>
  )
}

export default Footer
