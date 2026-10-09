# EatHub workspace release 2.0

Run this backend with the frontend pinned in the AK47 repository. The release adds routed workspaces, repairs POS/schema compatibility, and preserves the earlier security and payment-integrity fixes.

## Local setup with your existing database

Use Node 20 or later. From the AK47 root, run `npm run setup`. This installs both projects, creates missing local environment files, and generates a local JWT secret. Existing environment values are preserved.

1. Put your Neon connection string in `backend/eathubbackend/.env` as `DATABASE_URL`. Keep the SSL parameters supplied by Neon. Never commit or send the connection string in chat.
2. Check that `JWT_SECRET` has at least 32 random bytes. To generate it separately: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`.
3. Back up the database. Run `migrations/preflight.sql` in your SQL console and resolve invalid monetary amounts, orphan references and duplicate successful payments. Verify historical UPI/payment receipts against your records before reconciling them.
4. From the AK47 root run `npm run db:migrate`, then `npm run db:check`. From this backend folder the same script names work. Pending migrations **002 and 003** run together. Migration **002** handles both the supplied legacy schema and databases that already ran migration 001. Do not run 001 separately for this release.
5. Run `npm run dev` from the root to start the backend and frontend together. The frontend uses `http://localhost:8000` locally. Set `REACT_APP_API_BASE_URL` explicitly if you change the backend address, and restart React.
6. Sign in again; legacy tokens are intentionally incompatible with the repaired authorization rules.

`GET /health` returns `{"status":"ready","version":"2.0.0"}` when the connection and required schema are ready. A schema mismatch returns 503 with a safe user message; the backend terminal gives the request ID and diagnostic details. Missing `DATABASE_URL` or an invalid JWT secret prevents startup. Fix the configuration instead of hardcoding a secret in `app.js`.

### What migration 002 does

The supplied old schema stores order numbers as integers. New order numbers look like `0913-1`, so an integer column causes order creation to fail. The repeatable migration changes order and payment order-number columns to text, adds table availability and billing/KOT fields, normalizes statuses, creates daily counters and indexes, and adds the test-payment provider reference. It preserves existing order IDs and item history. Rerunning it never decreases a daily counter. Invalid existing amounts or duplicate successful payments cause the transaction to roll back; correct those records and retry. Do not bypass the constraints.

The migration expects the application's existing 14 tables. It is an upgrade, not a complete production database bootstrap. A fresh developer can use the local demo described below.

## Local demo without Neon

From the AK47 root run `npm run demo`, or run `npm run demo` here and start the frontend separately. The demo binds to the loopback interface, uses fictional restaurant/menu/table data in temporary embedded PostgreSQL, and never opens a Neon connection. Data resets when stopped. Demo mode refuses `NODE_ENV=production`.

| Role | Email |
|---|---|
| Restaurant admin | admin@demo.invalid |
| Waiter | waiter@demo.invalid |
| Kitchen | kitchen@demo.invalid |
| Platform admin | super@demo.invalid |

All demo accounts use `EatHubDemo123!`. These are demonstration credentials only. Guest entrance: `http://localhost:3000/tables/demo`; QR table: `http://localhost:3000/customerDashboard/table1/demo/home`.

## Payment and order behavior

- Menu prices, discounts, tax and final totals are validated on the server. Daily numbers use a restaurant/date counter and transaction lock. Routes and APIs identify orders by their UUID, not the visible daily number.
- Kitchen progression is Pending/Confirmed → Preparing → Ready. Staff confirm receipt of payment. Payment at Ready completes the order; prepayment keeps the kitchen ticket active. Once ready, staff use **Mark served & complete** for a prepaid order.
- Additional KOTs preserve historical prices and send only the new batch after Ready. Unfinished batches stay in the kitchen queue. Settled bills cannot be edited.
- Customers can request Cash or UPI payment; requests remain Pending until staff verify actual receipt. Physical card-terminal payments also require staff verification. Confirmation is atomic and prevents a second successful payment for the same order.
- Cancellation retains order history and closes pending counter-payment requests. A paid order requires a refund workflow and cannot be cancelled here. Orders with pending provider checkout are protected from cancellation while capture could still occur.
- Reservation windows include 30 minutes before and two hours after the booking, including across midnight. Seat the reservation before ordering at that table. Table status follows active orders; one completed bill does not free a table with another active order.
- Waiters receive only their assigned orders/payments/requests. Busy pauses new auto-assignments and returns/reassigns pending requests. Team members with order history should be deactivated, not deleted.

## Optional Razorpay test checkout

Set `RAZORPAY_KEY_ID` (must start with `rzp_test_`), `RAZORPAY_KEY_SECRET`, and `RAZORPAY_RESTAURANT_ID` in the backend environment. This release supports one designated restaurant per merchant configuration. Other restaurants keep counter payment. For captured-payment recovery, set `RAZORPAY_WEBHOOK_SECRET` and register `POST https://<backend-host>/webhooks/razorpay` for `payment.captured` in the provider's test dashboard.

The UI shows **Pay online · TEST** only when configured. The server creates the provider order from its own bill total. Verification uses the stored provider order ID, HMAC signature and server-fetched payment status, currency and amount. Only captured payments settle the bill. Webhooks verify the raw request signature and are safe to retry. Pending checkouts are reused rather than duplicated. A staff button cannot manually confirm a provider payment.

Reference: [Razorpay Standard Checkout integration](https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/).

Full and item-based partial test refunds are available for completed Razorpay-paid orders; see [refund setup, API and tests](REFUNDS.md). No live-money checkout, marketplace settlement across restaurants, or automated reconciliation is enabled. Real provider credentials and webhook delivery must be tested in your merchant test account before enabling a public environment. Provider calls in this release's automated suite are mocked; no money was transferred.

## Hosting and verification

Use `NODE_ENV=production`, a strong rotated JWT secret, your database URL, `RESTAURANT_TIMEZONE=Asia/Kolkata`, and `CORS_ORIGINS` containing your frontend origin. Deploy the matching frontend with `REACT_APP_API_BASE_URL` set at build time. Apply the schema upgrade before switching real traffic. Do not deploy the local demo server.

If credentials from an earlier commit have not yet been rotated, rotate them in Neon/hosting settings. Removing a secret from the latest code does not remove it from Git history. Reset any previous default super-admin password with `reset_super_admin_password.js`, setting `SUPER_ADMIN_EMAIL` and a new `SUPER_ADMIN_PASSWORD` temporarily. The public initialization API remains removed.

`npm test` runs 32 API/migration/payment/refund regressions against disposable PGlite fixtures. The frontend adds URL and receipt tests and a browser smoke workflow. Embedded PostgreSQL serializes connections; test real multi-connection load, your full historical Neon data, your actual printer and provider test account separately. Rate limits use process-local memory; a horizontally scaled deployment needs a shared limiter or host-level limits.

If migration fails, the transaction rolls back. Resolve the reported data issue and rerun. After migration, keep the paired release: the old backend's integer-numbering query is incompatible with text order numbers. Do not silently restore old credentials or mark historical payment rows successful.
