-- Per-session behaviour settings and webhook payload format
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS webhook_format VARCHAR(20) NOT NULL DEFAULT 'default';

-- Tenant API keys: limited to a set of sessions and optionally to source IPs. Only a hash is stored.
CREATE TABLE IF NOT EXISTS api_keys (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    key_prefix VARCHAR(16) NOT NULL UNIQUE,
    key_hash CHAR(64) NOT NULL,
    session_ids TEXT[], -- NULL = every session
    ip_allowlist TEXT[], -- NULL = any IP
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMP WITH TIME ZONE,
    revoked_at TIMESTAMP WITH TIME ZONE
);

-- Cache of "is this number on WhatsApp" lookups (bulk contact discovery is a ban signal)
CREATE TABLE IF NOT EXISTS number_checks (
    phone VARCHAR(20) PRIMARY KEY,
    exists_on_whatsapp BOOLEAN NOT NULL,
    jid VARCHAR(150),
    checked_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
