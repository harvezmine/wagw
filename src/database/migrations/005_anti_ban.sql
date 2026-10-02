-- Anti-ban guards decided by the gateway, WhatsApp's own signals and ban details
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS paired_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS new_chats_paused_until TIMESTAMP WITH TIME ZONE;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS new_chats_pause_reason VARCHAR(200);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS campaigns_paused_until TIMESTAMP WITH TIME ZONE;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS campaigns_pause_reason VARCHAR(200);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ban_code INT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ban_expires_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS chat_cap JSONB;

-- Sessions paired before this migration count as paired when they were created (no cool-down for them)
UPDATE sessions SET paired_at = created_at WHERE paired_at IS NULL AND phone_number IS NOT NULL;

-- Campaign rules only apply to campaigns; new_contact marks sends that opened a new chat
ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS category VARCHAR(20) NOT NULL DEFAULT 'transactional';
ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS new_contact BOOLEAN;
CREATE INDEX IF NOT EXISTS idx_outbound_new_contact_sent ON outbound_messages(session_id, sent_at) WHERE new_contact;
CREATE INDEX IF NOT EXISTS idx_outbound_campaign_target ON outbound_messages(session_id, target_jid, sent_at) WHERE category = 'campaign';

-- Opt-ins imported through the API and opt-outs from STOP keywords or the API
CREATE TABLE IF NOT EXISTS contact_consents (
    session_id VARCHAR(100) NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    jid VARCHAR(150) NOT NULL,
    status VARCHAR(20) NOT NULL, -- opted_in, opted_out
    source VARCHAR(20) NOT NULL, -- api, keyword
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id, jid)
);

-- "Has this person ever written to us" lookups
CREATE INDEX IF NOT EXISTS idx_messages_inbound_remote ON messages(session_id, remote_jid, created_at DESC) WHERE from_me = false;
CREATE INDEX IF NOT EXISTS idx_messages_inbound_remote_alt ON messages(session_id, remote_jid_alt, created_at DESC) WHERE from_me = false;
