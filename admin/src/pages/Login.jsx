import React, { useState, useContext } from 'react'
import { AdminContext } from '../context/AdminContext'
import axios from 'axios'
import { toast } from 'react-toastify'
import { DoctorContext } from '../context/DoctorContext'
import { assets } from '../assets/assets'

const Login = () => {
  const [state, setState] = useState('Admin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)

  const { setAToken, backendUrl } = useContext(AdminContext)
  const { setDToken } = useContext(DoctorContext)

  const onSubmitHandler = async (event) => {
    event.preventDefault()
    setLoading(true)
    try {
      if (state === 'Admin') {
        const { data } = await axios.post(backendUrl + '/api/admin/login', { email, password })
        if (data.success) {
          localStorage.setItem('aToken', data.token)
          setAToken(data.token)
        } else {
          toast.error(data.message)
        }
      } else {
        const { data } = await axios.post(backendUrl + '/api/doctor/login', { email, password })
        if (data.success) {
          localStorage.setItem('dToken', data.token)
          setDToken(data.token)
        } else {
          toast.error(data.message)
        }
      }
    } catch (error) {
      toast.error('Unable to connect to server. Please start the backend.')
    }
    setLoading(false)
  }

  return (
    <div className='min-h-screen flex items-center justify-center bg-gradient-to-br from-indigo-50 via-white to-blue-50 px-4'>
      <div className='w-full max-w-md'>

        {/* Logo */}
        <div className='flex justify-center mb-8'>
          <img className='w-44' src={assets.admin_logo} alt="Prescripto Admin" />
        </div>

        {/* Tab Switcher */}
        <div className='flex bg-gray-100 rounded-xl p-1 mb-6'>
          <button
            type='button'
            onClick={() => setState('Admin')}
            className={`flex-1 py-2.5 text-sm font-medium rounded-lg transition-all duration-200 ${state === 'Admin' ? 'bg-white text-primary shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
          >
            🛡 Admin Login
          </button>
          <button
            type='button'
            onClick={() => setState('Doctor')}
            className={`flex-1 py-2.5 text-sm font-medium rounded-lg transition-all duration-200 ${state === 'Doctor' ? 'bg-white text-primary shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
          >
            👨‍⚕️ Doctor Login
          </button>
        </div>

        {/* Form Card */}
        <form onSubmit={onSubmitHandler} className='bg-white rounded-2xl shadow-lg border border-gray-100 p-8 flex flex-col gap-5'>
          <div>
            <p className='text-2xl font-semibold text-gray-800 mb-1'>
              Welcome back
            </p>
            <p className='text-sm text-gray-400'>Sign in to your {state.toLowerCase()} account</p>
          </div>

          <div className='flex flex-col gap-1.5'>
            <label className='text-sm font-medium text-gray-700'>Email address</label>
            <input
              onChange={(e) => setEmail(e.target.value)}
              value={email}
              className='border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all'
              type="email"
              placeholder='Enter your email'
              required
            />
          </div>

          <div className='flex flex-col gap-1.5'>
            <label className='text-sm font-medium text-gray-700'>Password</label>
            <input
              onChange={(e) => setPassword(e.target.value)}
              value={password}
              className='border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all'
              type="password"
              placeholder='Enter your password'
              required
            />
          </div>

          <button
            type='submit'
            disabled={loading}
            className='bg-primary hover:bg-indigo-600 text-white w-full py-3 rounded-xl text-sm font-semibold transition-all duration-200 shadow-sm hover:shadow-md disabled:opacity-60'
          >
            {loading ? 'Signing in...' : `Sign in as ${state}`}
          </button>
        </form>

        <p className='text-center text-xs text-gray-400 mt-4'>
          Prescripto Admin Panel &mdash; Internal access only
        </p>
      </div>
    </div>
  )
}

export default Login
