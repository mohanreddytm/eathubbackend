-- Create waiter_requests table
-- Run this SQL in your PostgreSQL database to create the waiter_requests table

CREATE TABLE IF NOT EXISTS waiter_requests (
    id VARCHAR(255) PRIMARY KEY,
    restaurant_id VARCHAR(255) NOT NULL,
    table_id VARCHAR(255) NOT NULL,
    table_name VARCHAR(255),
    customer_id VARCHAR(255),
    customer_name VARCHAR(255),
    request_type VARCHAR(50) DEFAULT 'general' CHECK (request_type IN ('general', 'bill', 'order', 'assistance', 'other')),
    status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'assigned', 'completed', 'cancelled')),
    assigned_waiter_id VARCHAR(255),
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    FOREIGN KEY (restaurant_id) REFERENCES restaurant_admin(id) ON DELETE CASCADE,
    FOREIGN KEY (table_id) REFERENCES restaurant_tables(id) ON DELETE SET NULL,
    FOREIGN KEY (assigned_waiter_id) REFERENCES restaurant_staff(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_waiter_requests_restaurant_id ON waiter_requests(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_waiter_requests_table_id ON waiter_requests(table_id);
CREATE INDEX IF NOT EXISTS idx_waiter_requests_status ON waiter_requests(status);
CREATE INDEX IF NOT EXISTS idx_waiter_requests_assigned_waiter_id ON waiter_requests(assigned_waiter_id);
CREATE INDEX IF NOT EXISTS idx_waiter_requests_created_at ON waiter_requests(created_at);

COMMENT ON TABLE waiter_requests IS 'Stores waiter service requests from customers';

