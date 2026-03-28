import React from 'react'
import { assets } from '../assets/assets'

const About = () => {
  return (
    <div>
      {/* Header */}
      <div className='text-center text-2xl pt-10 text-gray-500'>
        <p>ABOUT <span className='text-gray-700 font-semibold'>US</span></p>
      </div>

      {/* About Section */}
      <div className='my-10 flex flex-col md:flex-row gap-12'>
        <img className='w-full md:max-w-[360px] rounded-2xl shadow-md object-cover' src={assets.about_image} alt="About Prescripto" />
        <div className='flex flex-col justify-center gap-5 md:w-2/4 text-sm text-gray-600'>
          <p className='leading-relaxed'>Welcome to <span className='text-primary font-medium'>Prescripto</span>, your trusted partner in managing your healthcare needs conveniently and efficiently. At Prescripto, we understand the challenges individuals face when it comes to scheduling doctor appointments and managing their health records.</p>
          <p className='leading-relaxed'>Prescripto is committed to excellence in healthcare technology. We continuously strive to enhance our platform, integrating the latest advancements to improve user experience and deliver superior service. Whether you're booking your first appointment or managing ongoing care, Prescripto is here to support you every step of the way.</p>
          <div className='bg-blue-50 border border-blue-100 rounded-xl p-5'>
            <p className='font-semibold text-gray-800 mb-2'>Our Vision</p>
            <p className='leading-relaxed'>Our vision at Prescripto is to create a seamless healthcare experience for every user. We aim to bridge the gap between patients and healthcare providers, making it easier for you to access the care you need, when you need it.</p>
          </div>
        </div>
      </div>

      {/* Why Choose Us */}
      <div className='text-xl font-semibold text-gray-700 my-6'>
        WHY <span className='text-primary'>CHOOSE US</span>
      </div>
      <div className='flex flex-col md:flex-row gap-4 mb-20'>
        {[
          { title: 'Efficiency', desc: 'Streamlined appointment scheduling that fits into your busy lifestyle.', icon: '⚡' },
          { title: 'Convenience', desc: 'Access to a network of trusted healthcare professionals in your area.', icon: '📍' },
          { title: 'Personalization', desc: 'Tailored recommendations and reminders to help you stay on top of your health.', icon: '✨' },
        ].map((item) => (
          <div key={item.title} className='flex-1 border border-gray-100 rounded-2xl px-8 py-10 flex flex-col gap-4 text-gray-600 hover:bg-primary hover:text-white transition-all duration-300 cursor-pointer group shadow-sm hover:shadow-xl'>
            <span className='text-3xl'>{item.icon}</span>
            <p className='font-semibold text-base'>{item.title}:</p>
            <p className='text-sm leading-relaxed'>{item.desc}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

export default About
