// Cancellation rules for the UI. The backend enforces the same rule and is authoritative.
// A paid appointment (payment === true) cannot be cancelled in the app until refunds exist.

export const PAID_CANCELLATION_NOTICE = 'Paid appointments cannot be cancelled in the app at the moment. Please contact support for assistance.'

export const isPaidAppointment = (item) => item?.payment === true

export const canCancelAppointment = (item) =>
  Boolean(item) && !item.cancelled && !item.isCompleted && !isPaidAppointment(item)
