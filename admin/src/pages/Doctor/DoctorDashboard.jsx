import { useContext, useEffect, useMemo } from 'react'
import { DoctorContext } from '../../context/DoctorContext'
import { assets } from '../../assets/assets'
import { AppContext } from '../../context/AppContext'
import { canCancelAppointment, PAID_CANCELLATION_NOTICE } from '../../utils/appointmentRules'
import {
  ComposedChart, Area, BarChart, Bar,
  PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend
} from 'recharts'

const COLORS = {
  completed: '#10b981',
  cancelled: '#ef4444',
  pending: '#6366f1',
}

const DoctorDashboard = () => {
  const { dToken, dashData, getDashData, appointments, getAppointments, completeAppointment, cancelAppointment } = useContext(DoctorContext)
  const { currency, slotDateFormat } = useContext(AppContext)

  useEffect(() => {
    if (dToken) {
      getDashData()
      getAppointments()
    }
  }, [dToken])

  // --- Derive chart data from all appointments ---

  const statusData = useMemo(() => {
    if (!appointments.length) return []
    const completed = appointments.filter(a => a.isCompleted).length
    const cancelled = appointments.filter(a => a.cancelled).length
    const pending = appointments.filter(a => !a.isCompleted && !a.cancelled).length
    return [
      { name: 'Completed', value: completed },
      { name: 'Cancelled', value: cancelled },
      { name: 'Pending', value: pending },
    ].filter(d => d.value > 0)
  }, [appointments])

  const last7DaysData = useMemo(() => {
    const days = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const key = `${d.getDate()}_${d.getMonth() + 1}_${d.getFullYear()}`
      days.push({
        label: d.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric' }),
        key,
        count: 0,
        earnings: 0,
      })
    }
    appointments.forEach(a => {
      const day = days.find(d => d.key === a.slotDate)
      if (day) {
        day.count += 1
        if (a.isCompleted || a.payment) day.earnings += a.amount
      }
    })
    return days
  }, [appointments])

  const earningsData = useMemo(() => {
    // Build last 6 months as base so chart always has width
    const months = []
    for (let i = 5; i >= 0; i--) {
      const d = new Date()
      d.setDate(1)
      d.setMonth(d.getMonth() - i)
      months.push({
        month: d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }),
        key: `${d.getMonth() + 1}_${d.getFullYear()}`,
        earnings: 0,
        count: 0,
      })
    }
    appointments.forEach(a => {
      const parts = a.slotDate.split('_') // day_month_year
      const key = `${parts[1]}_${parts[2]}`
      const slot = months.find(m => m.key === key)
      if (!slot) return
      slot.count += 1
      if (a.isCompleted || a.payment) slot.earnings += a.amount
    })
    return months
  }, [appointments])

  const stats = dashData ? [
    { label: 'Total Earnings', value: `${currency}${dashData.earnings}`, icon: assets.earning_icon, bg: 'bg-emerald-50', border: 'border-emerald-100', text: 'text-emerald-600' },
    { label: 'Total Appointments', value: dashData.appointments, icon: assets.appointments_icon, bg: 'bg-blue-50', border: 'border-blue-100', text: 'text-blue-600' },
    { label: 'Unique Patients', value: dashData.patients, icon: assets.patients_icon, bg: 'bg-indigo-50', border: 'border-indigo-100', text: 'text-indigo-600' },
  ] : []

  const CustomTooltip = ({ active, payload, label }) => {
    if (active && payload && payload.length) {
      return (
        <div className='bg-white border border-gray-100 rounded-xl shadow-lg px-4 py-3 text-sm'>
          <p className='font-semibold text-gray-700 mb-1'>{label}</p>
          {payload.map((p, i) => (
            <p key={i} style={{ color: p.color }} className='font-medium'>
              {p.name}: {p.name === 'Earnings' ? `${currency}${p.value}` : p.value}
            </p>
          ))}
        </div>
      )
    }
    return null
  }

  const PieTooltip = ({ active, payload }) => {
    if (active && payload && payload.length) {
      return (
        <div className='bg-white border border-gray-100 rounded-xl shadow-lg px-4 py-3 text-sm'>
          <p style={{ color: COLORS[payload[0].name.toLowerCase()] }} className='font-semibold'>
            {payload[0].name}: {payload[0].value}
          </p>
        </div>
      )
    }
    return null
  }

  if (!dashData) return (
    <div className='m-6 flex flex-col gap-6 animate-pulse'>
      <div className='grid grid-cols-1 sm:grid-cols-3 gap-4'>
        {[1, 2, 3].map(i => <div key={i} className='h-24 bg-gray-100 rounded-2xl' />)}
      </div>
      <div className='grid grid-cols-1 lg:grid-cols-2 gap-4'>
        <div className='h-64 bg-gray-100 rounded-2xl' />
        <div className='h-64 bg-gray-100 rounded-2xl' />
      </div>
      <div className='h-64 bg-gray-100 rounded-2xl' />
    </div>
  )

  return (
    <div className='m-6 flex flex-col gap-6'>

      {/* Stat Cards */}
      <div className='grid grid-cols-1 sm:grid-cols-3 gap-4'>
        {stats.map((s) => (
          <div key={s.label} className={`flex items-center gap-4 bg-white p-5 rounded-2xl border ${s.border} shadow-sm hover:shadow-md transition-all duration-200`}>
            <div className={`${s.bg} p-3 rounded-xl`}>
              <img className='w-10 h-10 object-contain' src={s.icon} alt={s.label} />
            </div>
            <div>
              <p className={`text-2xl font-bold ${s.text}`}>{s.value}</p>
              <p className='text-sm text-gray-400 font-medium'>{s.label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Charts Row */}
      <div className='grid grid-cols-1 lg:grid-cols-3 gap-4'>

        {/* Appointment Status — Donut */}
        <div className='bg-white rounded-2xl border border-gray-100 shadow-sm p-5'>
          <p className='font-semibold text-gray-800 mb-1'>Appointment Status</p>
          <p className='text-xs text-gray-400 mb-4'>Overall breakdown</p>
          {statusData.length > 0 ? (
            <ResponsiveContainer width='100%' height={220}>
              <PieChart>
                <Pie
                  data={statusData}
                  cx='50%' cy='50%'
                  innerRadius={55} outerRadius={85}
                  paddingAngle={3}
                  dataKey='value'
                >
                  {statusData.map((entry) => (
                    <Cell key={entry.name} fill={COLORS[entry.name.toLowerCase()]} />
                  ))}
                </Pie>
                <Tooltip content={<PieTooltip />} />
                <Legend
                  formatter={(value) => <span className='text-xs text-gray-600'>{value}</span>}
                />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className='h-55 flex items-center justify-center text-gray-300 text-sm'>No data yet</div>
          )}
        </div>

        {/* Daily Appointments — Bar */}
        <div className='lg:col-span-2 bg-white rounded-2xl border border-gray-100 shadow-sm p-5'>
          <p className='font-semibold text-gray-800 mb-1'>Appointments This Week</p>
          <p className='text-xs text-gray-400 mb-4'>Last 7 days</p>
          <ResponsiveContainer width='100%' height={220}>
            <BarChart data={last7DaysData} barSize={28}>
              <CartesianGrid strokeDasharray='3 3' stroke='#f3f4f6' vertical={false} />
              <XAxis dataKey='label' tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false} allowDecimals={false} />
              <Tooltip content={<CustomTooltip />} cursor={{ fill: '#f5f3ff' }} />
              <Bar dataKey='count' name='Appointments' fill='#6366f1' radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Earnings Trend — Composed */}
      <div className='bg-white rounded-2xl border border-gray-100 shadow-sm p-5'>
        <div className='flex items-start justify-between mb-4'>
          <div>
            <p className='font-semibold text-gray-800'>Earnings Trend</p>
            <p className='text-xs text-gray-400 mt-0.5'>Last 6 months — bars show appointments, line shows earnings</p>
          </div>
          <div className='text-right'>
            <p className='text-lg font-bold text-emerald-600'>{currency}{dashData.earnings}</p>
            <p className='text-xs text-gray-400'>total earned</p>
          </div>
        </div>
        <ResponsiveContainer width='100%' height={240}>
          <ComposedChart data={earningsData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id='earningsGrad' x1='0' y1='0' x2='0' y2='1'>
                <stop offset='0%' stopColor='#10b981' stopOpacity={0.35} />
                <stop offset='100%' stopColor='#10b981' stopOpacity={0.05} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray='3 3' stroke='#f3f4f6' vertical={false} />
            <XAxis dataKey='month' tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
            <YAxis yAxisId='left' tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false} allowDecimals={false} />
            <YAxis yAxisId='right' orientation='right' tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
            <Tooltip content={<CustomTooltip />} cursor={{ fill: '#f5f3ff', opacity: 0.5 }} />
            <Legend formatter={(value) => <span className='text-xs text-gray-500'>{value}</span>} />
            <Bar yAxisId='left' dataKey='count' name='Appointments' fill='#e0e7ff' radius={[4, 4, 0, 0]} barSize={32} />
            <Area
              yAxisId='right'
              type='monotone'
              dataKey='earnings'
              name='Earnings'
              stroke='#10b981'
              strokeWidth={2.5}
              fill='url(#earningsGrad)'
              dot={{ fill: '#10b981', strokeWidth: 2, r: 4, stroke: '#fff' }}
              activeDot={{ r: 6, fill: '#10b981', stroke: '#fff', strokeWidth: 2 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Latest Bookings */}
      <div className='bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden'>
        <div className='flex items-center gap-2 px-6 py-4 border-b border-gray-100'>
          <img className='w-5' src={assets.list_icon} alt="" />
          <p className='font-semibold text-gray-800'>Latest Bookings</p>
        </div>

        {dashData.latestAppointments.length === 0 ? (
          <p className='text-center text-gray-400 py-10 text-sm'>No bookings yet</p>
        ) : (
          dashData.latestAppointments.map((item, index) => (
            <div key={index} className='flex items-center px-6 py-4 gap-4 border-b border-gray-50 hover:bg-gray-50 transition-colors'>
              <img className='w-10 h-10 rounded-full object-cover border border-gray-100' src={item.userData.image} alt="" />
              <div className='flex-1 min-w-0'>
                <p className='text-sm font-semibold text-gray-800 truncate'>{item.userData.name}</p>
                <p className='text-xs text-gray-400 mt-0.5'>{slotDateFormat(item.slotDate)}, {item.slotTime}</p>
              </div>
              {item.cancelled
                ? <span className='text-xs font-medium px-3 py-1 rounded-full bg-red-50 text-red-500 border border-red-100'>Cancelled</span>
                : item.isCompleted
                  ? <span className='text-xs font-medium px-3 py-1 rounded-full bg-green-50 text-green-600 border border-green-100'>Completed</span>
                  : <div className='flex gap-2'>
                      {canCancelAppointment(item)
                        ? <button onClick={() => cancelAppointment(item._id)} className='text-xs px-3 py-1 rounded-full border border-red-200 text-red-400 hover:bg-red-50 transition-all'>Cancel</button>
                        // paid appointments cannot be cancelled in the app (no refund flow yet)
                        : <span title={PAID_CANCELLATION_NOTICE} className='text-xs px-3 py-1 rounded-full border border-blue-100 bg-blue-50 text-blue-500 cursor-help'>Paid</span>}
                      <button onClick={() => completeAppointment(item._id)} className='text-xs px-3 py-1 rounded-full border border-green-200 text-green-500 hover:bg-green-50 transition-all'>Complete</button>
                    </div>
              }
            </div>
          ))
        )}
      </div>

    </div>
  )
}

export default DoctorDashboard
