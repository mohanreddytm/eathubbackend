# Refunds — feature 1

This release adds full and item-based partial refunds for **completed orders with a verified Razorpay payment**. It uses the existing Express authorization middleware, transaction helper and PostgreSQL pool. Counter payments cannot be refunded through Razorpay. The merchant configuration remains **test-only**, for one designated restaurant; live mode is a separate feature.

## Backend code

| File | Responsibility |
|---|---|
| `lib/refunds.js` | Routes, authorization integration, persisted requests, provider verification, status synchronization and signed-webhook handling |
| `lib/refund-amounts.js` | Integer-paise allocation of original prices, discount and tax across returned item quantities |
| `lib/gateway.js` | Existing Razorpay client, refund idempotency header and refund webhook dispatch |
| `lib/security.js` | Admin-only writes; tenant/owner-scoped reads |
| `migrations/003_refunds.sql` | Additive refund ledger and summary columns |
| `lib/migrations.js`, `scripts/database.js` | Apply only pending versions, validate required schema before committing |
| `test/refunds.test.js` | Refund API, authorization, concurrency, provider failure and migration tests |

### API

Use the existing `Authorization: Bearer <token>` header. `orderId` is the saved order ID from the POS URL, not its daily display number. The provider payment ID is read from `payments.transaction_id`; `payments.id` is the internal ledger ID.

**POST `/api/refunds/:orderId`** — restaurant admin only. Send a unique `Idempotency-Key` header (10–100 letters, digits, hyphens or underscores). Reuse the same key AND body when retrying the same action.

Full remaining refund:

```json
{ "kind": "full", "reason": "The entire order was returned" }
```

Partial refund:

```json
{
  "kind": "items",
  "reason": "One dish was returned",
  "items": [{ "line_index": 0, "quantity": 1 }]
}
```

Get `line_index` and available quantities from **GET `/api/refunds/:orderId`**. Indexes refer to saved order lines, so the same menu item at two historical prices is not merged. Do not send an amount or a provider payment ID. The server calculates and verifies these. Amounts below ₹1 and partial selections leaving a nonzero balance below ₹1 are rejected.

The POST response contains `refund`, `refunds`, `refund_status`, `paid_amount_paise`, `refunded_amount_paise`, `pending_amount_paise`, and admin-only `lines`, `can_refund`, `unavailable_reason`, `mode`. HTTP **202** means confirmation is pending; **200** returns the known outcome. Always inspect `refund.status`: a provider-confirmed failure is returned as `failed`, not a successful transfer.

**GET `/api/refunds/:orderId`** — admin, assigned waiter, the owning QR guest, or owning historical customer. Customer responses exclude internal reasons, requesting staff, request keys, provider IDs and diagnostics.

**POST `/api/refunds/:orderId/:refundId/sync`** — admin only, empty JSON body. Fetches a known provider refund, or safely resubmits an uncertain request with its original persisted provider key and payload. It does not create a new refund intent.

### Financial and retry behavior

- The original payment, items, prices, tax and bill total are retained. `payments.payment_status` remains `Paid`/`SUCCESS` to prevent collecting the same order again.
- Only provider-confirmed `processed` refunds increase `refunded_amount`. Partial refunds keep `orders.status = 'Completed'` and set `refund_status = 'Partially Refunded'`.
- A fully processed refund sets both `orders.status` and `orders.order_status` to **`Refunded`**. Refunded orders stay out of kitchen queues and do not occupy tables.
- `requested`, `unknown` and `pending` reserve the amount and quantities. One unresolved refund per order is enforced by both a tenant transaction lock and a unique index. A confirmed `failed` refund releases its reservation.
- The request is committed before calling Razorpay. Its UUID is sent as `X-Refund-Idempotency`. A network timeout is not treated as proof that the refund failed. Same-key retries preserve the exact payload.
- Signed `refund.created`, `refund.processed` and `refund.failed` events update the ledger. Pending events cannot regress processed/failed records; duplicate capture callbacks cannot undo a refund.
- Provider amount, currency, payment ID and original provider order are checked. Previously issued outside refunds block a new request; reconciliation is deliberately not implemented in this feature.

## Frontend code

In the separate `frontend/eathubfrontone` repository:

