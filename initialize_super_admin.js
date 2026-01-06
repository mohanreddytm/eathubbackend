/**
 * Script to initialize the super admin account
 * Run this script once after creating the super_admin table
 * 
 * Usage: node initialize_super_admin.js
 */

const { Pool } = require('pg');
const bcrypt = require('bcrypt');
require('dotenv').config();

const databaseUrl = process.env.DATABASE_URL || "postgresql://neondb_owner:npg_80neSdmGjoRi@ep-morning-base-a83jvhq1-pooler.eastus2.azure.neon.tech/neondb?sslmode=require&channel_binding=require";

const pool = new Pool({
    connectionString: databaseUrl,
});

async function initializeSuperAdmin() {
    try {
        console.log('🔍 Checking if super_admin table exists...');
        
        // Check if table exists
        const tableCheck = await pool.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_schema = 'public' 
                AND table_name = 'super_admin'
            );
        `);

        if (!tableCheck.rows[0].exists) {
            console.log('❌ super_admin table does not exist!');
            console.log('📝 Please run the SQL script first:');
            console.log('   Run: psql <your_database_url> -f super_admin_table.sql');
            console.log('   Or execute the SQL in super_admin_table.sql manually');
            process.exit(1);
        }

        console.log('✅ super_admin table exists');

        // Check if super admin already exists
        const checkQuery = `SELECT * FROM super_admin WHERE email = $1`;
        const checkResult = await pool.query(checkQuery, ['superadmineathub@gmail.com']);

        if (checkResult.rows.length > 0) {
            console.log('ℹ️  Super admin already exists!');
            console.log('   Email:', checkResult.rows[0].email);
            console.log('   ID:', checkResult.rows[0].id);
            console.log('   Name:', checkResult.rows[0].name);
            console.log('\n✅ You can now login with:');
            console.log('   Email: superadmineathub@gmail.com');
            console.log('   Password: superadmin@123');
            process.exit(0);
        }

        console.log('🔐 Creating super admin account...');

        // Create super admin with hashed password
        const hashedPassword = await bcrypt.hash('superadmin@123', 10);
        const insertQuery = `
            INSERT INTO super_admin (id, email, password, name)
            VALUES ($1, $2, $3, $4)
            RETURNING id, email, name;
        `;
        const result = await pool.query(insertQuery, [
            'super_admin_001',
            'superadmineathub@gmail.com',
            hashedPassword,
            'Super Admin'
        ]);

        console.log('✅ Super admin initialized successfully!');
        console.log('\n📋 Login Credentials:');
        console.log('   Email: superadmineathub@gmail.com');
        console.log('   Password: superadmin@123');
        console.log('\n🎉 You can now login to the Super Admin Dashboard!');

    } catch (error) {
        console.error('❌ Error initializing super admin:', error.message);
        console.error('Full error:', error);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

// Run the initialization
initializeSuperAdmin();

