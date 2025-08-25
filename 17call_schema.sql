-- 17Call Prison Phone System Database Schema
-- PostgreSQL Database Schema

-- Enable UUID extension for generating unique IDs
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Admin users table
CREATE TABLE admin_users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    email VARCHAR(100),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP WITH TIME ZONE
);

-- Vouchers table
CREATE TABLE vouchers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code VARCHAR(20) UNIQUE NOT NULL,
    duration_minutes INTEGER NOT NULL,
    remaining_minutes INTEGER NOT NULL,
    is_used BOOLEAN DEFAULT false,
    is_active BOOLEAN DEFAULT true,
    device_id VARCHAR(100), -- Track which device used the voucher
    used_at TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE, -- Optional expiration date
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_by UUID REFERENCES admin_users(id)
);

-- Call logs table
CREATE TABLE call_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    call_id VARCHAR(50) UNIQUE NOT NULL, -- External call ID from API
    voucher_id UUID REFERENCES vouchers(id) ON DELETE SET NULL,
    phone_number VARCHAR(20) NOT NULL,
    country_code VARCHAR(5) NOT NULL,
    call_type VARCHAR(20) NOT NULL, -- 'local', 'national', 'international'
    duration_seconds INTEGER DEFAULT 0,
    status VARCHAR(20) DEFAULT 'active', -- 'active', 'completed', 'failed', 'cancelled'
    started_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    ended_at TIMESTAMP WITH TIME ZONE,
    device_id VARCHAR(100), -- Track which device made the call
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Voucher batches table (for tracking bulk generations)
CREATE TABLE voucher_batches (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    batch_name VARCHAR(100),
    quantity INTEGER NOT NULL,
    duration_minutes INTEGER NOT NULL,
    created_by UUID REFERENCES admin_users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Link vouchers to their batches
ALTER TABLE vouchers ADD COLUMN batch_id UUID REFERENCES voucher_batches(id);

-- System logs table (for audit trail)
CREATE TABLE system_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    action VARCHAR(50) NOT NULL, -- 'voucher_created', 'call_started', 'call_ended', etc.
    entity_type VARCHAR(20), -- 'voucher', 'call', 'admin'
    entity_id UUID,
    details JSONB, -- Store additional details as JSON
    ip_address INET,
    user_agent TEXT,
    admin_user_id UUID REFERENCES admin_users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for better performance
CREATE INDEX idx_vouchers_code ON vouchers(code);
CREATE INDEX idx_vouchers_is_used ON vouchers(is_used);
CREATE INDEX idx_vouchers_is_active ON vouchers(is_active);
CREATE INDEX idx_vouchers_created_at ON vouchers(created_at);
CREATE INDEX idx_vouchers_device_id ON vouchers(device_id);

CREATE INDEX idx_call_logs_call_id ON call_logs(call_id);
CREATE INDEX idx_call_logs_voucher_id ON call_logs(voucher_id);
CREATE INDEX idx_call_logs_status ON call_logs(status);
CREATE INDEX idx_call_logs_started_at ON call_logs(started_at);
CREATE INDEX idx_call_logs_device_id ON call_logs(device_id);

CREATE INDEX idx_admin_users_username ON admin_users(username);
CREATE INDEX idx_system_logs_action ON system_logs(action);
CREATE INDEX idx_system_logs_created_at ON system_logs(created_at);

-- Create updated_at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply updated_at triggers to relevant tables
CREATE TRIGGER update_admin_users_updated_at BEFORE UPDATE ON admin_users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_vouchers_updated_at BEFORE UPDATE ON vouchers FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_call_logs_updated_at BEFORE UPDATE ON call_logs FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Insert default admin user (password should be changed immediately)
-- Default password is 'admin123' - CHANGE THIS IN PRODUCTION
INSERT INTO admin_users (username, password_hash, email) 
VALUES ('admin', '$2a$12$Tx4NvMdfX4R5aqzyd1bVjezSTJ/kJAj9cjfEQVN35b3zem1cQ6KRW', 'admin@17call.com');

-- Create view for active vouchers summary
CREATE VIEW active_vouchers_summary AS
SELECT 
    COUNT(*) as total_vouchers,
    COUNT(CASE WHEN is_used = false THEN 1 END) as unused_vouchers,
    COUNT(CASE WHEN is_used = true THEN 1 END) as used_vouchers,
    SUM(CASE WHEN is_used = false THEN duration_minutes ELSE 0 END) as unused_minutes,
    SUM(CASE WHEN is_used = true THEN duration_minutes ELSE 0 END) as used_minutes
FROM vouchers 
WHERE is_active = true;

-- Create view for call statistics
CREATE VIEW call_statistics AS
SELECT 
    DATE(started_at) as call_date,
    COUNT(*) as total_calls,
    COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_calls,
    COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_calls,
    SUM(duration_seconds) as total_duration_seconds,
    AVG(duration_seconds) as avg_duration_seconds,
    call_type
FROM call_logs 
WHERE started_at >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY DATE(started_at), call_type
ORDER BY call_date DESC;

-- Add comments to tables
COMMENT ON TABLE admin_users IS 'Stores administrator user accounts for the system';
COMMENT ON TABLE vouchers IS 'Stores phone call vouchers with duration and usage tracking';
COMMENT ON TABLE call_logs IS 'Logs all phone calls made through the system';
COMMENT ON TABLE voucher_batches IS 'Tracks bulk voucher generation batches';
COMMENT ON TABLE system_logs IS 'Audit trail for system actions and events';

COMMENT ON COLUMN vouchers.code IS 'Unique voucher code entered by users';
COMMENT ON COLUMN vouchers.remaining_minutes IS 'Minutes remaining on this voucher after calls';
COMMENT ON COLUMN call_logs.call_id IS 'External call ID used by the calling system';
COMMENT ON COLUMN call_logs.duration_seconds IS 'Actual call duration in seconds';