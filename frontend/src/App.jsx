import React, { useContext } from 'react'
import { Route, Routes, Navigate } from 'react-router-dom'
import Home from './pages/Home'
import Doctors from './pages/Doctors'
import Login from './pages/Login'
import About from './pages/About'
import Contact from './pages/Contact'
import MyProfile from './pages/MyProfile'
import MyAppointments from './pages/MyAppointments'
import Appointment from './pages/Appointment'
import Navbar from './components/Navbar'
import Footer from './components/Footer'
import ChatBot from './components/ChatBot'
import { ToastContainer } from 'react-toastify';
import { AppContext } from './context/AppContext'

const PrivateRoute = ({ element }) => {
  const { token } = useContext(AppContext)
  return token ? element : <Navigate to="/login" replace />
}

const App = () => {
  return (
    <div className='mx-4 sm:mx-[10%]' >
      <ToastContainer/>
      <Navbar/>
      <Routes>
        <Route path='/' element={<Home/>} />
        <Route path='/doctors' element={<Doctors/>} />
        <Route path='/doctors/:speciality' element={<Doctors/>} />
        <Route path='/login' element={<Login/>} />
        <Route path='/about' element={<About/>} />
        <Route path='/contact' element={<Contact/>} />
        <Route path='/my-profile' element={<PrivateRoute element={<MyProfile/>} />} />
        <Route path='/my-appointments' element={<PrivateRoute element={<MyAppointments/>} />} />
        <Route path='/appointment/:docId' element={<PrivateRoute element={<Appointment/>} />} />
        <Route path='*' element={
          <div className='flex flex-col items-center justify-center min-h-[50vh] text-center px-4'>
            <h1 className='text-6xl font-bold text-primary mb-4'>404</h1>
            <h2 className='text-xl font-semibold text-gray-700 mb-2'>Page Not Found</h2>
            <p className='text-gray-500 mb-6'>The page you are looking for does not exist or has been moved.</p>
            <a href='/' className='bg-primary text-white px-6 py-2 rounded-full font-medium hover:opacity-90 transition-opacity'>Back to Home</a>
          </div>
        } />
      </Routes>
      <Footer/>
      <ChatBot/>
    </div>
  )
}

export default App