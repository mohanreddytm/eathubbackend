-- One-time migration. Back up first; malformed money or duplicate successful payments abort it.
BEGIN;
ALTER TABLE orders ALTER COLUMN total_price TYPE numeric(12,2) USING total_price::numeric,
 ALTER COLUMN tax_amount TYPE numeric(12,2) USING NULLIF(tax_amount,'')::numeric,
 ALTER COLUMN discount_amount TYPE numeric(12,2) USING NULLIF(discount_amount,'')::numeric;
ALTER TABLE restaurant_menu_items ALTER COLUMN price TYPE numeric(12,2) USING price::numeric;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'Pending',
 ADD COLUMN IF NOT EXISTS payment_method text, ADD COLUMN IF NOT EXISTS kot_items jsonb,
 ADD COLUMN IF NOT EXISTS tax_mode text NOT NULL DEFAULT 'exclusive', ADD COLUMN IF NOT EXISTS tax_percent numeric(5,2);
ALTER TABLE orders ADD CONSTRAINT orders_amounts_valid CHECK(total_price>=0 AND COALESCE(discount_amount,0)>=0 AND COALESCE(discount_amount,0)<=total_price AND COALESCE(tax_amount,0)>=0),
 ADD CONSTRAINT orders_tax_mode_valid CHECK(tax_mode IN ('inclusive','exclusive'));
CREATE TABLE restaurant_order_counters (restaurant_id text NOT NULL REFERENCES restaurant_admin(id),order_date date NOT NULL,last_number integer NOT NULL CHECK(last_number>=0),PRIMARY KEY(restaurant_id,order_date));
INSERT INTO restaurant_order_counters
 SELECT restaurant_id,(created_at AT TIME ZONE 'Asia/Kolkata')::date,MAX(CASE WHEN order_number ~ '^[0-9]+$' THEN order_number::integer WHEN order_number ~ '^[0-9]{4}-[0-9]+$' THEN split_part(order_number,'-',2)::integer ELSE 0 END)
 FROM orders GROUP BY restaurant_id,(created_at AT TIME ZONE 'Asia/Kolkata')::date;
ALTER TABLE reservations DROP CONSTRAINT reservations_status_check;
ALTER TABLE reservations ADD CONSTRAINT reservations_status_check CHECK(status IN ('pending','success','confirmed','seated','completed','cancelled'));
ALTER TABLE reservations ALTER COLUMN table_id DROP NOT NULL;
ALTER TABLE waiter_requests ALTER COLUMN table_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS orders_restaurant_created ON orders(restaurant_id,created_at);
CREATE INDEX IF NOT EXISTS orders_table_status ON orders(table_id,status);
CREATE INDEX IF NOT EXISTS reservations_table_date_time ON reservations(table_id,date,time);
CREATE UNIQUE INDEX payments_one_success_per_order ON payments(order_id) WHERE payment_status IN ('Paid','SUCCESS');
-- Do not auto-confirm old 'Paid' records: the previous UI could generate them without receipt.
COMMIT;
