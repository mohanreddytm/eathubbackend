const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const app = express();
const port = process.env.PORT || 8000;

const jwt = require('jsonwebtoken');

const bcrypt = require('bcrypt');

app.use(express.json());
app.use(cookieParser());

require("dotenv").config();

const allowedOrigins = [
  'http://localhost:3000',
  'https://ptabletrack.vercel.app',
  'https://eathubfrontone.vercel.app/'
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));


const databaseUrl = process.env.DATABASE_URL || "postgresql://neondb_owner:npg_80neSdmGjoRi@ep-morning-base-a83jvhq1-pooler.eastus2.azure.neon.tech/neondb?sslmode=require&channel_binding=require";

const {Pool} = require('pg');
const pool = new Pool({
      connectionString: databaseUrl ,
});


// Helper: verify Super Admin JWT
const verifySuperAdmin = (req, res, next) => {
    try {
        let token = null;
        // Prefer Authorization bearer header
        if (req.headers && req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
            token = req.headers.authorization.split(' ')[1];
        }
        // Fallback to cookie
        if (!token && req.cookies && req.cookies.sa_user) {
            token = req.cookies.sa_user;
        }
        if (!token) {
            return res.status(401).json({ error: "Unauthorized: token missing" });
        }
        const decoded = jwt.verify(token, '10');
        if (!decoded || decoded.role !== 'super_admin') {
            return res.status(403).json({ error: "Forbidden: invalid role" });
        }
        req.superAdmin = decoded;
        next();
    } catch (error) {
        console.error("Super admin auth error:", error.message);
        return res.status(401).json({ error: "Unauthorized" });
    }
};

// Initialize super admin credentials in database (run once after creating table)
app.post("/superAdmin/initialize", async (req, res) => {
    try {
        // Check if super admin already exists
        const checkQuery = `SELECT * FROM super_admin WHERE email = $1`;
        const checkResult = await pool.query(checkQuery, ['superadmineathub@gmail.com']);
        
        if (checkResult.rows.length > 0) {
            return res.status(200).json({ 
                message: "Super admin already exists",
                email: checkResult.rows[0].email
            });
        }

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

        res.status(201).json({ 
            message: "Super admin initialized successfully",
            admin: result.rows[0]
        });
    } catch (error) {
        console.error("Error initializing super admin:", error.message);
        res.status(500).json({ error: "Internal Server Error", details: error.message });
    }
});

app.post("/superAdminLogin", async (req, res) => {
    const { email, password } = req.body;
    try {
        if (!email || !password) {
            return res.status(400).json({ error: "Email and password are required" });
        }

        // Check super admin credentials from database
        const query = `SELECT * FROM super_admin WHERE email = $1`;
        const result = await pool.query(query, [email]);

        if (result.rows.length === 0) {
            return res.status(401).json({ error: "Invalid email or password" });
        }

        const superAdmin = result.rows[0];

        // Verify password using bcrypt
        const isPasswordValid = await bcrypt.compare(password, superAdmin.password);
        if (!isPasswordValid) {
            return res.status(401).json({ error: "Invalid email or password" });
        }

        // Generate JWT token
        const token = jwt.sign({ 
            userId: superAdmin.id, 
            role: 'super_admin',
            email: superAdmin.email
        }, '10', { expiresIn: '30d' });

        // Set httpOnly cookie
        res.cookie('sa_user', token, {
            httpOnly: true,
            sameSite: 'lax',
            secure: false, // set true if using https
            maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
        });

        res.status(200).json({ 
            message: "Login successful", 
            userId: superAdmin.id,
            token, 
            user: { 
                name: superAdmin.name || 'Super Admin', 
                email: superAdmin.email,
                role: 'super_admin'
            } 
        });
    } catch (error) {
        console.error("Error executing super admin login:", error.message);
        res.status(500).json({ error: "Internal Server Error", details: error.message });
    }
});

