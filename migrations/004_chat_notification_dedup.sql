-- Chat notification deduplication table
-- Run this on the NOTIFICATION database (not the tenant database).
--
-- When multiple server instances subscribe to the same realtime
-- channel, each receives every INSERT event and tries to send FCM independently.
-- This table acts as a distributed lock: only the first instance to INSERT
-- a row for a given (table_name, message_id) wins; the rest hit the unique
-- constraint and skip sending.

CREATE TABLE IF NOT EXISTS chat_notification_dedup (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_name    TEXT    NOT NULL,   -- 'chat_messages' or 'order_entity_messages'
  message_id    BIGINT  NOT NULL,   -- the id column from the source table
  processed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_chat_dedup UNIQUE (table_name, message_id)
);

-- CRITICAL: The backend connects with the anon key. RLS is enabled by
-- default, which would silently block all INSERTs and break deduplication.
-- This is an internal server-side table with no user data, so RLS is not needed.
ALTER TABLE chat_notification_dedup ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all operations for dedup" ON chat_notification_dedup
  FOR ALL USING (true) WITH CHECK (true);

-- Index for the cleanup query
CREATE INDEX IF NOT EXISTS idx_chat_dedup_processed_at
  ON chat_notification_dedup (processed_at);

-- Auto-cleanup: rows older than 24 hours are no longer needed.
-- Option A: If pg_cron is enabled, schedule automatic cleanup:
--   SELECT cron.schedule('cleanup-chat-dedup', '0 * * * *',
--     $$DELETE FROM chat_notification_dedup WHERE processed_at < now() - INTERVAL '24 hours'$$);
--
-- Option B: Run manually:
--   DELETE FROM chat_notification_dedup WHERE processed_at < now() - INTERVAL '24 hours';
