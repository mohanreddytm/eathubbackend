-- Update payments table to support UPI payment flow
-- Run this SQL in your PostgreSQL database

-- Add upi_id column if it doesn't exist
ALTER TABLE payments ADD COLUMN IF NOT EXISTS upi_id VARCHAR(255);

-- Update payment_status check constraint to include new statuses
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_payment_status_check;
ALTER TABLE payments ADD CONSTRAINT payments_payment_status_check 
    CHECK (payment_status IN ('INITIATED', 'PENDING_CONFIRMATION', 'SUCCESS', 'FAILED', 'Paid', 'Pending', 'Failed'));

-- Update payment_method check constraint to include 'Online'
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_payment_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_payment_method_check 
    CHECK (payment_method IN ('Cash', 'UPI', 'Card', 'Online'));

-- Create index for faster queries on payment_status
CREATE INDEX IF NOT EXISTS idx_payments_payment_status_new ON payments(payment_status) WHERE payment_status IN ('INITIATED', 'PENDING_CONFIRMATION');

-- Add comment
COMMENT ON COLUMN payments.upi_id IS 'UPI ID used for payment';
COMMENT ON COLUMN payments.payment_status IS 'Payment status: INITIATED, PENDING_CONFIRMATION, SUCCESS, FAILED';

