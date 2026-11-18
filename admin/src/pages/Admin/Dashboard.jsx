import React, { useContext, useEffect, useMemo } from 'react'
import { AdminContext } from '../../context/AdminContext'
import { assets } from '../../assets/assets'
import { AppContext } from '../../context/AppContext'
import { canCancelAppointment, PAID_CANCELLATION_NOTICE } from '../../utils/appointmentRules'
import {
  ComposedChart, Bar, Area,
  PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend
} from 'recharts'

const STATUS_COLORS = {
  Completed: '#10b981',
  Cancelled: '#ef4444',
  Pending: '#6366f1',
}

const Dashboard = () => {
  const { aToken, getDashData, cancelAppointment, dashData, appointments, getAllAppointments } = useContext(AdminContext)
  const { slotDateFormat } = useContext(AppContext)

  useEffect(() => {
    if (aToken) {
      getDashData()
      getAllAppointments()
    }
  }, [aToken])

  // Appointment status breakdown
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

  // Last 7 days activity
  const weekData = useMemo(() => {
    const days = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const key = `${d.getDate()}_${d.getMonth() + 1}_${d.getFullYear()}`
      days.push({
        label: d.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric' }),
        key,
        booked: 0,
        cancelled: 0,
      })
    }
    appointments.forEach(a => {
      const day = days.find(d => d.key === a.slotDate)
      if (!day) return
      if (a.cancelled) day.cancelled += 1
      else day.booked += 1
    })
    return days
  }, [appointments])

  // Last 6 months trend
  const monthlyData = useMemo(() => {
    const months = []
    for (let i = 5; i >= 0; i--) {
      const d = new Date()
      d.setDate(1)
      d.setMonth(d.getMonth() - i)
      months.push({
        month: d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }),
        key: `${d.getMonth() + 1}_${d.getFullYear()}`,
        appointments: 0,
        patients: new Set(),
      })
    }
    appointments.forEach(a => {
      const parts = a.slotDate.split('_')
      const key = `${parts[1]}_${parts[2]}`
      const slot = months.find(m => m.key === key)
      if (!slot) return
      slot.appointments += 1
      slot.patients.add(a.userId)
    })
    return months.map(m => ({ ...m, patients: m.patients.size }))
  }, [appointments])

  const CustomTooltip = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null
    return (
      <div className='bg-white border border-gray-100 rounded-xl shadow-lg px-4 py-3 text-sm'>
        <p className='font-semibold text-gray-700 mb-1'>{label}</p>
        {payload.map((p, i) => (
          <p key={i} style={{ color: p.color }} className='font-medium'>{p.name}: {p.value}</p>
        ))}
      </div>
    )
  }

  const PieTooltip = ({ active, payload }) => {
    if (!active || !payload?.length) return null
    return (
      <div className='bg-white border border-gray-100 rounded-xl shadow-lg px-4 py-3 text-sm'>
        <p style={{ color: STATUS_COLORS[payload[0].name] }} className='font-semibold'>
          {payload[0].name}: {payload[0].value}
        </p>
      </div>
    )
  }

  const stats = dashData ? [
    { label: 'Total Doctors', value: dashData.doctors, icon: assets.doctor_icon, bg: 'bg-indigo-50', border: 'border-indigo-100', text: 'text-indigo-600' },
    { label: 'Total Appointments', value: dashData.appointments, icon: assets.appointments_icon, bg: 'bg-blue-50', border: 'border-blue-100', text: 'text-blue-600' },
    { label: 'Total Patients', value: dashData.patients, icon: assets.patients_icon, bg: 'bg-emerald-50', border: 'border-emerald-100', text: 'text-emerald-600' },
  ] : []

  if (!dashData) return (
    <div className='m-6 flex flex-col gap-6 animate-pulse'>
      <div className='grid grid-cols-1 sm:grid-cols-3 gap-4'>
        {[1, 2, 3].map(i => <div key={i} className='h-24 bg-gray-100 rounded-2xl' />)}
      </div>
      <div className='grid grid-cols-1 lg:grid-cols-3 gap-4'>
        <div className='h-64 bg-gray-100 rounded-2xl' />
        <div className='lg:col-span-2 h-64 bg-gray-100 rounded-2xl' />
      </div>
      <div className='h-64 bg-gray-100 rounded-2xl' />
    </div>
  )

  return (
    <div className='m-6 flex flex-col gap-6'>

      {/* Stat Cards */}
      <div className='grid grid-cols-1 sm:grid-cols-3 gap-4'>
        {stats.map((s) => (
          <div key={s.label} className={`flex items-center gap-4 bg-white p-5 rounded-2xl border ${s.border} shadow-sm hover:shadow-md transition-all duration-200 cursor-default`}>
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

      {/* Charts Row 1 */}
      <div className='grid grid-cols-1 lg:grid-cols-3 gap-4'>

        {/* Status Donut */}
        <div className='bg-white rounded-2xl border border-gray-100 shadow-sm p-5'>
          <p className='font-semibold text-gray-800 mb-1'>Appointment Status</p>
          <p className='text-xs text-gray-400 mb-2'>Overall breakdown</p>
          {statusData.length > 0 ? (
            <ResponsiveContainer width='100%' height={230}>
              <PieChart>
                <Pie data={statusData} cx='50%' cy='50%' innerRadius={60} outerRadius={88} paddingAngle={3} dataKey='value'>
                  {statusData.map((entry) => (
                    <Cell key={entry.name} fill={STATUS_COLORS[entry.name]} />
                  ))}
                </Pie>
                <Tooltip content={<PieTooltip />} />
                <Legend formatter={(v) => <span className='text-xs text-gray-500'>{v}</span>} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className='h-57.5 flex items-center justify-center text-gray-300 text-sm'>No data yet</div>
          )}
        </div>

        {/* Weekly Activity — Stacked Bar */}
        <div className='lg:col-span-2 bg-white rounded-2xl border border-gray-100 shadow-sm p-5'>
          <p className='font-semibold text-gray-800 mb-1'>Weekly Activity</p>
          <p className='text-xs text-gray-400 mb-4'>Booked vs Cancelled — last 7 days</p>
          <ResponsiveContainer width='100%' height={230}>
            <ComposedChart data={weekData} barSize={26}>
              <CartesianGrid strokeDasharray='3 3' stroke='#f3f4f6' vertical={false} />
              <XAxis dataKey='label' tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false} allowDecimals={false} />
              <Tooltip content={<CustomTooltip />} cursor={{ fill: '#f5f3ff', opacity: 0.5 }} />
              <Legend formatter={(v) => <span className='text-xs text-gray-500'>{v}</span>} />
              <Bar dataKey='booked' name='Booked' stackId='a' fill='#6366f1' radius={[0, 0, 0, 0]} />
              <Bar dataKey='cancelled' name='Cancelled' stackId='a' fill='#fca5a5' radius={[4, 4, 0, 0]} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Monthly Trend — Composed */}
      <div className='bg-white rounded-2xl border border-gray-100 shadow-sm p-5'>
        <div className='flex items-start justify-between mb-4'>
          <div>
            <p className='font-semibold text-gray-800'>Monthly Growth</p>
            <p className='text-xs text-gray-400 mt-0.5'>Appointments &amp; unique patients — last 6 months</p>
          </div>
          <div className='flex gap-4 text-xs text-gray-500'>
            <span className='flex items-center gap-1.5'><span className='w-3 h-3 rounded-sm bg-indigo-400 inline-block'></span>Appointments</span>
            <span className='flex items-center gap-1.5'><span className='w-3 h-3 rounded-full bg-emerald-400 inline-block'></span>Patients</span>
          </div>
        </div>
        <ResponsiveContainer width='100%' height={240}>
          <ComposedChart data={monthlyData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id='patientsGrad' x1='0' y1='0' x2='0' y2='1'>
                <stop offset='0%' stopColor='#10b981' stopOpacity={0.3} />
                <stop offset='100%' stopColor='#10b981' stopOpacity={0.03} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray='3 3' stroke='#f3f4f6' vertical={false} />
            <XAxis dataKey='month' tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
            <YAxis yAxisId='left' tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false} allowDecimals={false} />
            <YAxis yAxisId='right' orientation='right' tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false} allowDecimals={false} />
            <Tooltip content={<CustomTooltip />} cursor={{ fill: '#f5f3ff', opacity: 0.4 }} />
            <Bar yAxisId='left' dataKey='appointments' name='Appointments' fill='#818cf8' radius={[4, 4, 0, 0]} barSize={28} />
            <Area
              yAxisId='right'
              type='monotone'
              dataKey='patients'
              name='Patients'
              stroke='#10b981'
              strokeWidth={2.5}
              fill='url(#patientsGrad)'
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
              <img className='w-10 h-10 rounded-full object-cover object-top border border-gray-100' src={item.docData.image} alt="" />
              <div className='flex-1 min-w-0'>
                <p className='text-sm font-semibold text-gray-800 truncate'>{item.docData.name}</p>
                <p className='text-xs text-gray-400 mt-0.5'>{slotDateFormat(item.slotDate)}</p>
              </div>
              {item.cancelled
                ? <span className='text-xs font-medium px-3 py-1 rounded-full bg-red-50 text-red-500 border border-red-100'>Cancelled</span>
                : item.isCompleted
                  ? <span className='text-xs font-medium px-3 py-1 rounded-full bg-green-50 text-green-600 border border-green-100'>Completed</span>
                  : canCancelAppointment(item)
                    ? <button onClick={() => cancelAppointment(item._id)} className='text-xs font-medium px-3 py-1 rounded-full bg-gray-50 text-gray-500 border border-gray-200 hover:bg-red-50 hover:text-red-500 hover:border-red-200 transition-all'>
                        Cancel
                      </button>
                    // paid appointments cannot be cancelled in the app (no refund flow yet)
                    : <span title={PAID_CANCELLATION_NOTICE} className='text-xs font-medium px-3 py-1 rounded-full bg-blue-50 text-blue-500 border border-blue-100 cursor-help'>Paid</span>
              }
            </div>
          ))
        )}
      </div>

    </div>
  )
}

export default Dashboard
