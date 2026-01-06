-- Create super_admin table for storing super admin credentials
CREATE TABLE IF NOT EXISTS super_admin (
    id VARCHAR(255) PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL DEFAULT 'Super Admin',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- IMPORTANT: After creating the table, you need to initialize the super admin account
-- Option 1: Use the API endpoint (Recommended)
-- POST http://localhost:8000/superAdmin/initialize
-- This will automatically hash the password and insert the credentials

-- Option 2: Manual insert (if you want to hash password yourself)
-- Password: superadmin@123
-- You need to hash it using bcrypt with 10 rounds
-- Example hash (DO NOT USE THIS - generate your own):
-- INSERT INTO super_admin (id, email, password, name)
-- VALUES (
--     'super_admin_001',
--     'superadmineathub@gmail.com',
--     '$2b$10$YOUR_HASHED_PASSWORD_HERE',
--     'Super Admin'
-- ) ON CONFLICT (email) DO NOTHING;

