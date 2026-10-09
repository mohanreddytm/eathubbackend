-- Additive refund ledger. Apply in the migration runner's transaction.
-- The original bill and captured payment remain immutable financial history.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0),
  ADD COLUMN IF NOT EXISTS refund_status text NOT NULL DEFAULT 'None';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS refunded_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0);

CREATE TABLE IF NOT EXISTS order_refunds (
  id text PRIMARY KEY,
  restaurant_id text NOT NULL REFERENCES restaurant_admin(id),
  order_id varchar(50) NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  payment_id varchar(255) NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  provider_payment_id text NOT NULL,
  provider_refund_id text UNIQUE,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('full','items')),
  items jsonb NOT NULL,
  amount_paise integer NOT NULL CHECK (amount_paise >= 100),
  currency text NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','unknown','pending','processed','failed')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  requested_by text NOT NULL,
  provider_request jsonb NOT NULL,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (restaurant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS refunds_order_created ON order_refunds(order_id, created_at);
-- One unresolved refund per order also prevents double-clicks with different keys.
CREATE UNIQUE INDEX IF NOT EXISTS refunds_one_unresolved_per_order ON order_refunds(order_id)
  WHERE status IN ('requested','unknown','pending');
INSERT INTO eathub_schema_versions(version) VALUES(3) ON CONFLICT DO NOTHING;
