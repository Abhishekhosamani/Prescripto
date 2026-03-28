import React, { useContext, useState } from 'react'
import { AppContext } from '../context/AppContext'
import { assets } from '../assets/assets'
import axios from 'axios'
import { toast } from 'react-toastify'

const MyProfile = () => {
  const { userData, setUserData, token, backendUrl, loadUserProfileData } = useContext(AppContext)
  const [isEdit, setIsEdit] = useState(false)
  const [image, setImage] = useState(false)

  const updateUserProfileData = async () => {
    try {
      const formData = new FormData()
      formData.append('name', userData.name)
      formData.append('phone', userData.phone)
      formData.append('address', JSON.stringify(userData.address))
      formData.append('gender', userData.gender)
      formData.append('dob', userData.dob)
      image && formData.append('image', image)

      const { data } = await axios.post(backendUrl + '/api/user/update-profile', formData, { headers: { token } })
      if (data.success) {
        toast.success(data.message)
        await loadUserProfileData()
        setIsEdit(false)
        setImage(false)
      } else {
        toast.error(data.message)
      }
    } catch (error) {
      console.log(error)
      toast.error(error.message)
    }
  }

  return userData && (
    <div className='max-w-2xl mx-auto'>

      {/* Profile Card */}
      <div className='bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden'>

        {/* Top Banner */}
        <div className='h-24 bg-gradient-to-r from-primary to-indigo-400'></div>

        {/* Avatar + Name */}
        <div className='px-6 pb-6'>
          <div className='flex items-end gap-4 -mt-12 mb-4'>
            {isEdit ? (
              <label htmlFor="image" className='cursor-pointer'>
                <div className='relative w-24 h-24'>
                  <img
                    className='w-24 h-24 rounded-full object-cover border-4 border-white shadow-md opacity-80'
                    src={image ? URL.createObjectURL(image) : userData.image}
                    alt=""
                  />
                  <div className='absolute inset-0 flex items-center justify-center rounded-full bg-black/20'>
                    <img className='w-6' src={assets.upload_icon} alt="" />
                  </div>
                </div>
                <input onChange={(e) => setImage(e.target.files[0])} type="file" id="image" hidden />
              </label>
            ) : (
              <img className='w-24 h-24 rounded-full object-cover border-4 border-white shadow-md' src={userData.image} alt="" />
            )}
            <div className='mb-1'>
              {isEdit ? (
                <input
                  className='text-2xl font-semibold text-gray-800 bg-gray-50 border border-gray-200 rounded-lg px-3 py-1 w-52 focus:outline-none focus:border-primary'
                  type="text"
                  value={userData.name || ''}
                  onChange={e => setUserData(prev => ({ ...prev, name: e.target.value }))}
                />
              ) : (
                <p className='text-2xl font-semibold text-gray-800'>{userData.name}</p>
              )}
              <p className='text-sm text-gray-400 mt-0.5'>{userData.email}</p>
            </div>
          </div>

          {/* Sections */}
          <div className='flex flex-col gap-6'>

            {/* Contact Information */}
            <div>
              <p className='text-xs font-semibold text-primary uppercase tracking-widest mb-3'>Contact Information</p>
              <div className='grid grid-cols-[130px_1fr] gap-y-3 text-sm'>
                <p className='font-medium text-gray-500'>Email</p>
                <p className='text-primary'>{userData.email}</p>

                <p className='font-medium text-gray-500'>Phone</p>
                {isEdit ? (
                  <input
                    className='bg-gray-50 border border-gray-200 rounded-lg px-3 py-1.5 max-w-52 focus:outline-none focus:border-primary text-sm'
                    type="text"
                    value={userData.phone || ''}
                    onChange={e => setUserData(prev => ({ ...prev, phone: e.target.value }))}
                  />
                ) : (
                  <p className='text-gray-700'>{userData.phone || '—'}</p>
                )}

                <p className='font-medium text-gray-500'>Address</p>
                {isEdit ? (
                  <div className='flex flex-col gap-2'>
                    <input
                      className='bg-gray-50 border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-primary text-sm'
                      type="text"
                      placeholder='Address line 1'
                      value={userData.address?.line1 || ''}
                      onChange={(e) => setUserData(prev => ({ ...prev, address: { ...(prev.address || {}), line1: e.target.value } }))}
                    />
                    <input
                      className='bg-gray-50 border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-primary text-sm'
                      type="text"
                      placeholder='Address line 2'
                      value={userData.address?.line2 || ''}
                      onChange={(e) => setUserData(prev => ({ ...prev, address: { ...(prev.address || {}), line2: e.target.value } }))}
                    />
                  </div>
                ) : (
                  <p className='text-gray-700 leading-relaxed'>
                    {userData.address?.line1 || '—'}
                    {userData.address?.line2 && <><br />{userData.address.line2}</>}
                  </p>
                )}
              </div>
            </div>

            <hr className='border-gray-100' />

            {/* Basic Information */}
            <div>
              <p className='text-xs font-semibold text-primary uppercase tracking-widest mb-3'>Basic Information</p>
              <div className='grid grid-cols-[130px_1fr] gap-y-3 text-sm'>
                <p className='font-medium text-gray-500'>Gender</p>
                {isEdit ? (
                  <select
                    className='bg-gray-50 border border-gray-200 rounded-lg px-3 py-1.5 max-w-32 focus:outline-none focus:border-primary text-sm'
                    onChange={(e) => setUserData(prev => ({ ...prev, gender: e.target.value }))}
                    value={userData.gender}
                  >
                    <option value="Male">Male</option>
                    <option value="Female">Female</option>
                  </select>
                ) : (
                  <p className='text-gray-700'>{userData.gender || '—'}</p>
                )}

                <p className='font-medium text-gray-500'>Birthday</p>
                {isEdit ? (
                  <input
                    className='bg-gray-50 border border-gray-200 rounded-lg px-3 py-1.5 max-w-40 focus:outline-none focus:border-primary text-sm'
                    type="date"
                    value={userData.dob}
                    onChange={(e) => setUserData(prev => ({ ...prev, dob: e.target.value }))}
                  />
                ) : (
                  <p className='text-gray-700'>{userData.dob || '—'}</p>
                )}
              </div>
            </div>

            {/* Actions */}
            <div className='flex gap-3 pt-2'>
              {isEdit ? (
                <>
                  <button
                    onClick={updateUserProfileData}
                    className='bg-primary text-white px-8 py-2.5 rounded-full text-sm font-medium hover:opacity-90 hover:shadow-md transition-all'
                  >
                    Save Changes
                  </button>
                  <button
                    onClick={() => { setIsEdit(false); setImage(false) }}
                    className='border border-gray-300 text-gray-600 px-8 py-2.5 rounded-full text-sm font-medium hover:bg-gray-50 transition-all'
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setIsEdit(true)}
                  className='border border-primary text-primary px-8 py-2.5 rounded-full text-sm font-medium hover:bg-primary hover:text-white transition-all'
                >
                  Edit Profile
                </button>
              )}
            </div>

          </div>
        </div>
      </div>
    </div>
  )
}

export default MyProfile
