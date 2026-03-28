import React, { useContext } from 'react'
import { assets } from '../assets/assets'
import { useNavigate } from 'react-router-dom'
import { AppContext } from '../context/AppContext'

const Banner = () => {
    const navigate = useNavigate()
    const { token } = useContext(AppContext)

    return (
        <div className='flex bg-primary rounded-2xl px-6 sm:px-10 md:px-14 lg:px-12 my-20 md:mx-10 shadow-lg overflow-hidden'>
            {/* Left Side */}
            <div className='flex-1 py-8 sm:py-10 md:py-16 lg:py-24 lg:pl-5'>
                <div className='text-xl sm:text-2xl md:text-3xl lg:text-5xl font-semibold text-white leading-snug'>
                    <p>Book Appointment</p>
                    <p className='mt-3'>With 100+ Trusted Doctors</p>
                </div>
                <p className='text-white/80 text-sm mt-4 hidden md:block'>Your health is our priority. Start your journey today.</p>
                {!token && (
                    <button
                        onClick={() => { navigate('/login'); window.scrollTo(0, 0) }}
                        className='bg-white text-sm sm:text-base text-primary font-medium px-8 py-3 rounded-full mt-6 hover:shadow-lg hover:scale-105 transition-all duration-300'
                    >
                        Create account
                    </button>
                )}
            </div>

            {/* Right Side */}
            <div className='hidden md:block md:w-1/2 lg:w-[370px] relative'>
                <img className='w-full absolute bottom-0 right-0 max-w-md' src={assets.appointment_img} alt="" />
            </div>
        </div>
    )
}

export default Banner
