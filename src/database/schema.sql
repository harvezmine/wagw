-- WhatsApp Gateway Database Schema

CREATE TABLE IF NOT EXISTS sessions (
    id VARCHAR(100) PRIMARY KEY,
    phone_number VARCHAR(50),
    status VARCHAR(50) DEFAULT 'disconnected', -- disconnected, connecting, qr_ready, connected
    webhook_url TEXT,
    qr_code TEXT,
    custom_name VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS baileys_auth_store (
    session_id VARCHAR(100) NOT NULL,
    data_type VARCHAR(100) NOT NULL,
    data_id VARCHAR(150) NOT NULL,
    value JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id, data_type, data_id)
);

CREATE INDEX IF NOT EXISTS idx_baileys_session ON baileys_auth_store(session_id);

CREATE TABLE IF NOT EXISTS messages (
    id BIGSERIAL PRIMARY KEY,
    session_id VARCHAR(100) NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    message_id VARCHAR(150) NOT NULL,
    remote_jid VARCHAR(150) NOT NULL,
    sender_jid VARCHAR(150),
    from_me BOOLEAN DEFAULT FALSE,
    push_name VARCHAR(150),
    message_type VARCHAR(100),
    content TEXT,
    media_url TEXT,
    status VARCHAR(50) DEFAULT 'received', -- received, sent, delivered, read, failed
    raw_payload JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_session_message UNIQUE (session_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_remote_jid ON messages(remote_jid);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at DESC);

CREATE TABLE IF NOT EXISTS webhook_logs (
    id BIGSERIAL PRIMARY KEY,
    session_id VARCHAR(100),
    message_id VARCHAR(150),
    event_type VARCHAR(100),
    webhook_url TEXT,
    payload JSONB,
    status_code INT,
    response_body TEXT,
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
