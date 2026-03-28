import { useContext, useEffect, useState } from 'react'
import { DoctorContext } from '../../context/DoctorContext'
import { AppContext } from '../../context/AppContext'
import axios from 'axios'
import { toast } from 'react-toastify'

const inputClass = 'border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all w-full'

const DoctorProfile = () => {
  const { dToken, profileData, setProfileData, getProfileData, backendUrl } = useContext(DoctorContext)
  const { currency } = useContext(AppContext)
  const [isEdit, setIsEdit] = useState(false)
  const [saving, setSaving] = useState(false)

  const updateProfile = async () => {
    setSaving(true)
    try {
      const updateData = {
        address: profileData.address,
        fees: profileData.fees,
        available: profileData.available
      }
      const { data } = await axios.post(backendUrl + '/api/doctor/update-profile', updateData, { headers: { dToken } })
      if (data.success) {
        toast.success(data.message)
        setIsEdit(false)
        getProfileData()
      } else {
        toast.error(data.message)
      }
    } catch (error) {
      toast.error(error.message)
    }
    setSaving(false)
  }

  useEffect(() => {
    if (dToken) getProfileData()
  }, [dToken])

  if (!profileData) return (
    <div className='m-6 animate-pulse'>
      <div className='h-8 bg-gray-100 rounded-xl w-48 mb-6' />
      <div className='bg-white rounded-2xl border border-gray-100 h-96' />
    </div>
  )

  return (
    <div className='m-6 max-w-3xl'>
      <div className='mb-6'>
        <h1 className='text-xl font-bold text-gray-800'>My Profile</h1>
        <p className='text-sm text-gray-400 mt-0.5'>Manage your professional information</p>
      </div>

      <div className='bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden'>

        {/* Header banner with avatar */}
        <div className='h-28 bg-linear-to-r from-primary/10 to-indigo-100 relative' />
        <div className='px-8 pb-6'>
          <div className='-mt-14 mb-5'>
            <img
              className='w-24 h-24 rounded-2xl object-cover object-top border-4 border-white shadow-md'
              src={profileData.image}
              alt={profileData.name}
            />
          </div>

          {/* Name + credentials */}
          <div className='mb-6'>
            <h2 className='text-2xl font-bold text-gray-800'>{profileData.name}</h2>
            <div className='flex flex-wrap items-center gap-2 mt-1.5'>
              <span className='text-sm text-gray-500'>{profileData.degree}</span>
              <span className='text-gray-300'>·</span>
              <span className='text-sm text-gray-500'>{profileData.speciality}</span>
              <span className='text-xs font-medium px-2.5 py-0.5 rounded-full bg-indigo-50 text-primary border border-indigo-100'>
                {profileData.experience}
              </span>
            </div>
          </div>

          {/* About */}
          <div className='mb-6'>
            <p className='text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1.5'>About</p>
            <p className='text-sm text-gray-600 leading-relaxed'>{profileData.about}</p>
          </div>

          {/* Editable section */}
          <div className='border-t border-gray-100 pt-6 flex flex-col gap-5'>

            {/* Availability toggle */}
            <div className='flex items-center justify-between'>
              <div>
                <p className='text-sm font-medium text-gray-700'>Availability</p>
                <p className='text-xs text-gray-400 mt-0.5'>Patients can book appointments when available</p>
              </div>
              <button
                onClick={() => isEdit && setProfileData(prev => ({ ...prev, available: !prev.available }))}
                className={`relative w-12 h-6 rounded-full transition-colors duration-200 ${isEdit ? 'cursor-pointer' : 'cursor-default'} ${profileData.available ? 'bg-primary' : 'bg-gray-200'}`}
              >
                <div className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow-sm transition-transform duration-200 ${profileData.available ? 'translate-x-6' : 'translate-x-0'}`} />
              </button>
            </div>

            {/* Fees */}
            <div>
              <p className='text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2'>Consultation Fee</p>
              {isEdit ? (
                <div className='relative max-w-xs'>
                  <span className='absolute left-4 top-1/2 -translate-y-1/2 text-sm text-gray-400'>{currency}</span>
                  <input
                    type='number'
                    value={profileData.fees}
                    onChange={(e) => setProfileData(prev => ({ ...prev, fees: e.target.value }))}
                    className='border border-gray-200 rounded-xl pl-8 pr-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all w-full'
                  />
                </div>
              ) : (
                <p className='text-lg font-bold text-gray-800'>{currency}{profileData.fees}</p>
              )}
            </div>

            {/* Address */}
            <div>
              <p className='text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2'>Address</p>
              {isEdit ? (
                <div className='flex flex-col gap-2 max-w-md'>
                  <input
                    type='text'
                    value={profileData.address.line1}
                    onChange={(e) => setProfileData(prev => ({ ...prev, address: { ...prev.address, line1: e.target.value } }))}
                    className={inputClass}
                    placeholder='Address line 1'
                  />
                  <input
                    type='text'
                    value={profileData.address.line2}
                    onChange={(e) => setProfileData(prev => ({ ...prev, address: { ...prev.address, line2: e.target.value } }))}
                    className={inputClass}
                    placeholder='Address line 2'
                  />
                </div>
              ) : (
                <div className='text-sm text-gray-600'>
                  <p>{profileData.address.line1}</p>
                  {profileData.address.line2 && <p className='mt-0.5'>{profileData.address.line2}</p>}
                </div>
              )}
            </div>

            {/* Actions */}
            <div className='flex gap-3 pt-2'>
              {isEdit ? (
                <>
                  <button
                    onClick={updateProfile}
                    disabled={saving}
                    className='bg-primary hover:bg-indigo-600 text-white text-sm font-medium px-8 py-2.5 rounded-xl transition-all shadow-sm hover:shadow-md disabled:opacity-60'
                  >
                    {saving ? 'Saving...' : 'Save Changes'}
                  </button>
                  <button
                    onClick={() => { setIsEdit(false); getProfileData() }}
                    className='border border-gray-200 text-gray-500 text-sm font-medium px-6 py-2.5 rounded-xl hover:bg-gray-50 transition-all'
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setIsEdit(true)}
                  className='border border-primary text-primary text-sm font-medium px-8 py-2.5 rounded-xl hover:bg-primary hover:text-white transition-all'
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

export default DoctorProfile
