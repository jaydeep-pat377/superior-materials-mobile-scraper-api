-- ============================================================================
-- Add push_sent_at to chat_messages + order_entity_messages so the realtime
-- listener can atomically claim a row before firing FCM. With multiple backend
-- instances (or local+prod) subscribed to the same database, the first to
-- UPDATE ... WHERE push_sent_at IS NULL wins; the others see 0 rows and skip.
-- Partial index keeps the common "is null" check cheap.
-- ============================================================================

ALTER TABLE public.chat_messages
  ADD COLUMN IF NOT EXISTS push_sent_at timestamptz;

ALTER TABLE public.order_entity_messages
  ADD COLUMN IF NOT EXISTS push_sent_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_chat_messages_push_sent_at_null
  ON public.chat_messages (id)
  WHERE push_sent_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_order_entity_messages_push_sent_at_null
  ON public.order_entity_messages (id)
  WHERE push_sent_at IS NULL;
