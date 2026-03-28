import React, { useContext, useEffect, useState } from 'react'
import { AppContext } from '../context/AppContext'
import { useNavigate } from 'react-router-dom'

const RelatedDoctors = ({ speciality, docId }) => {

    const { doctors } = useContext(AppContext)
    const navigate = useNavigate()

    const [relDoc, setRelDoc] = useState([])

    useEffect(() => {
        if (doctors.length > 0 && speciality) {
            const doctorsData = doctors.filter((doc) => doc.speciality === speciality && doc._id !== docId)
            setRelDoc(doctorsData)
        }
    }, [doctors, speciality, docId])

    return (
        <div className='flex flex-col items-center gap-4 my-16 text-gray-900 md:mx-10'>
            <h1 className='text-3xl font-semibold'>Related Doctors</h1>
            <p className='sm:w-1/3 text-center text-sm text-gray-500'>Simply browse through our extensive list of trusted doctors</p>
            <div className='w-full grid grid-cols-auto gap-4 pt-5 gap-y-6 px-3 sm:px-0'>
                {relDoc.slice(0, 5).map((item, index) => (
                    <div
                        onClick={() => { navigate(`/appointment/${item._id}`); window.scrollTo(0, 0) }}
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
                ))}
            </div>
            <button
                onClick={() => { navigate('/doctors'); window.scrollTo(0, 0) }}
                className='bg-primary text-white px-12 py-3 rounded-full mt-4 hover:opacity-90 hover:shadow-md transition-all duration-300'
            >
                View All Doctors
            </button>
        </div>
    )
}

export default RelatedDoctors
