# Razorpay configuration and payment operations

This covers what the slot-reservation / online-payment flow needs from Razorpay,
and how to handle the cases the backend flags for a human.

## Environment variables (backend)

| Variable | Required | Purpose |
|---|---|---|
| `MONGODB_DB_NAME` | yes in production | Database name. Defaults to `prescripto_test` (local testing); production must set `prescripto`. |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | yes | API keys. Use `rzp_test_…` keys in Test Mode, `rzp_live_…` in production. |
| `CURRENCY` | yes | Order currency, e.g. `INR`. |
| `RAZORPAY_WEBHOOK_SECRET` | strongly recommended | Secret set on the webhook in the dashboard. Without it the webhook route returns 503. |
| `RESERVATION_EXPIRY_MINUTES` | no (default 10) | Online-payment hold duration. |
| `RAZORPAY_TIMEOUT_MS` | no (default 20000) | Per-request timeout for Razorpay API calls. Capped at 75000 (a quarter of the 5-minute refund lease). |
| `ORDER_RECONCILE_LOOKBACK_HOURS` | no (default 48) | How far back the order sweep re-checks online reservations. |

Frontend: `VITE_RAZORPAY_KEY_ID` must be the same key id as `RAZORPAY_KEY_ID`.

## Local Razorpay Test Mode

1. Dashboard: switch to **Test Mode**, then generate test API keys (`rzp_test_…`). Never use `rzp_live_…` locally.
2. `backend/.env`: set `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and `CURRENCY=INR`. Leave `MONGODB_DB_NAME` unset;
   the default is `prescripto_test`.
3. `frontend/.env`: set `VITE_RAZORPAY_KEY_ID` to the same `rzp_test_…` key id, and `VITE_BACKEND_URL`
   to the local backend URL. Restart Vite after changing it.
4. Webhook (optional locally, recommended):
   - Razorpay can only call a public HTTPS URL. To receive webhooks locally, expose the backend through a
     tunnel (for example ngrok or cloudflared) or a staging deploy.
   - Add a **Test Mode** webhook to `https://<tunnel-host>/api/user/razorpay-webhook` with the four events
     listed under "Webhook" below.
   - Choose any random secret and set the same value as `RAZORPAY_WEBHOOK_SECRET`.
   - Without a webhook, payments are still verified by the browser callback and by the reconciliation jobs
     (within a few minutes), and refund statuses are polled on the backoff schedule.
5. Pay with the test card / UPI details listed in Razorpay's Test Mode documentation. Their success and
   failure test instruments let you exercise both outcomes.

How to verify each outcome (backend log, `prescripto_test` and Razorpay dashboard → Payments / Refunds):

| Scenario | Expected result |
|---|---|
| Successful payment | Appointment `status: confirmed`, `payment: true`. Payment `captured` in the dashboard. |
| Failed payment | Appointment `status: failed`, slot free again for another user. |
| Abandon checkout | Slot stays unavailable; after 10 min the appointment is `expired`, `paymentStatus: unpaid`, and the slot is free. |
| Pay after expiry, slot rebooked | Appointment stays expired. A refund appears in the dashboard (`pending`, then `processed`). `paymentStatus` becomes `refunded`. |
| Second click / duplicate webhook | No second confirmation and no second refund. |

## Payment capture

The backend does **not** assume the account captures payments automatically:

- A **captured** payment is settled normally (confirm, or late-payment re-claim / refund).
- An **authorized-only** payment is captured by the backend (`payments.capture`) only while
  its reservation still holds the slot. Then it is confirmed.
- An authorized-only payment for a reservation that has expired, failed or been cancelled is
  **never captured**. The appointment records `uncapturedPaymentId`, and Razorpay releases the
  uncaptured amount back to the customer according to the account's capture settings.

Recommended dashboard setting: **Account & Settings → Capture settings → Automatic capture**,
with an automatic-capture window longer than `RESERVATION_EXPIRY_MINUTES`. Manual capture also
works with this backend, but customers whose reservation lapsed see a temporary authorization
hold until Razorpay releases it.

