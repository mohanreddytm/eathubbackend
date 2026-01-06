# Super Admin Login Setup Guide

## Problem
If you're seeing "Invalid email or password" when trying to login as super admin, it's likely because:
1. The `super_admin` table doesn't exist in your database
2. The super admin account hasn't been initialized

## Solution

### Step 1: Create the Super Admin Table

Run the SQL script to create the table:

**Option A: Using psql command line**
```bash
psql <your_database_connection_string> -f super_admin_table.sql
```

**Option B: Using a database GUI (like pgAdmin, DBeaver, etc.)**
1. Open your database client
2. Connect to your database
3. Open and execute the SQL file: `backend/super_admin_table.sql`

**Option C: Using Node.js script (if you have direct database access)**
The SQL file contains:
```sql
CREATE TABLE IF NOT EXISTS super_admin (
    id VARCHAR(255) PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL DEFAULT 'Super Admin',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### Step 2: Initialize the Super Admin Account

**Option A: Using the API endpoint (Recommended)**
```bash
# Make sure your backend server is running
POST http://localhost:8000/superAdmin/initialize
```

You can use:
- Postman
- Thunder Client (VS Code extension)
- The app.http file in this directory
- Or run this curl command:
```bash
curl -X POST http://localhost:8000/superAdmin/initialize
```

**Option B: Using the Node.js script**
```bash
cd backend
node initialize_super_admin.js
```

### Step 3: Login

After initialization, use these credentials:
- **Email:** `superadmineathub@gmail.com`
- **Password:** `superadmin@123`

## Testing

You can test the login using:

**Using curl:**
```bash
curl -X POST http://localhost:8000/superAdminLogin \
  -H "Content-Type: application/json" \
  -d '{"email":"superadmineathub@gmail.com","password":"superadmin@123"}'
```

**Using the app.http file:**
Open `backend/app.http` and use the Super Admin Login request.

## Troubleshooting

### Error: "relation super_admin does not exist"
- **Solution:** Run Step 1 to create the table

### Error: "Invalid email or password" after creating table
- **Solution:** Run Step 2 to initialize the account

### Error: "Super admin already exists"
- **Solution:** This is fine! The account is already initialized. Just use the login credentials.

### Database Connection Issues
- Check your `DATABASE_URL` in `.env` file or in `app.js`
- Make sure your database is accessible
- Verify your database credentials

## Default Credentials

- **Email:** superadmineathub@gmail.com
- **Password:** superadmin@123

⚠️ **Important:** Change the password after first login in production!

