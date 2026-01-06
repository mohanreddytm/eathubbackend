-- Add payment_settings and display_settings columns to restaurant_admin table
-- Run this SQL in your PostgreSQL database

-- Add payment_settings column if it doesn't exist
ALTER TABLE restaurant_admin 
ADD COLUMN IF NOT EXISTS payment_settings JSONB DEFAULT '{}'::jsonb;

-- Add display_settings column if it doesn't exist
ALTER TABLE restaurant_admin 
ADD COLUMN IF NOT EXISTS display_settings JSONB DEFAULT '{}'::jsonb;

-- Add comments
COMMENT ON COLUMN restaurant_admin.payment_settings IS 'Stores restaurant payment configuration settings';
COMMENT ON COLUMN restaurant_admin.display_settings IS 'Stores restaurant display and theme settings';

