# EatHub audit repair release

This backend and the matching frontend branch must deploy together. These commits do not rotate provider credentials, migrate Neon, or deploy the production services.

## Before deployment

1. Rotate the exposed Neon database password in the Neon dashboard. Removing it from current source does not remove it from Git history. Update the backend host's `DATABASE_URL` with the rotated connection string. Do not paste credentials into GitHub, a PR, or chat.
2. Generate a fresh `JWT_SECRET` with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` and set it in the host environment. Old sessions intentionally stop working. The backend requires at least 32 bytes and has no fallback.
3. Reset the default super-admin password using `reset_super_admin_password.js`, with `SUPER_ADMIN_EMAIL` and a new `SUPER_ADMIN_PASSWORD` of at least 12 characters supplied temporarily through the environment. Clear those two environment variables afterwards. The public initialization endpoint has been removed.
4. Back up the database. Run `migrations/preflight.sql` on the existing text-column schema. Resolve malformed amounts, discounts larger than subtotals, orphan restaurant references, duplicate successful payment rows, and legacy status values before proceeding. Verify which historical payments were actually received; the old UI could mark UPI paid without a transfer.
5. During a coordinated maintenance window, run `migrations/001_audit_integrity.sql` once with `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/001_audit_integrity.sql`. It is transactional and intentionally aborts on inconsistent data. It is not a repeatable migration runner. No production database was modified while preparing this release.
6. Set `RESTAURANT_TIMEZONE=Asia/Kolkata`, `NODE_ENV=production`, and Node 20 or later. Counter seeding explicitly uses Asia/Kolkata; change both the migration and runtime setting together if operating elsewhere. CORS currently permits localhost:3000, the existing EatHub frontend, and the original TableTrack frontend; remove origins you no longer operate.
7. Deploy the matching frontend with `REACT_APP_API_BASE_URL` pointing at this backend. Its fetch helper supplies the appropriate role token; the old frontend will fail against the secured API.

## Changed behavior

- Staff/admin access requires signed role and restaurant claims. Staff accounts and restaurant suspension are checked on each request. Password hashes and raw database error details are removed from JSON responses.
- QR users receive an eight-hour table-bound session, stored per tab. Orders belong to that session; a new tab or expired session cannot read previous diners' orders. Existing anonymous orders are not automatically claimed.
- Menu prices and payment totals come from the server. Daily numbers use a persisted per-restaurant/date counter and transaction lock. The visible format is MMDD-counter; identify orders by their UUID in API calls.
- Order status and kitchen status advance together. Additional KOT items retain historical prices and keep a separate pending kitchen item list.
- Payments requested by customers remain Pending. Cash, UPI and physical card-terminal receipts require staff verification. Confirmation updates payment, order, and table in one transaction and prevents duplicate successful payments. Pending payments must be resolved before editing a bill.
- Cancel Order retains history. Paid orders cannot be cancelled through this action. Restaurant deletion is limited to empty accounts; use deactivate/suspend for accounts with business records. Active orders/reservations prevent physical table/area deletion.
- Reservation windows use full date-time values, from 30 minutes before until 2 hours after, including midnight. Seating releases the reservation block for ordering. The entrance page is `/tables/:restaurantId`.

## Validation

`npm ci` then `npm test` runs API regression tests with PGlite and fictional schema fixtures. No real DATABASE_URL is opened by the test suite. PGlite uses a single connection, so full transactions are serialized in the test adapter. Test multiple actual Postgres connections under load in staging before making production concurrency guarantees.

Run the frontend production build and `CI=true npm test -- --watchAll=false --runInBand --testPathPattern=OrderActions.test.js`. Existing Create React App lint warnings are not treated as new features or fixed by this release.

Staging acceptance: sign in as each role; reject another restaurant's IDs; scan a QR; create an order; add KOT items after Ready; apply discount and both tax modes; print a bill; submit/confirm a payment twice; reserve across midnight; mark seated; cancel an unpaid order. Check receipt layout on the actual printer.

## Remaining work / external setup

- Razorpay is not integrated in this repair release. A merchant-account/settlement design for multiple restaurants, test keys and webhook configuration are needed. The repaired UI does not pretend that clicking UPI constitutes a verified payment.
- Refunds, historical payment reconciliation, and expired guest-session recovery need explicit product rules. They are not silently implemented as deleting financial records.
- Rate limits currently use process-local memory. Configure a shared rate-limit store or host-level limits when scaling horizontally; configure trusted proxies narrowly for the actual host.
- Browser/popup/printer behavior and full multi-connection load still require staging validation. Unit/UI tests are not evidence of live deployment.

## Recovery

If migration validation fails, the transaction rolls back; resolve data and retry during maintenance. After a successful migration, do not deploy the old insecure backend: its integer numbering query is incompatible with text order numbers and its clients bypass payment verification. Keep maintenance enabled and fix forward, or restore the database backup and a known-secure paired release. Never restore leaked credentials.
