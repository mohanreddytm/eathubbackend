/**
 * Script to reset/update the super admin password
 * This ensures the password is correctly hashed
 * 
 * Usage: node reset_super_admin_password.js
 */

const { Pool } = require('pg');
const bcrypt = require('bcrypt');
require('dotenv').config();

const databaseUrl = process.env.DATABASE_URL || "postgresql://neondb_owner:npg_80neSdmGjoRi@ep-morning-base-a83jvhq1-pooler.eastus2.azure.neon.tech/neondb?sslmode=require&channel_binding=require";

const pool = new Pool({
    connectionString: databaseUrl,
});

async function resetSuperAdminPassword() {
    try {
        console.log('🔍 Checking super admin account...');
        
        const checkQuery = `SELECT * FROM super_admin WHERE email = $1`;
        const checkResult = await pool.query(checkQuery, ['superadmineathub@gmail.com']);

        if (checkResult.rows.length === 0) {
            console.log('❌ Super admin account not found!');
            console.log('💡 Run: node initialize_super_admin.js first');
            process.exit(1);
        }

        console.log('✅ Super admin account found');
        console.log('🔐 Resetting password...');

        // Hash the password with bcrypt (10 rounds)
        const hashedPassword = await bcrypt.hash('superadmin@123', 10);
        
        // Update the password
        const updateQuery = `
            UPDATE super_admin 
            SET password = $1, updated_at = CURRENT_TIMESTAMP
            WHERE email = $2
            RETURNING id, email, name;
        `;
        
        const result = await pool.query(updateQuery, [
            hashedPassword,
            'superadmineathub@gmail.com'
        ]);

        console.log('✅ Password reset successfully!');
        console.log('\n📋 Updated Credentials:');
        console.log('   Email: superadmineathub@gmail.com');
        console.log('   Password: superadmin@123');
        console.log('\n🎉 You can now login with these credentials!');

        // Verify the password works
        console.log('\n🔍 Verifying password hash...');
        const verifyResult = await bcrypt.compare('superadmin@123', hashedPassword);
        if (verifyResult) {
            console.log('✅ Password hash verified successfully!');
        } else {
            console.log('❌ Password verification failed!');
        }

    } catch (error) {
        console.error('❌ Error resetting password:', error.message);
        console.error('Full error:', error);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

// Run the reset
resetSuperAdminPassword();

