-- Read-only checks before 001_audit_integrity.sql. Resolve every returned row first.
SELECT id, total_price, tax_amount, discount_amount FROM orders
WHERE total_price !~ '^[0-9]+(\.[0-9]+)?$'
 OR (COALESCE(tax_amount,'')<>'' AND tax_amount !~ '^[0-9]+(\.[0-9]+)?$')
 OR (COALESCE(discount_amount,'')<>'' AND discount_amount !~ '^[0-9]+(\.[0-9]+)?$');
SELECT id,price FROM restaurant_menu_items WHERE price !~ '^[0-9]+(\.[0-9]+)?$';
SELECT order_id,COUNT(*) FROM payments WHERE payment_status IN ('Paid','SUCCESS') GROUP BY order_id HAVING COUNT(*)>1;
SELECT id,restaurant_id FROM orders WHERE NOT EXISTS (SELECT 1 FROM restaurant_admin r WHERE r.id=orders.restaurant_id);
SELECT status,order_status,COUNT(*) FROM orders GROUP BY status,order_status ORDER BY status,order_status;
-- Existing payment flags came from an unverified client flow. Reconcile receipt against
-- bank/cash records before confirming any legacy order; this script never marks it paid.
