import cron from 'node-cron'
import { cleanupExpiredReservations, reconcileLatePayments, reconcileRecentOnlineOrders, repairSlotConsistency } from '../utils/slotReservation.js'

let running = false
let tick = 0

// Runs every minute. The backend expiry checks (booking + slot listing) remain the
// source of truth; this job only persists the 'expired' state, reconciles
// Razorpay payments (without relying on webhooks), releases slots and retries
// refunds. Safe to run on multiple instances: every step is conditional/leased.
const startReservationCleanup = () => {
    return cron.schedule('* * * * *', async () => {
        if (running) return // avoid overlapping runs in this process
        running = true
        try {
            const { checked, expired, reconciled } = await cleanupExpiredReservations()
            if (checked > 0) {
                console.log(`Reservation cleanup: checked ${checked}, expired ${expired}, reconciled ${reconciled}`)
            }
            // re-check Razorpay orders of recent non-pending online reservations (bounded, backoff)
            const orders = await reconcileRecentOnlineOrders()
            if (orders.settled > 0) {
                console.log(`Order reconcile: checked ${orders.checked}, settled ${orders.settled}`)
            }
            // resume crashed late-payment settlements and process due refunds
            const { resumed, refundsProcessed } = await reconcileLatePayments()
            if (resumed > 0 || refundsProcessed > 0) {
                console.log(`Payment reconcile: resumed ${resumed}, refunds processed ${refundsProcessed}`)
            }
            // every 5 minutes: repair appointment <-> slots_booked inconsistencies left by crashes
            if (tick++ % 5 === 0) {
                const { added, released } = await repairSlotConsistency()
                if (added > 0 || released > 0) {
                    console.log(`Slot repair: re-added ${added}, released ${released}`)
                }
            }
        } catch (error) {
            console.error('Reservation cleanup error:', error?.message || error)
        } finally {
            running = false
        }
    })
}

export default startReservationCleanup
