-- Outbound message queue: every message sent through the API is queued here first
CREATE TABLE IF NOT EXISTS outbound_messages (
    id BIGSERIAL PRIMARY KEY,
    session_id VARCHAR(100) NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    idempotency_key VARCHAR(200),
    target_jid VARCHAR(150) NOT NULL,
    message_type VARCHAR(30) NOT NULL,
    payload JSONB NOT NULL,
    media_data BYTEA, -- uploaded/base64 media until the message is sent
    status VARCHAR(20) NOT NULL DEFAULT 'queued', -- queued, processing, sent, delivered, read, played, failed, cancelled, expired
    scheduled_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    attempts INT NOT NULL DEFAULT 0,
    message_id VARCHAR(150),
    last_error TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sent_at TIMESTAMP WITH TIME ZONE
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_outbound_idempotency
    ON outbound_messages(session_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_outbound_due
    ON outbound_messages(session_id, scheduled_at, id) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_outbound_message_id
    ON outbound_messages(session_id, message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_outbound_created ON outbound_messages(created_at DESC);

-- Webhook outbox: events are stored first, then delivered (with retries) by the dispatcher
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id BIGSERIAL PRIMARY KEY,
    session_id VARCHAR(100) NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    event_type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending, delivered, failed
    attempts INT NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_url TEXT,
    last_status_code INT,
    last_error TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    delivered_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_webhook_due ON webhook_deliveries(next_attempt_at, id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_webhook_session_created ON webhook_deliveries(session_id, created_at DESC);

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS webhook_secret TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS webhook_events TEXT[];

-- Message history is always filtered by session and sorted by time
CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at DESC);
