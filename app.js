// 17Call Backend API - Node.js Express Application
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000; 
// Database connection
const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || '17call',
  password: process.env.DB_PASSWORD || 'password',
  port: process.env.DB_PORT || 5432,
});

// Middleware
app.use(cors());
app.use(express.json());

// Rate limiting
const voucherValidateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: { success: false, error: 'Too many voucher validation attempts' }
});

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// Auth middleware
const authenticateAdmin = (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  
  if (!token) {
    return res.status(401).json({ success: false, error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.admin = decoded;
    next();
  } catch (error) {
    res.status(401).json({ success: false, error: 'Invalid token' });
  }
};

// Utility function to generate voucher code
const generateVoucherCode = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 12; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

// Response helper
const sendResponse = (res, data, status = 200) => {
  res.status(status).json({ success: true, data });
};

const sendError = (res, error, status = 400) => {
  res.status(status).json({ success: false, error });
};

// =====================================
// MOBILE APP ENDPOINTS
// =====================================

// Voucher validation
app.post('/api/v1/vouchers/validate', voucherValidateLimit, async (req, res) => {
  try {
    const { code, deviceId } = req.body;

    if (!code || !deviceId) {
      return sendError(res, 'Code and deviceId are required');
    }

    const result = await pool.query(
      'SELECT id, duration_minutes, remaining_minutes, is_used, is_active FROM vouchers WHERE code = $1',
      [code.toUpperCase()]
    );

    if (result.rows.length === 0) {
      return sendResponse(res, { valid: false, durationMinutes: 0, voucherId: null });
    }

    const voucher = result.rows[0];

    if (!voucher.is_active || voucher.is_used || voucher.remaining_minutes <= 0) {
      return sendResponse(res, { valid: false, durationMinutes: 0, voucherId: null });
    }

    // Update device_id if not already set
    if (!voucher.device_id) {
      await pool.query(
        'UPDATE vouchers SET device_id = $1 WHERE id = $2',
        [deviceId, voucher.id]
      );
    }

    sendResponse(res, {
      valid: true,
      durationMinutes: voucher.remaining_minutes,
      voucherId: voucher.id
    });

  } catch (error) {
    console.error('Voucher validation error:', error);
    sendError(res, 'Internal server error', 500);
  }
});

// Start call
app.post('/api/v1/calls/start', async (req, res) => {
  try {
    const { voucherId, phoneNumber, countryCode, callType } = req.body;

    if (!voucherId || !phoneNumber || !countryCode || !callType) {
      return sendError(res, 'All fields are required');
    }

    // Validate voucher
    const voucherResult = await pool.query(
      'SELECT remaining_minutes, device_id FROM vouchers WHERE id = $1 AND is_active = true AND is_used = false',
      [voucherId]
    );

    if (voucherResult.rows.length === 0) {
      return sendError(res, 'Invalid or expired voucher');
    }

    const voucher = voucherResult.rows[0];

    if (voucher.remaining_minutes <= 0) {
      return sendError(res, 'No minutes remaining on voucher');
    }

    // Generate call ID and create call log
    const callId = uuidv4();
    
    await pool.query(
      `INSERT INTO call_logs (call_id, voucher_id, phone_number, country_code, call_type, device_id) 
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [callId, voucherId, phoneNumber, countryCode, callType, voucher.device_id]
    );

    // Log system action
    await pool.query(
      `INSERT INTO system_logs (action, entity_type, entity_id, details) 
       VALUES ($1, $2, $3, $4)`,
      ['call_started', 'call', callId, JSON.stringify({ phoneNumber, callType })]
    );

    sendResponse(res, {
      callId,
      remainingMinutes: voucher.remaining_minutes
    });

  } catch (error) {
    console.error('Call start error:', error);
    sendError(res, 'Internal server error', 500);
  }
});

// End call
app.post('/api/v1/calls/end', async (req, res) => {
  try {
    const { callId, actualDurationSeconds } = req.body;

    if (!callId || actualDurationSeconds === undefined) {
      return sendError(res, 'CallId and actualDurationSeconds are required');
    }

    // Get call information
    const callResult = await pool.query(
      'SELECT voucher_id FROM call_logs WHERE call_id = $1',
      [callId]
    );

    if (callResult.rows.length === 0) {
      return sendError(res, 'Call not found');
    }

    const voucherId = callResult.rows[0].voucher_id;

    // Calculate minutes used (round up)
    const minutesUsed = Math.ceil(actualDurationSeconds / 60);

    // Update call log
    await pool.query(
      `UPDATE call_logs 
       SET duration_seconds = $1, status = 'completed', ended_at = CURRENT_TIMESTAMP 
       WHERE call_id = $2`,
      [actualDurationSeconds, callId]
    );

    // Update voucher remaining minutes
    const voucherResult = await pool.query(
      `UPDATE vouchers 
       SET remaining_minutes = GREATEST(0, remaining_minutes - $1),
           is_used = CASE WHEN (remaining_minutes - $1) <= 0 THEN true ELSE is_used END,
           used_at = CASE WHEN (remaining_minutes - $1) <= 0 AND used_at IS NULL 
                     THEN CURRENT_TIMESTAMP ELSE used_at END
       WHERE id = $2 
       RETURNING remaining_minutes`,
      [minutesUsed, voucherId]
    );

    const remainingMinutes = voucherResult.rows[0]?.remaining_minutes || 0;

    // Log system action
    await pool.query(
      `INSERT INTO system_logs (action, entity_type, entity_id, details) 
       VALUES ($1, $2, $3, $4)`,
      ['call_ended', 'call', callId, JSON.stringify({ durationSeconds: actualDurationSeconds, minutesUsed })]
    );

    sendResponse(res, {
      success: true,
      remainingMinutes
    });

  } catch (error) {
    console.error('Call end error:', error);
    sendError(res, 'Internal server error', 500);
  }
});

// =====================================
// ADMIN ENDPOINTS
// =====================================

// Admin login
app.post('/api/v1/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return sendError(res, 'Username and password are required');
    }

    const result = await pool.query(
      'SELECT id, username, password_hash, email FROM admin_users WHERE username = $1 AND is_active = true',
      [username]
    );

    if (result.rows.length === 0) {
      return sendError(res, 'Invalid credentials', 401);
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      return sendError(res, 'Invalid credentials', 401);
    }

    // Update last login
    await pool.query(
      'UPDATE admin_users SET last_login = CURRENT_TIMESTAMP WHERE id = $1',
      [user.id]
    );

    const token = jwt.sign(
      { id: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    sendResponse(res, {
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    sendError(res, 'Internal server error', 500);
  }
});

// Generate single voucher
app.post('/api/v1/admin/vouchers/generate', authenticateAdmin, async (req, res) => {
  try {
    const { durationMinutes } = req.body;

    if (!durationMinutes || durationMinutes <= 0) {
      return sendError(res, 'Valid durationMinutes is required');
    }

    let code;
    let isUnique = false;
    
    // Ensure unique code
    while (!isUnique) {
      code = generateVoucherCode();
      const existingResult = await pool.query('SELECT id FROM vouchers WHERE code = $1', [code]);
      isUnique = existingResult.rows.length === 0;
    }

    const result = await pool.query(
      `INSERT INTO vouchers (code, duration_minutes, remaining_minutes, created_by) 
       VALUES ($1, $2, $2, $3) 
       RETURNING id`,
      [code, durationMinutes, req.admin.id]
    );

    // Log system action
    await pool.query(
      `INSERT INTO system_logs (action, entity_type, entity_id, admin_user_id, details) 
       VALUES ($1, $2, $3, $4, $5)`,
      ['voucher_created', 'voucher', result.rows[0].id, req.admin.id, 
       JSON.stringify({ durationMinutes, code })]
    );

    sendResponse(res, {
      code,
      durationMinutes
    });

  } catch (error) {
    console.error('Voucher generation error:', error);
    sendError(res, 'Internal server error', 500);
  }
});

// Generate batch vouchers
app.post('/api/v1/admin/vouchers/batch', authenticateAdmin, async (req, res) => {
  try {
    const { quantity, durationMinutes } = req.body;

    if (!quantity || quantity <= 0 || !durationMinutes || durationMinutes <= 0) {
      return sendError(res, 'Valid quantity and durationMinutes are required');
    }

    if (quantity > 1000) {
      return sendError(res, 'Maximum 1000 vouchers per batch');
    }

    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');

      // Create batch record
      const batchResult = await client.query(
        `INSERT INTO voucher_batches (quantity, duration_minutes, created_by) 
         VALUES ($1, $2, $3) 
         RETURNING id`,
        [quantity, durationMinutes, req.admin.id]
      );

      const batchId = batchResult.rows[0].id;
      const codes = [];

      // Generate vouchers
      for (let i = 0; i < quantity; i++) {
        let code;
        let isUnique = false;
        
        while (!isUnique) {
          code = generateVoucherCode();
          const existingResult = await client.query('SELECT id FROM vouchers WHERE code = $1', [code]);
          isUnique = existingResult.rows.length === 0;
        }

        await client.query(
          `INSERT INTO vouchers (code, duration_minutes, remaining_minutes, created_by, batch_id) 
           VALUES ($1, $2, $2, $3, $4)`,
          [code, durationMinutes, req.admin.id, batchId]
        );

        codes.push(code);
      }

      await client.query('COMMIT');

      // Log system action
      await pool.query(
        `INSERT INTO system_logs (action, entity_type, entity_id, admin_user_id, details) 
         VALUES ($1, $2, $3, $4, $5)`,
        ['voucher_batch_created', 'voucher_batch', batchId, req.admin.id, 
         JSON.stringify({ quantity, durationMinutes })]
      );

      sendResponse(res, {
        codes,
        total: codes.length
      });

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

  } catch (error) {
    console.error('Batch voucher generation error:', error);
    sendError(res, 'Internal server error', 500);
  }
});

// List vouchers
app.get('/api/v1/admin/vouchers', authenticateAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const status = req.query.status;
    const offset = (page - 1) * limit;

    let whereClause = '1=1';
    const queryParams = [limit, offset];

    if (status === 'active') {
      whereClause += ' AND is_active = true AND is_used = false';
    } else if (status === 'used') {
      whereClause += ' AND is_used = true';
    } else if (status === 'inactive') {
      whereClause += ' AND is_active = false';
    }

    const vouchersResult = await pool.query(
      `SELECT id, code, duration_minutes, remaining_minutes, is_used, is_active, 
              device_id, used_at, created_at
       FROM vouchers 
       WHERE ${whereClause}
       ORDER BY created_at DESC 
       LIMIT $1 OFFSET $2`,
      queryParams
    );

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM vouchers WHERE ${whereClause}`
    );

    sendResponse(res, {
      vouchers: vouchersResult.rows,
      total: parseInt(countResult.rows[0].count),
      page,
      limit
    });

  } catch (error) {
    console.error('List vouchers error:', error);
    sendError(res, 'Internal server error', 500);
  }
});

// List calls
app.get('/api/v1/admin/calls', authenticateAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = (page - 1) * limit;

    const callsResult = await pool.query(
      `SELECT cl.id, cl.call_id, cl.phone_number, cl.country_code, cl.call_type,
              cl.duration_seconds, cl.status, cl.started_at, cl.ended_at, cl.device_id,
              v.code as voucher_code
       FROM call_logs cl
       LEFT JOIN vouchers v ON cl.voucher_id = v.id
       ORDER BY cl.started_at DESC 
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const countResult = await pool.query('SELECT COUNT(*) FROM call_logs');

    sendResponse(res, {
      calls: callsResult.rows,
      total: parseInt(countResult.rows[0].count),
      page,
      limit
    });

  } catch (error) {
    console.error('List calls error:', error);
    sendError(res, 'Internal server error', 500);
  }
});

// =====================================
// SYSTEM ENDPOINTS
// =====================================

// Health check
app.get('/api/v1/health', (req, res) => {
  sendResponse(res, {
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

// =====================================
// ERROR HANDLING
// =====================================

// 404 handler
app.use((req, res) => {
  sendError(res, 'Endpoint not found', 404);
});

// Global error handler
app.use((error, req, res, next) => {
  console.error('Global error:', error);
  sendError(res, 'Internal server error', 500);
});

// =====================================
// SERVER START
// =====================================

app.listen(PORT, () => {
  console.log(`17Call API server running on port ${PORT}`);
  console.log(`Base URL: http://localhost:${PORT}/api/v1`);
});