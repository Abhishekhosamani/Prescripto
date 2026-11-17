import { useState, useRef, useEffect, useContext } from 'react'
import axios from 'axios'
import { useNavigate } from 'react-router-dom'
import { AppContext } from '../context/AppContext'

const SPECIALITY_ROUTE = {
  'General physician': 'General physician',
  'Gynecologist': 'Gynecologist',
  'Dermatologist': 'Dermatologist',
  'Pediatrician': 'Pediatrician',
  'Neurologist': 'Neurologist',
  'Gastroenterologist': 'Gastroenterologist',
}

const ChatBot = () => {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      content: "Hi! I'm MedBot 👋 Tell me what symptoms you're experiencing and I'll help you find the right doctor.",
    },
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [recommendation, setRecommendation] = useState(null)
  const bottomRef = useRef(null)
  const inputRef = useRef(null)
  const navigate = useNavigate()
  const { backendUrl } = useContext(AppContext)

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [open])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  const sendMessage = async () => {
    const text = input.trim()
    if (!text || loading) return

    const userMsg = { role: 'user', content: text }
    const updatedMessages = [...messages.filter(m => m.role !== 'assistant' || messages.indexOf(m) > 0), userMsg]
    // Build API-compatible history (exclude the initial greeting which isn't from the API)
    const apiMessages = [
      ...messages.slice(1).map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: text },
    ]

    setMessages(prev => [...prev, userMsg])
    setInput('')
    setLoading(true)

    try {
      const { data } = await axios.post(backendUrl + '/api/chatbot/analyze', {
        messages: apiMessages,
      })

      if (data.success) {
        setMessages(prev => [...prev, { role: 'assistant', content: data.reply }])
        if (data.recommendation) {
          setRecommendation(data.recommendation)
        }
      } else {
        setMessages(prev => [...prev, { role: 'assistant', content: data.message || 'Sorry, I had trouble processing that. Please try again.' }])
      }
    } catch (error) {
      const serverMsg = error?.response?.data?.message || 'Connection error. Please check your internet and try again.'
      setMessages(prev => [...prev, { role: 'assistant', content: serverMsg }])
    } finally {
      setLoading(false)
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const handleFindDoctors = () => {
    if (!recommendation) return
    const speciality = SPECIALITY_ROUTE[recommendation.speciality] || recommendation.speciality
    navigate(`/doctors/${encodeURIComponent(speciality)}`)
    setOpen(false)
  }

  const handleReset = () => {
    setMessages([
      {
        role: 'assistant',
        content: "Hi! I'm MedBot 👋 Tell me what symptoms you're experiencing and I'll help you find the right doctor.",
      },
    ])
    setRecommendation(null)
    setInput('')
  }

  return (
    <>
      {/* Floating Button */}
      <button
        onClick={() => setOpen(prev => !prev)}
        className='fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full bg-primary shadow-lg flex items-center justify-center hover:shadow-xl hover:scale-105 transition-all duration-200'
        aria-label='Open medical chatbot'
      >
        {open ? (
          <svg xmlns='http://www.w3.org/2000/svg' className='w-6 h-6 text-white' fill='none' viewBox='0 0 24 24' stroke='currentColor' strokeWidth={2.5}>
            <path strokeLinecap='round' strokeLinejoin='round' d='M6 18L18 6M6 6l12 12' />
          </svg>
        ) : (
          <svg xmlns='http://www.w3.org/2000/svg' className='w-7 h-7 text-white' fill='none' viewBox='0 0 24 24' stroke='currentColor' strokeWidth={2}>
            <path strokeLinecap='round' strokeLinejoin='round' d='M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23-.693L5 14.5m14.8.8l1.402 1.402c1 1 .03 2.7-1.32 2.7H4.12c-1.35 0-2.32-1.7-1.32-2.7L4 14.5' />
          </svg>
        )}
      </button>

      {/* Chat Window */}
      {open && (
        <div className='fixed bottom-24 right-6 z-50 w-[360px] max-w-[calc(100vw-3rem)] bg-white rounded-2xl shadow-2xl border border-gray-100 flex flex-col overflow-hidden'
          style={{ height: '520px' }}>

          {/* Header */}
          <div className='bg-primary px-4 py-3 flex items-center justify-between'>
            <div className='flex items-center gap-3'>
              <div className='w-9 h-9 rounded-full bg-white/20 flex items-center justify-center'>
                <svg xmlns='http://www.w3.org/2000/svg' className='w-5 h-5 text-white' fill='none' viewBox='0 0 24 24' stroke='currentColor' strokeWidth={2}>
                  <path strokeLinecap='round' strokeLinejoin='round' d='M4.5 12.75l6 6 9-13.5' />
                </svg>
              </div>
              <div>
                <p className='text-white font-semibold text-sm'>MedBot</p>
                <p className='text-white/70 text-xs'>Symptom Checker</p>
              </div>
            </div>
            <button onClick={handleReset} className='text-white/70 hover:text-white text-xs transition-colors' title='New chat'>
              New chat
            </button>
          </div>

          {/* Messages */}
          <div className='flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3'>
            {messages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[82%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
                  msg.role === 'user'
                    ? 'bg-primary text-white rounded-br-sm'
                    : 'bg-gray-100 text-gray-800 rounded-bl-sm'
                }`}>
                  {msg.content}
                </div>
              </div>
            ))}

            {loading && (
              <div className='flex justify-start'>
                <div className='bg-gray-100 rounded-2xl rounded-bl-sm px-4 py-3 flex gap-1 items-center'>
                  <span className='w-2 h-2 bg-gray-400 rounded-full animate-bounce' style={{ animationDelay: '0ms' }} />
                  <span className='w-2 h-2 bg-gray-400 rounded-full animate-bounce' style={{ animationDelay: '150ms' }} />
                  <span className='w-2 h-2 bg-gray-400 rounded-full animate-bounce' style={{ animationDelay: '300ms' }} />
                </div>
              </div>
            )}

            {/* Recommendation Card */}
            {recommendation && !loading && (
              <div className='bg-green-50 border border-green-200 rounded-xl p-3 mt-1'>
                <p className='text-xs font-semibold text-green-700 mb-0.5'>Recommended Specialist</p>
                <p className='text-sm font-bold text-green-800'>{recommendation.speciality}</p>
                <p className='text-xs text-green-600 mt-1 mb-3'>{recommendation.reason}</p>
                <button
                  onClick={handleFindDoctors}
                  className='w-full bg-primary text-white text-xs font-medium py-2 rounded-lg hover:opacity-90 transition-opacity'
                >
                  Find {recommendation.speciality} Doctors →
                </button>
              </div>
            )}

            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div className='px-3 py-3 border-t border-gray-100 flex gap-2 items-end'>
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder='Describe your symptoms...'
              rows={1}
              className='flex-1 resize-none border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-primary/60 text-gray-700 placeholder-gray-400 max-h-24 overflow-auto'
              style={{ lineHeight: '1.4' }}
            />
            <button
              onClick={sendMessage}
              disabled={!input.trim() || loading}
              className='w-9 h-9 flex-shrink-0 rounded-xl bg-primary flex items-center justify-center disabled:opacity-40 hover:opacity-90 transition-opacity'
            >
              <svg xmlns='http://www.w3.org/2000/svg' className='w-4 h-4 text-white rotate-90' fill='none' viewBox='0 0 24 24' stroke='currentColor' strokeWidth={2.5}>
                <path strokeLinecap='round' strokeLinejoin='round' d='M12 19V5m0 0l-7 7m7-7l7 7' />
              </svg>
            </button>
          </div>

          <p className='text-center text-gray-300 text-[10px] pb-2'>For guidance only · Not a medical diagnosis</p>
        </div>
      )}
    </>
  )
}

export default ChatBot