| File | Responsibility |
|---|---|
| `src/workspace/Refunds.js` | Admin full/partial dialog, reason and amount review, retry recovery, status polling, customer-safe refund history |
| `src/workspace/refunds.css` | Responsive refund controls and light/dark styles |
| `src/components/RestaurentDashboard/POS/OrderActions.js` | Refund entry on completed paid order details |
| `src/workspace/POS.js` | Passes the authenticated workspace role into order actions |
| `src/workspace/Guest.js` | Customer tracking and refunded-order display |
| `src/workspace/Operations.js` | Refunded order filter, refund summaries and net payment totals |
| `src/utils/api.js` | Existing authenticated API client; retains HTTP status for safe retry decisions |
| `src/workspace/Refunds.test.js`, `e2e/refunds.cjs` | Component tests and full browser refund workflow |

The frontend keeps the current repository's React/react-scripts build, hooks and CSS. No TypeScript, Redux, new application dependency or folder restructuring is introduced. Refund forms show loading/error/empty states and preserve the original request key across uncertain responses and same-tab reloads.

## Schema changes

Migration 003 adds:

- `orders.refunded_amount numeric(12,2)`, `orders.refund_status text`.
- `payments.refunded_amount numeric(12,2)`.
- `order_refunds`: immutable request identity/body, original payment reference, selected quantities, amount in paise, admin reason/identity, provider reference, state and timestamps.
- Unique restaurant/request keys, unique provider refund IDs, and one unresolved refund per order.

The existing migration command applies versions 002 and 003 only if missing, inside its advisory-locked transaction. A schema validation error rolls back that transaction. This is **not** the future automatic backup/integrity-reconciliation tool. Take your normal backup before applying to Neon. Do not drop the refund ledger or its financial history to roll back application code.

## Configure and run

1. Update both pinned repositories through AK47 and install dependencies.
2. Back up the target database. With the existing backend `DATABASE_URL` and `JWT_SECRET` configured, run `npm run db:migrate`, then `npm run db:check`.
3. Set these backend environment variables using your merchant **test** account:

```dotenv
RAZORPAY_KEY_ID=rzp_test_your_key
RAZORPAY_KEY_SECRET=your_test_secret
RAZORPAY_RESTAURANT_ID=the_restaurant_id
RAZORPAY_WEBHOOK_SECRET=your_webhook_secret
```

4. In the Razorpay test dashboard, configure `https://<your-backend>/webhooks/razorpay` for `payment.captured`, `refund.created`, `refund.processed`, `refund.failed`. Use the matching webhook secret. Localhost requires a reachable development URL for webhook delivery; the admin **Check status** action also works without incoming webhooks.
5. Start the matching API and frontend. Admin → Orders → open a completed online-paid order → **Refund**. Choose full balance or returned quantities, enter a reason, review the amount, confirm. The customer sees the refund in their order tracker. Payment reports retain gross receipts and show processed refunds and net collected separately.

## How to test

Backend (disposable PGlite database and mocked provider; no Neon or money):

```sh
npm ci
npm test
```

The refund suite covers role/tenant/guest ownership, unsupported payments, input tampering, partial tax/discount allocation, idempotency conflicts, pending reservations, duplicate/out-of-order and forged webhooks, lost provider responses, failed refunds, outside refund mismatches, concurrent requests, late capture callbacks and repeatable migrations. PGlite serializes connections; a real multi-connection PostgreSQL load test remains a deployment check.

From the matching frontend:

```sh
npm ci
CI=true npm test -- --watchAll=false --runInBand
npm run build
npx playwright install chromium
npm run test:e2e:refunds
```

The browser test starts `test/refund-browser-server.js` on localhost:8000, serves the built UI on localhost:3000, and exercises real app login/routes/database plus simulated Razorpay HTTP. It checks partial → pending → processed → remaining full refund, page reload, customer visibility and mobile light/dark layouts. Keep both ports free. Its fictional test merchant and hardcoded test credentials are used only by this standalone fixture, never the production startup path. Screenshots go to the frontend's ignored `e2e-results/` directory.

Also run the existing frontend `npm run test:e2e` to exercise the five-role order workflow. To test real integration, use your merchant test account to capture a test payment, complete service, refund one item, check provider status and customer history, then refund the remaining balance. Verify matching amounts/IDs in Razorpay. No actual merchant credentials or live database were used during development.

Provider references: [normal refunds](https://razorpay.com/docs/api/refunds/create-normal/), [idempotent refunds](https://razorpay.com/docs/api/refunds/normal-refunds-idempotent/), [refund webhooks](https://razorpay.com/docs/webhooks/refunds/).
