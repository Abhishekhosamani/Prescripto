import React, { useContext } from 'react'
import { AdminContext } from '../context/AdminContext'
import { NavLink } from 'react-router-dom'
import { assets } from '../assets/assets'
import { DoctorContext } from '../context/DoctorContext'

const Sidebar = () => {
  const { aToken } = useContext(AdminContext)
  const { dToken } = useContext(DoctorContext)

  const linkClass = ({ isActive }) =>
    `flex items-center gap-3 py-3 px-4 md:px-7 md:min-w-60 cursor-pointer rounded-xl mx-2 transition-all duration-200 ${
      isActive
        ? 'bg-primary text-white shadow-md'
        : 'text-gray-500 hover:bg-indigo-50 hover:text-primary'
    }`

  return (
    <div className='min-h-screen bg-white border-r border-gray-100 pt-4 pb-10'>
      {aToken && (
        <ul className='flex flex-col gap-1 mt-2'>
          <NavLink className={linkClass} to='/admin-dashboard'>
            <img className={`w-5 opacity-80`} src={assets.home_icon} alt="" />
            <p className='hidden md:block text-sm font-medium'>Dashboard</p>
          </NavLink>
          <NavLink className={linkClass} to='/all-appointments'>
            <img className='w-5 opacity-80' src={assets.appointment_icon} alt="" />
            <p className='hidden md:block text-sm font-medium'>Appointments</p>
          </NavLink>
          <NavLink className={linkClass} to='/add-doctor'>
            <img className='w-5 opacity-80' src={assets.add_icon} alt="" />
            <p className='hidden md:block text-sm font-medium'>Add Doctor</p>
          </NavLink>
          <NavLink className={linkClass} to='/doctor-list'>
            <img className='w-5 opacity-80' src={assets.people_icon} alt="" />
            <p className='hidden md:block text-sm font-medium'>Doctors List</p>
          </NavLink>
        </ul>
      )}

      {dToken && (
        <ul className='flex flex-col gap-1 mt-2'>
          <NavLink className={linkClass} to='/doctor-dashboard'>
            <img className='w-5 opacity-80' src={assets.home_icon} alt="" />
            <p className='hidden md:block text-sm font-medium'>Dashboard</p>
          </NavLink>
          <NavLink className={linkClass} to='/doctor-appointments'>
            <img className='w-5 opacity-80' src={assets.appointment_icon} alt="" />
            <p className='hidden md:block text-sm font-medium'>Appointments</p>
          </NavLink>
          <NavLink className={linkClass} to='/doctor-profile'>
            <img className='w-5 opacity-80' src={assets.people_icon} alt="" />
            <p className='hidden md:block text-sm font-medium'>Profile</p>
          </NavLink>
        </ul>
      )}
    </div>
  )
}

export default Sidebar