app.post("/restaurantLogin", async (req, res) => {
    const { email, password } = req.body;
    try {
        const query = `
            SELECT * FROM restaurant_admin WHERE email = $1;
        `;
        const result = await pool.query(query, [email]);
        if (result.rows.length === 0) {
            return res.status(401).json({ error: "Email Not Exits." });
        }
        const user = result.rows[0];

        // If super admin has deactivated or suspended this restaurant, block login
        if (user.is_active === false) {
            return res.status(403).json({ error: "This restaurant account is deactivated. Please contact support or super admin." });
        }
        if (user.is_suspended === true) {
            return res.status(403).json({ error: "This restaurant account is suspended. Please contact support or super admin." });
        }

        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) {
            return res.status(401).json({ error: "Invalid email or password" });
        }

        const token = jwt.sign({ userId: user.id }, '10', { expiresIn: '30d' });

        res.status(200).json({ message: "Login successful", userId: user.id, token, user: { name: user.name, email: user.email} });
    } catch (error) {
        console.error("Error executing query:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.post("/restaurant/waiterLogin", async (req, res) => {
    const { email, password } = req.body;
    try {
        if (!email || !password) {
            return res.status(400).json({ error: "Email and password are required" });
        }

        const query = `
            SELECT * FROM restaurant_staff WHERE email = $1;
        `;
        const result = await pool.query(query, [email]);
        
        if (result.rows.length === 0) {
            return res.status(401).json({ error: "Email does not exist" });
        }

        const staff = result.rows[0];
        
        // Check if staff has a password (for existing staff without passwords, handle gracefully)
        if (!staff.password) {
            return res.status(401).json({ error: "Password not set. Please contact administrator." });
        }

        // Verify password
        const isPasswordValid = await bcrypt.compare(password, staff.password);
        if (!isPasswordValid) {
            return res.status(401).json({ error: "Invalid email or password" });
        }

        // Check if role is waiter (case-insensitive)
        const staffRole = staff.role ? staff.role.toLowerCase() : '';
        if (!staffRole.includes('waiter')) {
            return res.status(403).json({ error: "Access denied. Only waiters can login to waiter dashboard." });
        }

        // Generate JWT token with waiter id and restaurant id
        const token = jwt.sign({ 
            userId: staff.id, 
            restaurantId: staff.restaurant_id 
        }, '10', { expiresIn: '30d' });

        res.status(200).json({ 
            message: "Login successful", 
            userId: staff.id, 
            restaurantId: staff.restaurant_id,
            token, 
            user: { 
                name: staff.name, 
                email: staff.email,
                role: staff.role
            } 
        });
    } catch (error) {
        console.error("Error executing query:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});


// KOT / Kitchen staff login - only chefs can login here
app.post("/restaurant/kotLogin", async (req, res) => {
    const { email, password } = req.body;
    try {
        if (!email || !password) {
            return res.status(400).json({ error: "Email and password are required" });
        }

        const query = `
            SELECT * FROM restaurant_staff WHERE email = $1;
        `;
        const result = await pool.query(query, [email]);
        
        if (result.rows.length === 0) {
            return res.status(401).json({ error: "Email does not exist" });
        }

        const staff = result.rows[0];

        if (!staff.password) {
            return res.status(401).json({ error: "Password not set. Please contact administrator." });
        }

        const isPasswordValid = await bcrypt.compare(password, staff.password);
        if (!isPasswordValid) {
            return res.status(401).json({ error: "Invalid email or password" });
        }

        // Only allow chef / kitchen roles
        const staffRole = staff.role ? staff.role.toLowerCase() : '';
        if (!(staffRole.includes('chef') || staffRole.includes('kitchen'))) {
            return res.status(403).json({ error: "Access denied. Only chefs can login to KOT dashboard." });
        }

        const token = jwt.sign({ 
            userId: staff.id, 
            restaurantId: staff.restaurant_id 
        }, '10', { expiresIn: '30d' });

        res.status(200).json({ 
            message: "Login successful", 
            userId: staff.id, 
            restaurantId: staff.restaurant_id,
            token, 
            user: { 
                name: staff.name, 
                email: staff.email,
                role: staff.role
            } 
        });
    } catch (error) {
        console.error("Error executing query:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});



app.post("/restaurant", async (req, res) => {
    const {name, password, email, restaurentname, branchname, branchaddress, phonenumber, id, country, countrycode, is_email_verified, is_phonenumber_verified } = req.body;
    try {
        const existingUserQuery = `
            SELECT * FROM restaurant_admin WHERE email = $1;
        `;
        const existingUserResult = await pool.query(existingUserQuery, [email]);
        if (existingUserResult.rows.length > 0) {
            return res.status(400).json({ error: "Restaurant with this email already exists" });
        }
        if (!name || !password || !email || !restaurentname || !branchname || !branchaddress || !phonenumber || !id || !country) {
            return res.status(400).json({registration_status: "Require Feilds", error: "All fields are required" });
        }
        const query = `
            INSERT INTO restaurant_admin (name, password, email, restaurentname, branchname, branchaddress, phonenumber, id, country, countrycode, is_email_verified, is_phonenumber_verified)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            RETURNING *;
        `;

        const hashedPassword = await bcrypt.hash(password, 10);
        const values = [name, hashedPassword, email, restaurentname, branchname, branchaddress, phonenumber, id, country, countrycode, is_email_verified, is_phonenumber_verified];
        const result = await pool.query(query, values);

        const token = jwt.sign({ userId: result.rows[0].id }, '10', { expiresIn: '30d' });

        res.status(201).json({registration_status: "Success" , user: result.rows[0], token });


    } catch (error) {
        console.error("Error executing query:", error.message);
        res.status(500).json({registration_status: "Failure", error: "Internal Server Error" });
    }
});

app.post('/addCustomer', async (req, res) => {
    const { id, name, email, phone, password } = req.body;
    try{
        const existingUserQuery = `
            SELECT * FROM customer_details WHERE email = $1;
        `;
        const existingUserResult = await pool.query(existingUserQuery, [email]);
        if (existingUserResult.rows.length > 0) {
            return res.status(400).json({ error: "Customer with this email already exists" });
        }
        if (!id || !name || !email || !phone || !password) {
            return res.status(400).json({ error: "All fields are required" });
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        const values = [id, name, email, phone, hashedPassword];
        const query = `
            INSERT INTO customer_details (id, name, email, phone, password) VALUES ($1, $2, $3, $4, $5);
        `;
        await pool.query(query, values);
        res.status(201).json({ message: "Customer added successfully" });
    } catch (error) {
        console.error("Error executing query:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.post('/loginCustomer', async (req, res) => {
    const { email, password } = req.body;
    try{
        const existingUserQuery = `
            SELECT * FROM customer_details WHERE email = $1;
        `;
        const existingUserResult = await pool.query(existingUserQuery, [email]);
        if (existingUserResult.rows.length === 0) {
            return res.status(401).json({ error: "Email Not Exits." });
        }
        const user = existingUserResult.rows[0];
        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) {
            return res.status(401).json({ error: "Invalid email or password" });
        }
        const token = jwt.sign({ userId: user.id }, '10', { expiresIn: '30d' });
        res.status(200).json({ message: "Login successful", userId: user.id, token, user: { name: user.name, email: user.email} });
    } catch (error) {
        console.error("Error executing query:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
    }
);

app.post('/addNewOrder', async (req, res) => {
    const { id, customer_id, table_id, restaurant_id, customer_name, items, total_price, status, waiter_id, order_status, table_name, discount_amount, tax_amount, note } = req.body;
    const client = await pool.connect();
    try{
        // Allow table_id and table_name to be null (for walk-in orders)
        if (!id || !restaurant_id || !items || !total_price || !status || !order_status) {
            client.release();
            return res.status(400).json({ error: "Required fields: id, restaurant_id, items, total_price, status, order_status" });
        }
        
        await client.query('BEGIN');
        
        // Use advisory lock to prevent race conditions when calculating order number
        const lockResult = await client.query(`SELECT hashtext($1)::bigint as lock_key`, [restaurant_id]);
        await client.query('SELECT pg_advisory_xact_lock($1)', [lockResult.rows[0].lock_key]);
        
        // Efficient single query: Calculate order number and insert atomically using CTE
        const query = `
            WITH today_max_order AS (
                SELECT COALESCE(MAX(order_number), 0) + 1 AS next_order_number
                FROM orders
                WHERE restaurant_id = $4
                AND created_at >= CURRENT_DATE
                AND created_at < CURRENT_DATE + INTERVAL '1 day'
            )
            INSERT INTO orders (id, customer_id, table_id, restaurant_id, customer_name, items, total_price, status, waiter_id, order_status, table_name, order_number, discount_amount, tax_amount, note)
            SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, next_order_number, $12, $13, $14
            FROM today_max_order
            RETURNING order_number;
        `;
        const result = await client.query(query, [
            id, customer_id, table_id, restaurant_id, customer_name, items, total_price, 
            status, waiter_id, order_status, table_name, 
            discount_amount || null, tax_amount || null, note || null
        ]);
        
        await client.query('COMMIT');
        
        res.status(201).json({ message: "Order added successfully", order_number: result.rows[0].order_number });
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        console.error("Error executing query:", error.message);
        res.status(500).json({ error: "Internal Server Error", details: error.message });
    } finally {
        client.release();
    }
    }
);

app.get('/getOrderRestaurant/:restaurant_id', async (req, res) => {
    const { restaurant_id } = req.params;
    try{
        const query = `
            SELECT * FROM orders WHERE restaurant_id = $1;
        `;
        const result = await pool.query(query, [restaurant_id]);
        res.status(200).json({ order: result.rows });
    } catch (error) {
        console.error("Error executing query:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
    }
);

// Orders for KOT / kitchen dashboard - show orders that need to be cooked
app.get('/getOrdersKitchen/:restaurant_id', async (req, res) => {
    const { restaurant_id } = req.params;
    try{
        const query = `
            SELECT * FROM orders 
            WHERE restaurant_id = $1 
            AND order_status IN ('KOT', 'Preparing')
            ORDER BY created_at ASC;
        `;
        const result = await pool.query(query, [restaurant_id]);
        res.status(200).json({ order: result.rows });
    } catch (error) {
        console.error("Error executing query:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// Update order_status for an order (used by KOT to move through cooking stages)
app.put('/updateOrderStatus/:order_id', async (req, res) => {
    const { order_id } = req.params;
    const { order_status } = req.body;

    if (!order_status) {
        return res.status(400).json({ error: "order_status is required" });
    }

    try{
        const query = `
            UPDATE orders
            SET order_status = $1
            WHERE id = $2
            RETURNING *;
        `;
        const result = await pool.query(query, [order_status, order_id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Order not found" });
        }
        res.status(200).json({ message: "Order status updated", order: result.rows[0] });
    } catch (error) {
        console.error("Error executing query:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.put('/updateStatus/:order_id/:status/', async (req, res) => {
    const { order_id, status } = req.params;


    if (!status) {
        return res.status(400).json({ error: "status is required" });
    }

    try{
        const query = `
            UPDATE orders
            SET status = $1
            WHERE id = $2
            RETURNING *;
        `;
        const result = await pool.query(query, [status, order_id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Order not found" });
        }
        res.status(200).json({ message: "Order status updated", order: result.rows[0] });
    } catch (error) {
        console.error("Error executing query:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.get('/getOrdersWaiter/:waiter_id', async (req, res) => {
    const { waiter_id } = req.params;
    try{
        const query = `
            SELECT * FROM orders WHERE waiter_id = $1 ORDER BY created_at DESC;
        `;
        const result = await pool.query(query, [waiter_id]);
        res.status(200).json({ order: result.rows });
    } catch (error) {
        console.error("Error executing query:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
    }
);

app.get('/waiterDetailsRestaurant/:waiter_id', async (req, res) => {
    const { waiter_id } = req.params;
    try{
        const query = `
            SELECT * FROM restaurant_staff WHERE id = $1;
        `;
        const result = await pool.query(query, [waiter_id]);
        res.status(200).json({ waiter: result.rows });
    } catch (error) {
        console.error("Error executing query:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
    }
);


app.get('/getOrderCustomer/:customer_id', async (req, res) => {
    const { customer_id } = req.params;
    try{
        const query = `
            SELECT * FROM orders WHERE customer_id = $1;
        `;
        const result = await pool.query(query, [customer_id]);
        res.status(200).json({ order: result.rows });
    } catch (error) {
        console.error("Error executing query:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
    }
);

// Get orders by table_id (for customer dashboard order status)
app.get('/getOrdersByTable/:table_id', async (req, res) => {
    const { table_id } = req.params;
    try{
        const query = `
            SELECT * FROM orders 
            WHERE table_id = $1 
            ORDER BY created_at DESC;
        `;
        const result = await pool.query(query, [table_id]);
        res.status(200).json({ orders: result.rows });
    } catch (error) {
        console.error("Error executing query:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// Get order details by order id
app.get('/getOrderDetails/:order_id', async (req, res) => {
    const { order_id } = req.params;
    try{
        if (!order_id) {
            return res.status(400).json({ error: "Order ID is required" });
        }
        const query = `
            SELECT * FROM orders 
            WHERE id = $1;
        `;
        const result = await pool.query(query, [order_id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Order not found" });
        }
        // Parse items if they are JSON strings
        const order = result.rows[0];
        if (order.items && typeof order.items === 'string') {
            try {
                order.items = JSON.parse(order.items);
            } catch (e) {
                console.error("Error parsing items:", e);
                order.items = [];
            }
        }
        res.status(200).json({ order: [order] });
    } catch (error) {
        console.error("Error executing query:", error.message);
        res.status(500).json({ error: "Internal Server Error", details: error.message });
    }
});

// Create payment
app.post('/createPayment', async (req, res) => {
    const {
        id,
        restaurant_id,
        order_id,
        order_number,
        table_id,
        table_name,
        amount,
        payment_method,
        payment_status,
        transaction_id,
        notes
    } = req.body;

    if (!id || !restaurant_id || !order_id || !amount || !payment_method) {
        return res.status(400).json({ error: "Required fields: id, restaurant_id, order_id, amount, payment_method" });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const query = `
            INSERT INTO payments (
                id, restaurant_id, order_id, order_number, table_id, table_name,
                amount, payment_method, payment_status, transaction_id, notes,
                created_at, updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            RETURNING *;
        `;

        const result = await client.query(query, [
            id,
            restaurant_id,
            order_id,
            order_number || null,
            table_id || null,
            table_name || null,
            amount,
            payment_method,
            payment_status || 'Paid',
            transaction_id || null,
            notes || null
        ]);

        await client.query('COMMIT');
        res.status(201).json({ payment: result.rows[0], message: "Payment created successfully" });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Error creating payment:", error.message);
        res.status(500).json({ error: "Internal Server Error", details: error.message });
    } finally {
        client.release();
    }
});

// Update order payment status
app.put('/updateOrderPaymentStatus/:order_id', async (req, res) => {
    const { order_id } = req.params;
    const { payment_status, payment_method } = req.body;

    if (!order_id) {
        return res.status(400).json({ error: "Order ID is required" });
    }

    try {
        const query = `
            UPDATE orders 
            SET payment_status = COALESCE($1, payment_status),
                payment_method = COALESCE($2, payment_method),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $3
            RETURNING *;
        `;
        const result = await pool.query(query, [payment_status, payment_method, order_id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Order not found" });
        }
        
        res.status(200).json({ order: result.rows[0], message: "Order payment status updated successfully" });
    } catch (error) {
        console.error("Error updating order payment status:", error.message);
        res.status(500).json({ error: "Internal Server Error", details: error.message });
    }
});

// Get payment settings for restaurant
app.get('/getPaymentSettings/:restaurant_id', async (req, res) => {
    const { restaurant_id } = req.params;
    try {
        const query = `
            SELECT payment_settings FROM restaurant_admin 
            WHERE id = $1;
        `;
        const result = await pool.query(query, [restaurant_id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Restaurant not found" });
        }
        
        const settings = result.rows[0].payment_settings 
            ? (typeof result.rows[0].payment_settings === 'string' 
                ? JSON.parse(result.rows[0].payment_settings) 
                : result.rows[0].payment_settings)
            : {
                taxRate: 10,
                currency: 'INR',
                paymentMethods: { cash: true, card: true, upi: true, online: false },
                autoGenerateBill: false,
                printAutomatically: false,
                upi_ids: []
            };
        
        res.status(200).json({ settings });
    } catch (error) {
        console.error("Error fetching payment settings:", error.message);
        res.status(500).json({ error: "Internal Server Error", details: error.message });
    }
});

// Update payment settings for restaurant
app.put('/updatePaymentSettings/:restaurant_id', async (req, res) => {
    const { restaurant_id } = req.params;
    const paymentSettings = req.body;
    
    try {
        const query = `
            UPDATE restaurant_admin 
            SET payment_settings = $1
            WHERE id = $2
            RETURNING *;
        `;
        const result = await pool.query(query, [JSON.stringify(paymentSettings), restaurant_id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Restaurant not found" });
        }
        
        res.status(200).json({ message: "Payment settings updated successfully", settings: paymentSettings });
    } catch (error) {
        console.error("Error updating payment settings:", error.message);
        res.status(500).json({ error: "Internal Server Error", details: error.message });
    }
});

// Get all payments for restaurant
app.get('/getPayments/:restaurant_id', async (req, res) => {
    const { restaurant_id } = req.params;
    try {
        const query = `
            SELECT * FROM payments 
            WHERE restaurant_id = $1
            ORDER BY created_at DESC;
        `;
        const result = await pool.query(query, [restaurant_id]);
        res.status(200).json({ payments: result.rows });
    } catch (error) {
        console.error("Error fetching payments:", error.message);
        res.status(500).json({ error: "Internal Server Error", details: error.message });
    }
});

// Get display settings for restaurant
app.get('/getDisplaySettings/:restaurant_id', async (req, res) => {
    const { restaurant_id } = req.params;
    try {
        const query = `
            SELECT display_settings FROM restaurant_admin 
            WHERE id = $1;
        `;
        const result = await pool.query(query, [restaurant_id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Restaurant not found" });
        }
        
        const settings = result.rows[0].display_settings 
            ? (typeof result.rows[0].display_settings === 'string' 
                ? JSON.parse(result.rows[0].display_settings) 
                : result.rows[0].display_settings)
            : {
                theme: 'dark',
                language: 'en',
                dateFormat: 'DD/MM/YYYY',
                timeFormat: '24h',
                itemsPerPage: 20
            };
        
        res.status(200).json({ settings });
    } catch (error) {
        console.error("Error fetching display settings:", error.message);
        res.status(500).json({ error: "Internal Server Error", details: error.message });
    }
});

// Update display settings for restaurant
app.put('/updateDisplaySettings/:restaurant_id', async (req, res) => {
    const { restaurant_id } = req.params;
    const displaySettings = req.body;
    
    try {
        const query = `
            UPDATE restaurant_admin 
            SET display_settings = $1
            WHERE id = $2
            RETURNING *;
        `;
        const result = await pool.query(query, [JSON.stringify(displaySettings), restaurant_id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Restaurant not found" });
        }
        
        res.status(200).json({ message: "Display settings updated successfully", settings: displaySettings });
    } catch (error) {
        console.error("Error updating display settings:", error.message);
        res.status(500).json({ error: "Internal Server Error", details: error.message });
    }
});



app.post("/restaurant_details/addAreas", async (req, res) => {
  const areas = req.body;

  if (!Array.isArray(areas) || areas.length === 0) {
    return res.status(400).json({ error: "Area list is required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const area of areas) {
      const { area_id, area_name, restaurant_id } = area;
      if (!area_id || !area_name || !restaurant_id) {
        throw new Error("Missing fields in one of the area objects");
      }

    const checkResult = await client.query(
      "SELECT 1 FROM restaurant_area WHERE area_name = $1 AND restaurant_id = $2",
      [area_name, restaurant_id]
    );

    if (checkResult.rowCount === 0) {
      await client.query(
        "INSERT INTO restaurant_area (id, area_name, restaurant_id) VALUES ($1, $2, $3)",
        [area_id, area_name, restaurant_id]
      );
    }
    }

    await client.query("COMMIT");
    res.status(201).json({ message: "All areas added successfully" });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error inserting areas:", error.message);
    res.status(500).json({ error: "Internal Server Error" });
  } finally {
    client.release();
  }
});

app.get('/restaurant_details/getStaff/:restaurant_id', async (req, res) => {
    const { restaurant_id } = req.params;

    if (!restaurant_id) {
        return res.status(400).json({ error: "Restaurant ID is required" });
    }

    try {
        const query = `
            SELECT * FROM restaurant_staff
            WHERE restaurant_id = $1;
        `;
        const result = await pool.query(query, [restaurant_id]);
        res.status(200).json({ staff: result.rows });
    } catch (error) {
        console.error("Error fetching staff:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.delete('/restaurant_details/deleteStaff/:staff_id/:restaurant_id', async (req, res) => {
    const { staff_id, restaurant_id } = req.params;

    if (!staff_id || !restaurant_id) {
        return res.status(400).json({ error: "Staff ID and Restaurant ID are required" });
    }

    try {
        const query = `
            DELETE FROM restaurant_staff
            WHERE id = $1 AND restaurant_id = $2;
        `;
        await pool.query(query, [staff_id, restaurant_id]);
        res.status(200).json({ message: "Staff deleted successfully." });
    } catch (error) {
        console.error("Error deleting staff:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.post('/restaurant_details/addRole', async (req, res) => {
    const { role_id, role_name, restaurant_id } = req.body;

    if (!role_id || !role_name || !restaurant_id) {
        return res.status(400).json({ error: "All fields are required" });
    }

    try {
        const query = `
            INSERT INTO restaurant_roles (id, role_name, restaurant_id)
            VALUES ($1, $2, $3);
        `;
        await pool.query(query, [role_id, role_name, restaurant_id]);
        res.status(201).json({ message: "Role added successfully" });
    } catch (error) {
        console.error("Error adding role:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.put('/restaurant_details/updateStaff', async (req, res) => {
    const { staff_id, staff_name, restaurant_id, staff_email,
        staff_phone, staff_salary, staff_shift_timing, staff_status, staff_address, staff_role, staff_image, staff_experience, staff_ratings, waiter_total_orders_served, waiter_assigned_tables, password} = req.body;

    // Required fields only
    if (!staff_id || !staff_name || !restaurant_id || !staff_email || !staff_phone || !staff_role) {
        return res.status(400).json({ error: "Required fields: staff_id, staff_name, restaurant_id, staff_email, staff_phone, staff_role" });
    }

    try {
        // Handle optional fields - convert empty strings to null
        const salary = staff_salary && staff_salary !== '' ? staff_salary : null;
        const shiftTiming = staff_shift_timing && staff_shift_timing !== '' ? staff_shift_timing : null;
        const status = staff_status && staff_status !== '' ? staff_status : null;
        const address = staff_address && staff_address !== '' ? staff_address : null;
        const image = staff_image && staff_image !== '' ? staff_image : null;
        const experience = staff_experience || null;
        const ratings = staff_ratings || null;
        const totalOrdersServed = waiter_total_orders_served || null;
        const assignedTables = waiter_assigned_tables || null;

        // Handle password update - only update if provided
        let query;
        let queryParams;
        
        if (password && password.trim() !== '') {
            // Hash the password if provided
            const hashedPassword = await bcrypt.hash(password, 10);
            query = `
                UPDATE restaurant_staff
                SET name = $1, email = $2, phone_number = $3, experience = $4, total_orders_served = $5, ratings = $6, salary = $7, shift_timing = $8, assigned_tables = $9, status = $10, address = $11, role = $12, staff_image = $13, password = $14
                WHERE id = $15 AND restaurant_id = $16;
            `;
            queryParams = [staff_name, staff_email, staff_phone, experience, totalOrdersServed, ratings, salary, shiftTiming, assignedTables, status, address, staff_role, image, hashedPassword, staff_id, restaurant_id];
        } else {
            // Don't update password if not provided
            query = `
                UPDATE restaurant_staff
                SET name = $1, email = $2, phone_number = $3, experience = $4, total_orders_served = $5, ratings = $6, salary = $7, shift_timing = $8, assigned_tables = $9, status = $10, address = $11, role = $12, staff_image = $13
                WHERE id = $14 AND restaurant_id = $15;
            `;
            queryParams = [staff_name, staff_email, staff_phone, experience, totalOrdersServed, ratings, salary, shiftTiming, assignedTables, status, address, staff_role, image, staff_id, restaurant_id];
        }
        
        await pool.query(query, queryParams);
        res.status(200).json({ message: "Staff updated successfully." });
    } catch (error) {
        console.error("Error updating staff:", error.message);
        res.status(500).json({ error: "Internal Server Error", details: error.message });
    }
});

app.post('/restaurant_details/addStaff', async(req, res) => {
    const { staff_id, staff_name, restaurant_id, staff_email, staff_phone, staff_salary, staff_shift_timing, staff_status, staff_address, staff_role, staff_image, password } = req.body;

    // Required fields only
    if (!staff_id || !staff_name || !restaurant_id || !staff_email || !staff_phone || !staff_role || !password) {
        return res.status(400).json({ error: "Required fields: staff_id, staff_name, restaurant_id, staff_email, staff_phone, staff_role, password" });
    }

    try {
        // Hash the password before storing
        const hashedPassword = await bcrypt.hash(password, 10);
        
        // Handle optional fields - convert empty strings to null
        const salary = staff_salary && staff_salary.trim() !== '' ? staff_salary : null;
        const shiftTiming = staff_shift_timing && staff_shift_timing.trim() !== '' ? staff_shift_timing : null;
        const status = staff_status && staff_status.trim() !== '' ? staff_status : null;
        const address = staff_address && staff_address.trim() !== '' ? staff_address : null;
        const image = staff_image && staff_image.trim() !== '' ? staff_image : null;
        
        const query = `
            INSERT INTO restaurant_staff (id, name, restaurant_id, email, phone_number, salary, shift_timing, status, address, role, staff_image, password)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12);
        `;
        await pool.query(query, [staff_id, staff_name, restaurant_id, staff_email, staff_phone, salary, shiftTiming, status, address, staff_role, image, hashedPassword]);
        res.status(201).json({ message: "Staff added successfully" });
    } catch (error) {
        console.error("Error adding staff:", error.message);
        res.status(500).json({ error: "Internal Server Error", details: error.message });
    }
});

app.put('/restaurant_details/updateArea', async (req, res) => {
    const { area_id, area_name, restaurant_id } = req.body;

    if (!area_id || !area_name || !restaurant_id) {
        return res.status(400).json({ error: "All fields are required" });
    }

    try {
        const query = `
            UPDATE restaurant_area
            SET area_name = $1
            WHERE id = $2 AND restaurant_id = $3;
        `;
        await pool.query(query, [area_name, area_id, restaurant_id]);
        res.status(200).json({ message: "Area updated successfully" });
    } catch (error) {
        console.error("Error updating area:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});


app.delete('/deleteArea/:area_id/:restaurant_id', async (req, res) => {
    const { area_id, restaurant_id } = req.params;

    try {
        const checkResult = await pool.query(
            "SELECT 1 FROM restaurant_tables WHERE area_id = $1 AND restaurant_id = $2",
            [area_id, restaurant_id]
        );

        if (checkResult.rows.length > 0) {
            await pool.query("DELETE FROM restaurant_tables WHERE area_id = $1 AND restaurant_id = $2", [area_id, restaurant_id]);
        }

        await pool.query(
            "DELETE FROM restaurant_area WHERE id = $1 AND restaurant_id = $2",
            [area_id, restaurant_id]
        );

        res.status(200).json({
            success: true,
            message: "Successfully deleted the area",
            deletedAreaId: area_id
        });

    } catch (error) {
        console.error("Error deleting area:", error.message);
        res.status(500).json({
            success: false,
            error: "Internal Server Error",
            details: error.message
        });
    }
});

app.put('/restaurant_details/updateTable/', async (req, res) => {
    const { table_id, table_name, table_capacity, table_status, restaurant_id, area_id } = req.body;

    if (!table_id || !table_name || !table_capacity || !table_status || !restaurant_id || !area_id) {
        return res.status(400).json({ error: "All fields are required" });
    }

    try {
        const query = `
            UPDATE restaurant_tables
            SET name = $1, seat_capacity = $2, is_active = $3, area_id = $4
            WHERE id = $5 AND restaurant_id = $6;
        `;
        await pool.query(query, [table_name, table_capacity, table_status, area_id, table_id, restaurant_id]);
        res.status(200).json({ message: "Table updated successfully"});
    } catch (error) {
        console.error("Error updating table:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});


app.delete('/deleteTable/:table_id/:restaurant_id', async (req, res) => {
    const { table_id, restaurant_id } = req.params;
    
    try {
        const checkResult = await pool.query(
            "SELECT * FROM restaurant_tables WHERE id = $1 AND restaurant_id = $2",
            [table_id, restaurant_id]
        );

        if (checkResult.rows.length === 0) {
            return res.status(404).json({ error: "Table not found" });
        }

        await pool.query(
            "DELETE FROM restaurant_tables WHERE id = $1 AND restaurant_id = $2",
            [table_id, restaurant_id]
        );

        res.status(200).json({ 
            success: true,
            message: "Successfully deleted the table",
            deletedTableId: table_id
        });
        
    } catch (error) {
        console.error("Error deleting table:", error.message);
        res.status(500).json({ 
            success: false,
            error: "Internal Server Error",
            details: error.message
        });
    }
});


app.post('/restaurant_details/addTable', async (req, res) => {
    const tables = req.body;
    if (!Array.isArray(tables) || tables.length === 0) {
        return res.status(400).json({ error: "Tables list is required" });
    }
    // const { table_id, table_name, table_capacity, table_status, restaurant_id, area_id } = req.body;
    const client = await pool.connect();
    try{

        await client.query("BEGIN");

        for(const table of tables){
            const { table_id, table_name, table_capacity, table_status, restaurant_id, area_id } = table;
            if (!table_id || !table_name || !table_capacity || !table_status || !restaurant_id || !area_id) {
                return res.status(400).json({ error: "All fields are required" });
            }

            const checkResult = await client.query(
                "SELECT 1 FROM restaurant_tables WHERE name= $1 AND restaurant_id = $2",
                [table_name, restaurant_id]
            );

            if (checkResult.rowCount === 0) {
                const query = 'INSERT INTO restaurant_tables (id, name, seat_capacity, is_active, restaurant_id, area_id) VALUES ($1, $2, $3, $4, $5, $6);';
                await client.query(query, [table_id, table_name, table_capacity, table_status, restaurant_id, area_id]);    
            }
        }

        await client.query("COMMIT");
        res.status(201).json({ message: "All Tables added successfully" });

    }catch (error) {
        console.error("Error executing query:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    }finally{
        client.release();
    }

});

app.delete('/deleteMenuCategoryCompletly/:category_id', async (req , res) => {
    const {category_id} = req.params;
    if(!category_id){
        res.status(400).json({error: "Category id is not present"})
    }

    try{
        const data = await pool.query("select * from restaurant_menu_items where menu_category_id = $1", [category_id]);
        if(data.rows.length > 0){
            await pool.query("delete from restaurant_menu_items where menu_category_id = $1", [category_id]);
        }
        await pool.query("delete from restaurant_menu_category where id=$1", [category_id]);
        res.status(200).send("deleted succesfuulyy");
    }catch(e){
        res.status(500).json({ error: "Internal Server Error" });
    }
})

app.put('/restaurant_details/updateMenuCategoryName', async(req,res) => {
    const details = req.body;
    const {menu_category_name, id} = details;
    if(!menu_category_name || !id){
        return res.status(400).json({message: "require field are not filled"});
    }
    try{
        const checkResult = await pool.query("SELECT 1 FROM restaurant_menu_items WHERE menu_category_id = $1", [id]);
        if (checkResult.rowCount > 0) {
            await pool.query("UPDATE restaurant_menu_items SET category_name = $1 WHERE menu_category_id = $2", [menu_category_name, id]);
        }
        const query = "UPDATE restaurant_menu_category SET menu_category_name = $1 WHERE id = $2;";
        await pool.query(query, [menu_category_name, id]);

        res.status(200).send("Done");
    }
    catch{
        res.status(500).json({ error: "Internal Server Error" });
    }
})

app.post('/restaurant_details/addMenuCategory', async (req, res) => {
    const categories = req.body;

    if (!Array.isArray(categories) || categories.length === 0) {
        return res.status(400).json({ error: "Category list is required" });
    }

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        for (const category of categories) {
            const { menu_category_id, menu_category_name, restaurant_id } = category;

            if (!menu_category_id || !menu_category_name || !restaurant_id) {
                throw new Error("Missing fields in one of the category objects");
            }

            const checkResult = await client.query(
                "SELECT 1 FROM restaurant_menu_category WHERE menu_category_name = $1 and restaurant_id = $2",
                [menu_category_name, restaurant_id]
            );

            if (checkResult.rowCount === 0) {
                const query = `
                    INSERT INTO restaurant_menu_category (id, menu_category_name, restaurant_id)
                    VALUES ($1, $2, $3);
                `;
                await client.query(query, [menu_category_id, menu_category_name, restaurant_id]);
            }
        }

        await client.query("COMMIT");
        res.status(201).json({ message: "All menu categories added successfully" });

    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Error inserting menu categories:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    } finally {
        client.release();
    }
});


app.get('/getMenuItems/:restaurant_id', async (req, res) => {
    const restaurant_id = req.params.restaurant_id;
    const query = 'SELECT * FROM restaurant_menu_items WHERE restaurant_id = $1';
    const result = await pool.query(query, [restaurant_id]);
    res.status(200).json(result.rows);
});




app.delete('/deleteMenuItem/:item_id/:restaurant_id', async (req , res) => {
    const {item_id, restaurant_id} = req.params;
    if(!item_id || !restaurant_id){
        return res.status(400).json({error: "All feilds are required"});
    }

    try{
        await pool.query("delete from restaurant_menu_items where id = $1 and restaurant_id = $2;", [item_id, restaurant_id]);
        res.status(200).send("Succesfully Deleted the Item")
    }catch{
        res.status(500).json({ error: "Internal Server Error" });
    }
})

app.put('/restaurant_details/updateMenuItem', async (req, res) => {
    const { item_id, item_name, item_dec, category_name, item_price, item_menu_category_id, item_category, item_url, item_availabiliy, item_preparation_time, restaurant_id } = req.body;
    if (!item_id || !item_name || !item_dec || !category_name || !item_price || !item_menu_category_id || !item_category || !item_availabiliy || !item_preparation_time || !restaurant_id) {
        return res.status(400).json({ error: "All fields are required" });
    }

    const client = await pool.connect();

    try {   
        await client.query("BEGIN");

        const query = `
            UPDATE restaurant_menu_items
            SET item_name = $1, item_dec = $2, category_name = $3, price = $4, menu_category_id = $5, item_category = $6, image_url = $7, availability = $8, preparation_time = $9
            WHERE id = $10 AND restaurant_id = $11
        `;
        await client.query(query, [
            item_name,
            item_dec,
            category_name,
            item_price,
            item_menu_category_id,
            item_category,
            item_url,
            item_availabiliy,
            item_preparation_time,
            item_id,
            restaurant_id
        ]);

        await client.query("COMMIT");
        res.status(200).json({ message: "Menu item updated successfully" });

    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Error updating menu item:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    } finally {
        client.release();
    }
});

app.get('/restaurant_details/getMenuCategory/:restaurant_id', async (req, res) => {
    const restaurant_id = req.params.restaurant_id;

    const query = "SELECT c.id, c.menu_category_name, COUNT(i.menu_category_id) AS item_count FROM restaurant_menu_category c LEFT JOIN restaurant_menu_items i ON c.id = i.menu_category_id WHERE c.restaurant_id=$1 GROUP BY c.menu_category_name, c.id;";
    const result = await pool.query(query, [restaurant_id]);
    res.status(200).json(result.rows);
});

app.post('/restaurant_details/addMenuItems', async (req, res) => {
    const items = req.body;

    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: "Item list is required" });
    }

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        for (const item of items) {
            const {
                item_id,
                item_name,
                item_dec,
                category_name,
                item_price,
                item_menu_category_id,
                item_category,
                item_url,
                item_availabiliy,
                item_preparation_time,
                restaurant_id
            } = item;

            if (
                !item_id || !item_name || !item_dec || !category_name || !item_price ||
                !item_menu_category_id || !item_category || !item_availabiliy ||
                !item_preparation_time || !restaurant_id
            ) {
                throw new Error("Missing fields in one of the item objects");
            }

            
            const checkResult = await client.query(
                "SELECT 1 FROM restaurant_menu_items WHERE item_name = $1 AND restaurant_id = $2",
                [item_name, restaurant_id]
            );

            if (checkResult.rowCount === 0) {
                const query = `
                    INSERT INTO restaurant_menu_items
                    (id, item_name, item_category, category_name, item_dec, preparation_time, availability, image_url, price, menu_category_id, restaurant_id)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11);
                `;

                await client.query(query, [
                    item_id,
                    item_name,
                    item_category,
                    category_name,
                    item_dec,
                    item_preparation_time,
                    item_availabiliy,
                    item_url,
                    item_price,
                    item_menu_category_id,
                    restaurant_id
                ]);
            }
        }

        await client.query("COMMIT");
        res.status(201).json({ message: "All menu items added successfully" });

    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Error inserting menu items:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    } finally {
        client.release();
    }
});

// ===========================
// Waiter Requests Endpoints
// ===========================

// Create a new waiter request (called from customer dashboard "Call Waiter")
// Auto-assigns to top available waiter
app.post('/createWaiterRequest', async (req, res) => {
    const {
        id,
        restaurant_id,
        table_id,
        table_name,
        customer_id,
        customer_name,
        request_type,
        notes
    } = req.body;

    if (!id || !restaurant_id || !table_id) {
        return res.status(400).json({ error: "Required fields: id, restaurant_id, table_id" });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // First, insert the waiter request
        const insertQuery = `
            INSERT INTO waiter_requests (
                id,
                restaurant_id,
                table_id,
                table_name,
                customer_id,
                customer_name,
                request_type,
                status,
                notes,
                created_at,
                updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'general'), 'pending', $8, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            RETURNING *;
        `;

        const insertResult = await client.query(insertQuery, [
            id,
            restaurant_id,
            table_id,
            table_name || null,
            customer_id || null,
            customer_name || null,
            request_type || 'general',
            notes || null
        ]);

        // Find top available waiter (available status, least assigned requests)
        // Use CTE to avoid nested aggregate functions
        const waiterQuery = `
            WITH waiter_counts AS (
                SELECT 
                    rs.*,
                    COALESCE(COUNT(wr.id), 0) AS assigned_requests_count
                FROM restaurant_staff rs
                LEFT JOIN waiter_requests wr
                    ON wr.assigned_waiter_id = rs.id
                   AND wr.status IN ('pending', 'assigned')
                WHERE rs.restaurant_id = $1
                  AND LOWER(COALESCE(rs.role, '')) LIKE '%waiter%'
                  AND (rs.status IS NULL OR LOWER(rs.status) NOT LIKE '%busy%')
                GROUP BY rs.id
            ),
            min_count AS (
                SELECT MIN(assigned_requests_count) AS min_requests
                FROM waiter_counts
            )
            SELECT wc.*
            FROM waiter_counts wc
            CROSS JOIN min_count mc
            WHERE wc.assigned_requests_count = mc.min_requests
            ORDER BY 
                CASE 
                    WHEN wc.status IS NULL OR LOWER(wc.status) LIKE '%available%' THEN 1
                    WHEN LOWER(wc.status) LIKE '%serving%' THEN 2
                    ELSE 3
                END,
                wc.name ASC
            LIMIT 1;
        `;

        const waiterResult = await client.query(waiterQuery, [restaurant_id]);

        if (waiterResult.rows.length > 0) {
            const topWaiter = waiterResult.rows[0];
            
            // Auto-assign to top waiter
            const assignQuery = `
                UPDATE waiter_requests
                SET assigned_waiter_id = $1,
                    status = 'assigned',
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $2;
            `;
            await client.query(assignQuery, [topWaiter.id, id]);

            // Update waiter status to 'serving' if not already
            if (!topWaiter.status || !topWaiter.status.toLowerCase().includes('serving')) {
                await client.query(
                    `UPDATE restaurant_staff SET status = 'serving' WHERE id = $1`,
                    [topWaiter.id]
                );
            }

            await client.query('COMMIT');
            res.status(201).json({ 
                message: "Waiter request created and assigned successfully",
                waiter_name: topWaiter.name,
                waiter_id: topWaiter.id
            });
        } else {
            // No available waiter, leave as pending
            await client.query('COMMIT');
            res.status(201).json({ 
                message: "Waiter request created successfully. No available waiters at the moment.",
                waiter_name: null
            });
        }
    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Error creating waiter request:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    } finally {
        client.release();
    }
});

// Get all pending waiter requests for a restaurant (used in restaurant dashboard WaiterRequest page)
app.get('/getPendingWaiterRequests/:restaurant_id', async (req, res) => {
    const { restaurant_id } = req.params;

    if (!restaurant_id) {
        return res.status(400).json({ error: "Restaurant ID is required" });
    }

    try {
        const query = `
            SELECT 
                wr.*,
                rs.name AS waiter_name
            FROM waiter_requests wr
            LEFT JOIN restaurant_staff rs
                ON wr.assigned_waiter_id = rs.id
            WHERE wr.restaurant_id = $1
              AND wr.status = 'pending'
            ORDER BY wr.created_at DESC;
        `;

        const result = await pool.query(query, [restaurant_id]);
        res.status(200).json({ requests: result.rows });
    } catch (error) {
        console.error("Error fetching pending waiter requests:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// Get waiters with their current status and number of assigned pending requests
app.get('/getWaitersWithStatus/:restaurant_id', async (req, res) => {
    const { restaurant_id } = req.params;

    if (!restaurant_id) {
        return res.status(400).json({ error: "Restaurant ID is required" });
    }

    try {
        const query = `
            SELECT 
                rs.*,
                COALESCE(COUNT(wr.id), 0) AS assigned_requests_count
            FROM restaurant_staff rs
            LEFT JOIN waiter_requests wr
                ON wr.assigned_waiter_id = rs.id
               AND wr.status = 'pending'
            WHERE rs.restaurant_id = $1
              AND LOWER(COALESCE(rs.role, '')) LIKE '%waiter%'
            GROUP BY rs.id
            ORDER BY assigned_requests_count ASC, rs.name ASC;
        `;

        const result = await pool.query(query, [restaurant_id]);
        res.status(200).json({ waiters: result.rows });
    } catch (error) {
        console.error("Error fetching waiters with status:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// Assign a waiter to a specific waiter request
app.put('/assignWaiterToRequest/:request_id', async (req, res) => {
    const { request_id } = req.params;
    const { waiter_id } = req.body;

    if (!request_id || !waiter_id) {
        return res.status(400).json({ error: "Required fields: request_id, waiter_id" });
    }

    try {
        const query = `
            UPDATE waiter_requests
            SET assigned_waiter_id = $1,
                status = 'assigned',
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $2
            RETURNING *;
        `;

        const result = await pool.query(query, [waiter_id, request_id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Waiter request not found" });
        }

        res.status(200).json({ message: "Waiter assigned successfully", request: result.rows[0] });
    } catch (error) {
        console.error("Error assigning waiter to request:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// ===========================
// Admin → Waiter Call Endpoints
// ===========================

// Create a new admin call to a waiter
app.post('/createAdminCall', async (req, res) => {
    const {
        id,
        restaurant_id,
        waiter_id,
        waiter_name,
        admin_id,
        admin_name,
        message
    } = req.body;

    if (!id || !restaurant_id || !waiter_id || !admin_id) {
        return res.status(400).json({ error: "Required fields: id, restaurant_id, waiter_id, admin_id" });
    }

    try {
        const query = `
            INSERT INTO admin_calls (
                id,
                restaurant_id,
                waiter_id,
                waiter_name,
                admin_id,
                admin_name,
                status,
                message,
                created_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, CURRENT_TIMESTAMP)
        `;

        await pool.query(query, [
            id,
            restaurant_id,
            waiter_id,
            waiter_name || null,
            admin_id,
            admin_name || null,
            message || null
        ]);

        res.status(201).json({ message: "Admin call created successfully" });
    } catch (error) {
        console.error("Error creating admin call:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// Get pending admin calls for a specific waiter (used in waiter dashboard)
app.get('/getPendingAdminCallsWaiter/:waiter_id', async (req, res) => {
    const { waiter_id } = req.params;

    if (!waiter_id) {
        return res.status(400).json({ error: "Waiter ID is required" });
    }

    try {
        const query = `
            SELECT *
            FROM admin_calls
            WHERE waiter_id = $1
              AND status = 'pending'
            ORDER BY created_at DESC
        `;

        const result = await pool.query(query, [waiter_id]);
        res.status(200).json({ calls: result.rows });
    } catch (error) {
        console.error("Error fetching admin calls for waiter:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// Get recent admin calls for a restaurant (used in restaurant dashboard if needed)
app.get('/getAdminCallsRestaurant/:restaurant_id', async (req, res) => {
    const { restaurant_id } = req.params;

    if (!restaurant_id) {
        return res.status(400).json({ error: "Restaurant ID is required" });
    }

    try {
        const query = `
            SELECT *
            FROM admin_calls
            WHERE restaurant_id = $1
            ORDER BY created_at DESC
            LIMIT 50
        `;

        const result = await pool.query(query, [restaurant_id]);
        res.status(200).json({ calls: result.rows });
    } catch (error) {
        console.error("Error fetching admin calls for restaurant:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// Update admin call status (e.g., answered, missed, cancelled)
app.put('/updateAdminCallStatus/:id', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    if (!id || !status) {
        return res.status(400).json({ error: "Required fields: id, status" });
    }

    const allowedStatuses = ['pending', 'answered', 'missed', 'cancelled'];
    if (!allowedStatuses.includes(status)) {
        return res.status(400).json({ error: "Invalid status value" });
    }

    try {
        const query = `
            UPDATE admin_calls
            SET status = $1,
                answered_at = CASE WHEN $1 = 'answered' THEN CURRENT_TIMESTAMP ELSE answered_at END
            WHERE id = $2
            RETURNING *;
        `;

        const result = await pool.query(query, [status, id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Admin call not found" });
        }

        res.status(200).json({ message: "Admin call updated successfully", call: result.rows[0] });
    } catch (error) {
        console.error("Error updating admin call status:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// Update waiter status (e.g., available, serving, busy)
// If setting to busy, reassign pending requests to next waiter
app.put('/updateWaiterStatus/:waiter_id', async (req, res) => {
    const { waiter_id } = req.params;
    const { status } = req.body;

    if (!waiter_id || !status) {
        return res.status(400).json({ error: "Required fields: waiter_id, status" });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Get waiter info
        const waiterInfo = await client.query(
            `SELECT restaurant_id FROM restaurant_staff WHERE id = $1`,
            [waiter_id]
        );

        if (waiterInfo.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: "Waiter not found" });
        }

        const restaurantId = waiterInfo.rows[0].restaurant_id;

        // If setting to busy, reassign pending requests
        if (status.toLowerCase().includes('busy')) {
            // Get pending requests assigned to this waiter
            const pendingRequests = await client.query(
                `SELECT id FROM waiter_requests 
                 WHERE assigned_waiter_id = $1 AND status = 'assigned'`,
                [waiter_id]
            );

            // Reassign each pending request to next available waiter
            for (const request of pendingRequests.rows) {
                const nextWaiterQuery = `
                    SELECT 
                        rs.*,
                        COALESCE(COUNT(wr.id), 0) AS assigned_requests_count
                    FROM restaurant_staff rs
                    LEFT JOIN waiter_requests wr
                        ON wr.assigned_waiter_id = rs.id
                       AND wr.status = 'pending'
                    WHERE rs.restaurant_id = $1
                      AND rs.id != $2
                      AND LOWER(COALESCE(rs.role, '')) LIKE '%waiter%'
                      AND (rs.status IS NULL OR LOWER(rs.status) NOT LIKE '%busy%')
                    GROUP BY rs.id
                    ORDER BY 
                        CASE 
                            WHEN rs.status IS NULL OR LOWER(rs.status) LIKE '%available%' THEN 1
                            WHEN LOWER(rs.status) LIKE '%serving%' THEN 2
                            ELSE 3
                        END,
                        assigned_requests_count ASC,
                        rs.name ASC
                    LIMIT 1;
                `;

                const nextWaiterResult = await client.query(nextWaiterQuery, [restaurantId, waiter_id]);

                if (nextWaiterResult.rows.length > 0) {
                    const nextWaiter = nextWaiterResult.rows[0];
                    await client.query(
                        `UPDATE waiter_requests 
                         SET assigned_waiter_id = $1, updated_at = CURRENT_TIMESTAMP
                         WHERE id = $2`,
                        [nextWaiter.id, request.id]
                    );

                    // Update next waiter status
                    if (!nextWaiter.status || !nextWaiter.status.toLowerCase().includes('serving')) {
                        await client.query(
                            `UPDATE restaurant_staff SET status = 'serving' WHERE id = $1`,
                            [nextWaiter.id]
                        );
                    }
                }
            }
        }

        // Update waiter status
        const query = `
            UPDATE restaurant_staff
            SET status = $1
            WHERE id = $2
            RETURNING *;
        `;

        const result = await client.query(query, [status, waiter_id]);

        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: "Waiter not found" });
        }

        await client.query('COMMIT');
        res.status(200).json({ message: "Waiter status updated successfully", waiter: result.rows[0] });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Error updating waiter status:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    } finally {
        client.release();
    }
});

// Mark waiter request as completed and move waiter to end of list
app.put('/completeWaiterRequest/:request_id', async (req, res) => {
    const { request_id } = req.params;

    try {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Get request info
            const requestInfo = await client.query(
                `SELECT assigned_waiter_id, restaurant_id FROM waiter_requests WHERE id = $1`,
                [request_id]
            );

            if (requestInfo.rows.length === 0) {
                await client.query('ROLLBACK');
                client.release();
                return res.status(404).json({ error: "Waiter request not found" });
            }

            const waiterId = requestInfo.rows[0].assigned_waiter_id;
            const restaurantId = requestInfo.rows[0].restaurant_id;

            // Mark request as completed
            await client.query(
                `UPDATE waiter_requests 
                 SET status = 'completed', updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1`,
                [request_id]
            );

            // Check if waiter has other pending requests
            const otherRequests = await client.query(
                `SELECT COUNT(*) as count FROM waiter_requests 
                 WHERE assigned_waiter_id = $1 AND status IN ('pending', 'assigned')`,
                [waiterId]
            );

            // If no other requests, set waiter to available
            if (parseInt(otherRequests.rows[0].count) === 0) {
                await client.query(
                    `UPDATE restaurant_staff SET status = 'available' WHERE id = $1`,
                    [waiterId]
                );
            }

            await client.query('COMMIT');
            client.release();
            res.status(200).json({ message: "Waiter request completed successfully" });
        } catch (error) {
            await client.query('ROLLBACK');
            client.release();
            throw error;
        }
    } catch (error) {
        console.error("Error completing waiter request:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// ===========================
// Restaurant Chat Endpoints
// ===========================

// Get chat messages for a restaurant
app.get('/restaurant_messages/:restaurant_id', async (req, res) => {
    const { restaurant_id } = req.params;

    if (!restaurant_id) {
        return res.status(400).json({ error: "Restaurant ID is required" });
    }

    try {
        const query = `
            SELECT *
            FROM restaurant_chat_messages
            WHERE restaurant_id = $1
            ORDER BY created_at DESC
            LIMIT 100
        `;
        const result = await pool.query(query, [restaurant_id]);
        res.status(200).json({ messages: result.rows });
    } catch (error) {
        console.error("Error fetching restaurant messages:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// Post a new chat message (admin or waiter)
app.post('/restaurant_messages', async (req, res) => {
    const {
        id,
        restaurant_id,
        sender_id,
        sender_role,
        sender_name,
        message
    } = req.body;

    if (!id || !restaurant_id || !sender_id || !sender_role || !message) {
        return res.status(400).json({ error: "Required fields: id, restaurant_id, sender_id, sender_role, message" });
    }

    try {
        const query = `
            INSERT INTO restaurant_chat_messages (
                id,
                restaurant_id,
                sender_id,
                sender_role,
                sender_name,
                message,
                created_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
        `;

        await pool.query(query, [
            id,
            restaurant_id,
            sender_id,
            sender_role,
            sender_name || null,
            message
        ]);

        res.status(201).json({ message: "Chat message created successfully" });
    } catch (error) {
        console.error("Error creating restaurant message:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// Super Admin logout endpoint
app.post('/superAdmin/logout', verifySuperAdmin, async (req, res) => {
    try {
        // Clear the HttpOnly cookie
        res.clearCookie('sa_user', {
            httpOnly: true,
            sameSite: 'lax',
            secure: false
        });
        res.status(200).json({ message: 'Logout successful' });
    } catch (error) {
        console.error('Error during logout:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Super Admin endpoints
app.get('/superAdmin/getAllRestaurants', verifySuperAdmin, async (req, res) => {
    try {
        // Try to get columns, use COALESCE to default to true/false if columns don't exist
        const query = `
            SELECT id, name, email, restaurentname, branchname, branchaddress, phonenumber, 
                   country, countrycode, is_email_verified, is_phonenumber_verified,
                   created_at, 
                   COALESCE(is_active, true) as is_active, 
                   COALESCE(is_suspended, false) as is_suspended
            FROM restaurant_admin
            ORDER BY created_at DESC;
        `;
        const result = await pool.query(query);
        res.status(200).json({ restaurants: result.rows });
    } catch (error) {
        console.error("Error fetching restaurants:", error.message);
        // If columns don't exist, try without them
        try {
            const fallbackQuery = `
                SELECT id, name, email, restaurentname, branchname, branchaddress, phonenumber, 
                       country, countrycode, is_email_verified, is_phonenumber_verified,
                       created_at
                FROM restaurant_admin
                ORDER BY created_at DESC;
            `;
            const fallbackResult = await pool.query(fallbackQuery);
            // Add default values for missing columns
            const restaurantsWithDefaults = fallbackResult.rows.map(r => ({
                ...r,
                is_active: true,
                is_suspended: false
            }));
            res.status(200).json({ restaurants: restaurantsWithDefaults });
        } catch (fallbackError) {
            console.error("Error in fallback query:", fallbackError.message);
            res.status(500).json({ error: "Internal Server Error" });
        }
    }
});

app.put('/superAdmin/updateRestaurantStatus/:restaurant_id', verifySuperAdmin, async (req, res) => {
    const { restaurant_id } = req.params;
    const { is_active, is_suspended } = req.body;
    try {
        let query;
        let params;
        
        if (is_active !== undefined && is_suspended !== undefined) {
            query = `
                UPDATE restaurant_admin 
                SET is_active = $1, is_suspended = $2 
                WHERE id = $3
                RETURNING *;
            `;
            params = [is_active, is_suspended, restaurant_id];
        } else if (is_active !== undefined) {
            query = `
                UPDATE restaurant_admin 
                SET is_active = $1 
                WHERE id = $2
                RETURNING *;
            `;
            params = [is_active, restaurant_id];
        } else if (is_suspended !== undefined) {
            query = `
                UPDATE restaurant_admin 
                SET is_suspended = $1 
                WHERE id = $2
                RETURNING *;
            `;
            params = [is_suspended, restaurant_id];
        } else {
            return res.status(400).json({ error: "At least one status field (is_active or is_suspended) is required" });
        }

        const result = await pool.query(query, params);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Restaurant not found" });
        }
        res.status(200).json({ message: "Restaurant status updated successfully", restaurant: result.rows[0] });
    } catch (error) {
        console.error("Error updating restaurant status:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.delete('/superAdmin/deleteRestaurant/:restaurant_id', verifySuperAdmin, async (req, res) => {
    const { restaurant_id } = req.params;
    try {
        const query = `DELETE FROM restaurant_admin WHERE id = $1 RETURNING *;`;
        const result = await pool.query(query, [restaurant_id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Restaurant not found" });
        }
        res.status(200).json({ message: "Restaurant deleted successfully" });
    } catch (error) {
        console.error("Error deleting restaurant:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.get('/superAdmin/getRestaurantStats/:restaurant_id', verifySuperAdmin, async (req, res) => {
    const { restaurant_id } = req.params;
    try {
        // Get order count
        const ordersResult = await pool.query(
            'SELECT COUNT(*) as total_orders FROM orders WHERE restaurant_id = $1',
            [restaurant_id]
        );
        
        // Get staff count
        const staffResult = await pool.query(
            'SELECT COUNT(*) as total_staff FROM restaurant_staff WHERE restaurant_id = $1',
            [restaurant_id]
        );
        
        // Get tables count
        const tablesResult = await pool.query(
            `SELECT COUNT(*) as total_tables 
             FROM restaurant_tables 
             WHERE restaurant_id IN (
                 SELECT id FROM restaurant_area WHERE restaurant_id = $1
             )`,
            [restaurant_id]
        );

        res.status(200).json({
            total_orders: parseInt(ordersResult.rows[0].total_orders) || 0,
            total_staff: parseInt(staffResult.rows[0].total_staff) || 0,
            total_tables: parseInt(tablesResult.rows[0].total_tables) || 0
        });
    } catch (error) {
        console.error("Error fetching restaurant stats:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.get('/getTableName/:table_id', async (req, res) => {
    const table_id = req.params.table_id;
    try{
        const result = await pool.query("SELECT * from restaurant_tables where id = $1", [table_id]);
        res.status(200).json(result.rows);
    }catch(e){
        res.status(401).send("Something went Wrong")
    }
})

app.get('/getTables/:area_id', async (req, res) => {
    const area_id = req.params.area_id;
    const query = 'SELECT * FROM restaurant_tables WHERE area_id = $1';
    const result = await pool.query(query, [area_id]);
    res.status(200).json(result.rows);
});

app.get('/getAreas/:restaurant_id', async (req, res) => {
    const restaurant_id = req.params.restaurant_id;
    const query = 'SELECT * FROM restaurant_area WHERE restaurant_id = $1';
    const result = await pool.query(query, [restaurant_id]);
    res.status(200).json(result.rows);
});



app.get("/restaurant/:id", async (req, res) => {
    try {
        const id = req.params.id;
        const query = 'SELECT * FROM restaurant_admin WHERE id = $1';
        const result = await pool.query(query, [id]);
        res.json(result.rows); // send the data as JSON
    } catch (error) {
        console.error("Got an error:", error);
        res.status(500).send("Server error");
    }
});


app.get("/restaurant", async (req, res) => {
    const url = "select * from restaurant_admin;";
    try {
        const result = await pool.query(url);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error("Error executing query", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.get("/ping", (req, res) => {
  res.send("pong");
});

// Reservation API Endpoints

// Get all reservations for a restaurant
app.get('/getReservations/:restaurant_id', async (req, res) => {
    const { restaurant_id } = req.params;
    try {
        const query = `
            SELECT * FROM reservations 
            WHERE restaurant_id = $1 
            ORDER BY date DESC, time DESC;
        `;
        const result = await pool.query(query, [restaurant_id]);
        res.status(200).json({ reservations: result.rows });
    } catch (error) {
        console.error("Error executing query:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// Add a new reservation
app.post('/addReservation', async (req, res) => {
    const { 
        id, 
        restaurant_id, 
        customer_name, 
        email, 
        phone, 
        date, 
        time, 
        guests, 
        table_id, 
        notes, 
        status 
    } = req.body;
    
    const client = await pool.connect();
    try {
        if (!id || !restaurant_id || !customer_name || !email || !phone || !date || !time || !guests || !table_id) {
            client.release();
            return res.status(400).json({ error: "Required fields: id, restaurant_id, customer_name, email, phone, date, time, guests, table_id" });
        }

        await client.query('BEGIN');

        const query = `
            INSERT INTO reservations (
                id, restaurant_id, customer_name, email, phone, 
                date, time, guests, table_id, notes, status, created_at
            ) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CURRENT_TIMESTAMP)
            RETURNING *;
        `;
        
        const result = await client.query(query, [
            id, restaurant_id, customer_name, email, phone, 
            date, time, guests, table_id, notes || 'No special requests', status || 'pending'
        ]);

        await client.query('COMMIT');
        res.status(201).json({ reservation: result.rows[0] });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Error executing query:", error.message);
        console.error("Full error:", error);
        // Return more detailed error message
        const errorMessage = error.message.includes('foreign key') 
            ? 'Invalid restaurant or table ID. Please check your selections.'
            : error.message.includes('violates check constraint')
            ? 'Invalid status value. Must be pending, success, or cancelled.'
            : error.message;
        res.status(500).json({ error: errorMessage || "Internal Server Error" });
    } finally {
        client.release();
    }
});

// Update a reservation
app.put('/updateReservation/:id', async (req, res) => {
    const { id } = req.params;
    const { 
        customer_name, 
        email, 
        phone, 
        date, 
        time, 
        guests, 
        table_id, 
        notes, 
        status 
    } = req.body;
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const query = `
            UPDATE reservations 
            SET 
                customer_name = COALESCE($1, customer_name),
                email = COALESCE($2, email),
                phone = COALESCE($3, phone),
                date = COALESCE($4, date),
                time = COALESCE($5, time),
                guests = COALESCE($6, guests),
                table_id = COALESCE($7, table_id),
                notes = COALESCE($8, notes),
                status = COALESCE($9, status),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $10
            RETURNING *;
        `;
        
        const result = await client.query(query, [
            customer_name, email, phone, date, time, guests, table_id, notes, status, id
        ]);

        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            client.release();
            return res.status(404).json({ error: "Reservation not found" });
        }

        await client.query('COMMIT');
        res.status(200).json({ reservation: result.rows[0] });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Error executing query:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    } finally {
        client.release();
    }
});

// Delete a reservation
app.delete('/deleteReservation/:id', async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const query = 'DELETE FROM reservations WHERE id = $1 RETURNING *;';
        const result = await client.query(query, [id]);

        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            client.release();
            return res.status(404).json({ error: "Reservation not found" });
        }

        await client.query('COMMIT');
        res.status(200).json({ message: "Reservation deleted successfully", reservation: result.rows[0] });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Error executing query:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    } finally {
        client.release();
    }
});

app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});