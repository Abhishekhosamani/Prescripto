import { createContext, useEffect, useState } from "react";
import axios from 'axios'
import { toast } from "react-toastify"
import { doctors as staticDoctors } from "../assets/assets"

export const AppContext = createContext()

const AppContextProvider = (props) => {

    const currencySymbol = '$'
    const currency = currencySymbol
    const backendUrl = import.meta.env.VITE_BACKEND_URL

    const [doctors, setDoctors] = useState(staticDoctors)
    const [isLiveData, setIsLiveData] = useState(false)
    const [token, setToken] = useState(localStorage.getItem('token') ? localStorage.getItem('token') : false)
    const [userData, setUserData] = useState(false)

    const slotDateFormat = (slotDate) => {
        const dateArr = slotDate.split('_')
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
        return dateArr[0] + ' ' + months[Number(dateArr[1]) - 1] + ' ' + dateArr[2]
    }

    const calculateAge = (dob) => {
        const today = new Date()
        const birthDate = new Date(dob)
        let age = today.getFullYear() - birthDate.getFullYear()
        return age
    }

    const getDoctorsData = async () => {
        try {
            const {data} = await axios.get(backendUrl + '/api/doctor/list')
            if (data.success) {
                if (data.doctors.length > 0) {
                    setDoctors(data.doctors)
                    setIsLiveData(true)
                }
            } else {
                toast.error(data.message)
            }
        } catch (error) {
            console.log(error)
        }
    }

    const loadUserProfileData = async () => {
        try {
            const {data} = await axios.get(backendUrl + '/api/user/get-profile', {headers:{token}})
            if (data.success) {
                setUserData(data.userData)
            } else {
                // Token is invalid or user no longer exists — clear it
                localStorage.removeItem('token')
                setToken(false)
            }
        } catch (error) {
            console.log(error)
        }
    }

    const value = {
        doctors, getDoctorsData,
        currencySymbol, currency,
        slotDateFormat, calculateAge,
        isLiveData,
        token, setToken,
        backendUrl,
        userData, setUserData,
        loadUserProfileData
    }

    useEffect(() => {
        getDoctorsData()
    }, [])

    useEffect(() => {
        if (token) {
            loadUserProfileData()
        } else {
            setUserData(false)
        }
    }, [token])

    return (
        <AppContext.Provider value={value}>
            {props.children}
        </AppContext.Provider>
    )
}

export default AppContextProvider
