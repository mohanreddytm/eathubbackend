-- Create restaurant_chat_messages table
-- Run this SQL in your PostgreSQL database to create the chat table

CREATE TABLE IF NOT EXISTS restaurant_chat_messages (
    id VARCHAR(255) PRIMARY KEY,
    restaurant_id VARCHAR(255) NOT NULL,
    sender_id VARCHAR(255) NOT NULL,
    sender_role VARCHAR(50) NOT NULL CHECK (sender_role IN ('admin', 'waiter')),
    sender_name VARCHAR(255),
    message TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (restaurant_id) REFERENCES restaurant_admin(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_restaurant_id ON restaurant_chat_messages(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_chat_created_at ON restaurant_chat_messages(created_at);

COMMENT ON TABLE restaurant_chat_messages IS 'Shared chat between restaurant admin and waiters';


