-- WhatsApp LID addressing (Baileys v7): keep the phone-number JID next to a LID JID
ALTER TABLE messages ADD COLUMN IF NOT EXISTS remote_jid_alt VARCHAR(150);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_jid_alt VARCHAR(150);
CREATE INDEX IF NOT EXISTS idx_messages_remote_jid_alt ON messages(remote_jid_alt);
