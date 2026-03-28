import React, { useContext } from 'react'
import { AdminContext } from '../context/AdminContext'
import { assets } from '../assets/assets'
import { useNavigate } from 'react-router-dom'
import { DoctorContext } from '../context/DoctorContext'

const Navbar = () => {
  const { aToken, setAToken } = useContext(AdminContext)
  const { dToken, setDToken } = useContext(DoctorContext)
  const navigate = useNavigate()

  const logout = () => {
    navigate('/')
    if (aToken) { setAToken(''); localStorage.removeItem('aToken') }
    if (dToken) { setDToken(''); localStorage.removeItem('dToken') }
  }

  return (
    <div className='flex justify-between items-center px-4 sm:px-10 py-3 bg-white border-b border-gray-100 shadow-sm sticky top-0 z-50'>
      <div className='flex items-center gap-3'>
        <img className='w-36 sm:w-40 cursor-pointer' src={assets.admin_logo} alt="Prescripto Admin" />
        <span className={`text-xs font-semibold px-3 py-1 rounded-full ${aToken ? 'bg-indigo-50 text-primary border border-indigo-100' : 'bg-emerald-50 text-emerald-600 border border-emerald-100'}`}>
          {aToken ? '🛡 Admin' : '👨‍⚕️ Doctor'}
        </span>
      </div>
      <button
        onClick={logout}
        className='bg-primary hover:bg-indigo-600 text-white text-sm font-medium px-8 py-2 rounded-full transition-all duration-200 shadow-sm hover:shadow-md'
      >
        Logout
      </button>
    </div>
  )
}

export default Navbar
