// Cancellation rules for the admin and doctor panels. The backend enforces the same rule
// and is authoritative. A paid appointment (payment === true) cannot be cancelled in the
// app until refunds exist.

export const PAID_CANCELLATION_NOTICE = 'Paid appointments cannot be cancelled in the app at the moment. Refunds must be handled through support.'

export const isPaidAppointment = (item) => item?.payment === true

export const canCancelAppointment = (item) =>
  Boolean(item) && !item.cancelled && !item.isCompleted && !isPaidAppointment(item)
