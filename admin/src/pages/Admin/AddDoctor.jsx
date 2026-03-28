import React, { useContext, useState } from 'react'
import { assets } from '../../assets/assets'
import { AdminContext } from '../../context/AdminContext'
import { toast } from 'react-toastify'
import axios from 'axios'

const inputClass = 'border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all w-full'
const labelClass = 'text-sm font-medium text-gray-600 mb-1 block'

const AddDoctor = () => {
  const [docImg, setDocImg] = useState(false)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [experience, setExperience] = useState('1 Year')
  const [fees, setFees] = useState('')
  const [about, setAbout] = useState('')
  const [speciality, setSpeciality] = useState('General physician')
  const [degree, setDegree] = useState('')
  const [address1, setAddress1] = useState('')
  const [address2, setAddress2] = useState('')
  const [loading, setLoading] = useState(false)

  const { backendUrl, aToken } = useContext(AdminContext)

  const onSubmitHandler = async (event) => {
    event.preventDefault()
    if (!docImg) return toast.error('Please select a doctor photo')
    setLoading(true)
    try {
      const formData = new FormData()
      formData.append('image', docImg)
      formData.append('name', name)
      formData.append('email', email)
      formData.append('password', password)
      formData.append('experience', experience)
      formData.append('fees', Number(fees))
      formData.append('about', about)
      formData.append('speciality', speciality)
      formData.append('degree', degree)
      formData.append('address', JSON.stringify({ line1: address1, line2: address2 }))

      const { data } = await axios.post(backendUrl + '/api/admin/add-doctor', formData, { headers: { aToken } })

      if (data.success) {
        toast.success(data.message)
        setDocImg(false)
        setName(''); setEmail(''); setPassword(''); setDegree('')
        setFees(''); setAbout(''); setAddress1(''); setAddress2('')
      } else {
        toast.error(data.message)
      }
    } catch (error) {
      toast.error(error.message)
    }
    setLoading(false)
  }

  return (
    <form onSubmit={onSubmitHandler} className='m-6 w-full max-w-4xl'>
      <div className='mb-6'>
        <h1 className='text-xl font-bold text-gray-800'>Add Doctor</h1>
        <p className='text-sm text-gray-400 mt-0.5'>Fill in the details to register a new doctor</p>
      </div>

      <div className='bg-white rounded-2xl border border-gray-100 shadow-sm p-8 flex flex-col gap-8'>

        {/* Photo Upload */}
        <div className='flex items-center gap-6'>
          <label htmlFor="doc-img" className='cursor-pointer group'>
            <div className='relative w-24 h-24'>
              <img
                className='w-24 h-24 rounded-2xl object-cover border-2 border-dashed border-gray-200 group-hover:border-primary transition-all bg-gray-50'
                src={docImg ? URL.createObjectURL(docImg) : assets.upload_area}
                alt=""
              />
              {!docImg && (
                <div className='absolute inset-0 flex items-center justify-center rounded-2xl bg-primary/5 group-hover:bg-primary/10 transition-all'>
                </div>
              )}
            </div>
          </label>
          <input onChange={(e) => setDocImg(e.target.files[0])} type="file" id="doc-img" hidden accept="image/*" />
          <div>
            <p className='font-medium text-gray-700'>Doctor Photo</p>
            <p className='text-xs text-gray-400 mt-1'>Click to upload a clear photo<br />JPG, PNG or WebP recommended</p>
          </div>
        </div>

        {/* Two Column Fields */}
        <div className='grid grid-cols-1 lg:grid-cols-2 gap-6'>

          {/* Left Column */}
          <div className='flex flex-col gap-4'>
            <div>
              <label className={labelClass}>Full Name</label>
              <input onChange={(e) => setName(e.target.value)} value={name} className={inputClass} type="text" placeholder='Dr. John Smith' required />
            </div>
            <div>
              <label className={labelClass}>Email Address</label>
              <input onChange={(e) => setEmail(e.target.value)} value={email} className={inputClass} type="email" placeholder='doctor@example.com' required />
            </div>
            <div>
              <label className={labelClass}>Password</label>
              <input onChange={(e) => setPassword(e.target.value)} value={password} className={inputClass} type="password" placeholder='Set a secure password' required />
            </div>
            <div>
              <label className={labelClass}>Experience</label>
              <select onChange={(e) => setExperience(e.target.value)} value={experience} className={inputClass}>
                {[1,2,3,4,5,6,7,8,9,10].map(y => (
                  <option key={y} value={`${y} Year${y > 1 ? 's' : ''}`}>{y} Year{y > 1 ? 's' : ''}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass}>Consultation Fees ($)</label>
              <input onChange={(e) => setFees(e.target.value)} value={fees} className={inputClass} type="number" placeholder='e.g. 50' required />
            </div>
          </div>

          {/* Right Column */}
          <div className='flex flex-col gap-4'>
            <div>
              <label className={labelClass}>Speciality</label>
              <select onChange={(e) => setSpeciality(e.target.value)} value={speciality} className={inputClass}>
                <option>General physician</option>
                <option>Gynecologist</option>
                <option>Dermatologist</option>
                <option>Pediatricians</option>
                <option>Neurologist</option>
                <option>Gastroenterologist</option>
              </select>
            </div>
            <div>
              <label className={labelClass}>Education / Degree</label>
              <input onChange={(e) => setDegree(e.target.value)} value={degree} className={inputClass} type="text" placeholder='e.g. MBBS, MD' required />
            </div>
            <div>
              <label className={labelClass}>Address</label>
              <input onChange={(e) => setAddress1(e.target.value)} value={address1} className={inputClass} type="text" placeholder='Address line 1' required />
              <input onChange={(e) => setAddress2(e.target.value)} value={address2} className={`${inputClass} mt-2`} type="text" placeholder='Address line 2' required />
            </div>
          </div>
        </div>

        {/* About */}
        <div>
          <label className={labelClass}>About the Doctor</label>
          <textarea
            onChange={(e) => setAbout(e.target.value)}
            value={about}
            className={`${inputClass} resize-none`}
            placeholder='Write a brief professional bio about the doctor...'
            rows={4}
            required
          />
        </div>

        {/* Submit */}
        <div className='flex gap-3'>
          <button
            type='submit'
            disabled={loading}
            className='bg-primary hover:bg-indigo-600 text-white font-medium px-10 py-3 rounded-xl transition-all duration-200 shadow-sm hover:shadow-md disabled:opacity-60'
          >
            {loading ? 'Adding Doctor...' : 'Add Doctor'}
          </button>
          <button
            type='button'
            onClick={() => { setDocImg(false); setName(''); setEmail(''); setPassword(''); setDegree(''); setFees(''); setAbout(''); setAddress1(''); setAddress2('') }}
            className='border border-gray-200 text-gray-500 font-medium px-8 py-3 rounded-xl hover:bg-gray-50 transition-all'
          >
            Reset
          </button>
        </div>
      </div>
    </form>
  )
}

export default AddDoctor
