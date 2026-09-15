-- Repeatable upgrade for both the supplied legacy schema and the first audit release.
-- The caller owns the transaction. Never reconcile historical payments automatically.
ALTER TABLE orders ALTER COLUMN order_number TYPE text USING order_number::text;
ALTER TABLE payments ALTER COLUMN order_number TYPE text USING order_number::text;
ALTER TABLE orders ALTER COLUMN total_price TYPE numeric(12,2) USING NULLIF(total_price::text,'')::numeric,
  ALTER COLUMN tax_amount TYPE numeric(12,2) USING NULLIF(tax_amount::text,'')::numeric,
  ALTER COLUMN discount_amount TYPE numeric(12,2) USING NULLIF(discount_amount::text,'')::numeric;
ALTER TABLE restaurant_menu_items ALTER COLUMN price TYPE numeric(12,2) USING price::text::numeric;
ALTER TABLE restaurant_tables ADD COLUMN IF NOT EXISTS current_status text NOT NULL DEFAULT 'available';
ALTER TABLE restaurant_tables ADD COLUMN IF NOT EXISTS last_used_at timestamp;
ALTER TABLE restaurant_admin ADD COLUMN IF NOT EXISTS payment_settings jsonb DEFAULT '{}';
ALTER TABLE restaurant_admin ADD COLUMN IF NOT EXISTS display_settings jsonb DEFAULT '{}';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'Pending',
  ADD COLUMN IF NOT EXISTS payment_method text, ADD COLUMN IF NOT EXISTS kot_items jsonb,
  ADD COLUMN IF NOT EXISTS tax_mode text NOT NULL DEFAULT 'exclusive',
  ADD COLUMN IF NOT EXISTS tax_percent numeric(5,2);
UPDATE orders SET status=CASE lower(status) WHEN 'kot' THEN 'Confirmed' WHEN 'canceled' THEN 'Cancelled' ELSE initcap(status) END;
UPDATE orders SET order_status=CASE WHEN status IN ('Preparing','Ready','Completed','Cancelled') THEN status ELSE 'KOT' END;
ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'Pending';
UPDATE orders SET tax_mode='exclusive' WHERE tax_mode IS NULL OR tax_mode='';
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_amounts_valid;
ALTER TABLE orders ADD CONSTRAINT orders_amounts_valid CHECK(total_price>=0 AND COALESCE(discount_amount,0)>=0 AND COALESCE(discount_amount,0)<=total_price AND COALESCE(tax_amount,0)>=0);
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_tax_mode_valid;
ALTER TABLE orders ADD CONSTRAINT orders_tax_mode_valid CHECK(tax_mode IN ('inclusive','exclusive'));
CREATE TABLE IF NOT EXISTS restaurant_order_counters(restaurant_id text NOT NULL REFERENCES restaurant_admin(id),order_date date NOT NULL,last_number integer NOT NULL CHECK(last_number>=0),PRIMARY KEY(restaurant_id,order_date));
INSERT INTO restaurant_order_counters
  SELECT restaurant_id,(created_at AT TIME ZONE 'Asia/Kolkata')::date,MAX(CASE WHEN order_number ~ '^[0-9]+$' THEN order_number::integer WHEN order_number ~ '^[0-9]{4}-[0-9]+$' THEN split_part(order_number,'-',2)::integer ELSE 0 END)
  FROM orders GROUP BY restaurant_id,(created_at AT TIME ZONE 'Asia/Kolkata')::date
  ON CONFLICT(restaurant_id,order_date) DO UPDATE SET last_number=GREATEST(restaurant_order_counters.last_number,EXCLUDED.last_number);
ALTER TABLE reservations DROP CONSTRAINT IF EXISTS reservations_status_check;
ALTER TABLE reservations ADD CONSTRAINT reservations_status_check CHECK(status IN ('pending','success','confirmed','seated','completed','cancelled'));
ALTER TABLE reservations ALTER COLUMN table_id DROP NOT NULL;
ALTER TABLE waiter_requests ALTER COLUMN table_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS orders_restaurant_created ON orders(restaurant_id,created_at);
CREATE INDEX IF NOT EXISTS orders_table_status ON orders(table_id,status);
CREATE INDEX IF NOT EXISTS reservations_table_date_time ON reservations(table_id,date,time);
CREATE UNIQUE INDEX IF NOT EXISTS payments_one_success_per_order ON payments(order_id) WHERE payment_status IN ('Paid','SUCCESS');
CREATE TABLE IF NOT EXISTS eathub_schema_versions(version integer PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now());
INSERT INTO eathub_schema_versions(version) VALUES(2) ON CONFLICT DO NOTHING;

ALTER TABLE payments ADD COLUMN IF NOT EXISTS provider_order_id text;
CREATE UNIQUE INDEX IF NOT EXISTS payments_provider_order_id ON payments(provider_order_id) WHERE provider_order_id IS NOT NULL;
