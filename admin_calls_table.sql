-- Create admin_calls table
-- Run this SQL in your PostgreSQL database to create the admin_calls table

CREATE TABLE IF NOT EXISTS admin_calls (
    id VARCHAR(255) PRIMARY KEY,
    restaurant_id VARCHAR(255) NOT NULL,
    waiter_id VARCHAR(255) NOT NULL,
    waiter_name VARCHAR(255),
    admin_id VARCHAR(255) NOT NULL,
    admin_name VARCHAR(255),
    status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'answered', 'missed', 'cancelled')),
    message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    answered_at TIMESTAMP,
    FOREIGN KEY (restaurant_id) REFERENCES restaurant_admin(id) ON DELETE CASCADE,
    FOREIGN KEY (waiter_id) REFERENCES restaurant_staff(id) ON DELETE CASCADE,
    FOREIGN KEY (admin_id) REFERENCES restaurant_admin(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_admin_calls_restaurant_id ON admin_calls(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_admin_calls_waiter_id ON admin_calls(waiter_id);
CREATE INDEX IF NOT EXISTS idx_admin_calls_status ON admin_calls(status);
CREATE INDEX IF NOT EXISTS idx_admin_calls_created_at ON admin_calls(created_at);


COMMENT ON TABLE admin_calls IS 'Stores admin calls to waiters';