## Webhook

Dashboard → **Account & Settings → Webhooks → Add new webhook**

- URL: `https://<backend-host>/api/user/razorpay-webhook`
- Secret: the same value as `RAZORPAY_WEBHOOK_SECRET`
- Active events:
  - `payment.captured`
  - `order.paid`
  - `refund.processed`
  - `refund.failed`

The webhook only triggers processing. The backend re-reads the order, payment and refunds
from the Razorpay API and never trusts the event body. Duplicate and out-of-order deliveries
are safe.

Webhooks are not the only safety net. Every minute the backend re-checks the Razorpay orders of
online reservations from the last `ORDER_RECONCILE_LOOKBACK_HOURS` that are no longer pending,
with a backoff of 2 min, 10 min, 30 min, 2 h, 6 h, then every 12 h. A late or duplicate payment
is therefore settled (re-confirmed or refunded) even if the webhook is missing.

## Refund states

The `refunds` collection holds one record per Razorpay payment (unique `paymentId`).

| `status` | Meaning | What happens |
|---|---|---|
| `pending` | Refund intent recorded, or Razorpay reports the refund `pending` | Re-checked on a backoff (5 min, 15 min, 1 h, 3 h, then every 6 h), or immediately on a `refund.*` webhook. |
| `processed` | Razorpay reports every covering refund as `processed` | Final. |
| `failed` | An attempt errored or timed out | Retried on a backoff (1, 2, 5, 15, 30, 60 min). Razorpay refunds are always re-read first, so a timed-out refund is never requested twice. |
| `manual_required` | `MAX_REFUND_ATTEMPTS` (10) failed attempts | No more automatic attempts. Needs a human. |

Late-payment appointments mirror this as `paymentStatus` `refund_pending` / `refunded` / `refund_failed`.

## Manual reconciliation

Find what needs attention (mongosh):

```js
db.refunds.find({ status: 'manual_required' })
db.appointments.find({ refundStatus: 'manual_required' })        // intent without a resolvable payment id
db.appointments.find({ uncapturedPaymentId: { $exists: true } }) // authorized, deliberately not captured
```

**`manual_required` refund record**
1. In the Razorpay dashboard, open the payment (`paymentId`) and check its refunds.
2. If the full amount is already refunded and processed, the next automatic check marks it
   `processed` once you set `db.refunds.updateOne({ paymentId }, { $set: { status: 'pending', attempts: 0 }, $unset: { nextAttemptAt: 1 } })`.
3. Otherwise fix the cause shown in `lastError` (keys, account balance, payment state) and run the
   same command to re-enable automatic processing. It never refunds more than the uncovered amount.

**Appointment with `refundStatus: 'manual_required'` (no payment id)**
1. Find the payment in the Razorpay dashboard (search by order id `razorpayOrderId`, or receipt = appointment id).
2. Set it and let cron resume:
   `db.appointments.updateOne({ _id: ObjectId('<id>') }, { $set: { refundPaymentId: '<pay_id>', refundAmount: <paise> }, $unset: { refundRecordedAt: 1 } })`

## Legacy data migration

`scripts/reconcileDuplicateSlots.js` is a dry run by default. `--apply` refuses to run unless the
target is named explicitly, e.g. `MONGODB_DB_NAME=prescripto_test node scripts/reconcileDuplicateSlots.js --apply`.
Paid duplicates are reported as UNRESOLVED and are never cancelled or refunded automatically.

## Indexes

On startup the backend creates and verifies:
- `appointments` `{docId, slotDate, slotTime}`, unique, partial `{slotLocked: true}`
- `refunds` `{paymentId}`, unique

It refuses to start if they cannot be created or verified. It never drops indexes.

The obsolete index `appointments.refund_reconcile` (created by an earlier development build) is
reported at startup. Drop it manually after review: `db.appointments.dropIndex('refund_reconcile')`.
