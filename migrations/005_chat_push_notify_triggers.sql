-- ============================================================================
-- Create PostgreSQL LISTEN/NOTIFY triggers for chat push notifications.
--
-- The chatRealtimeListener (server.js) subscribes to:
--   - chat_messages_insert
--   - order_entity_messages_insert
--
-- When a row is inserted into chat_messages or order_entity_messages, these
-- triggers fire pg_notify with the new row as JSON so the Node.js listener
-- can fan out FCM push notifications.
-- ============================================================================

-- 1. chat_messages -> chat_messages_insert channel
CREATE OR REPLACE FUNCTION notify_chat_messages_insert()
RETURNS trigger AS $$
DECLARE
  payload text;
BEGIN
  payload := row_to_json(NEW)::text;
  -- Guard against oversized payloads (pg_notify limit ~8000 bytes)
  IF octet_length(payload) > 7500 THEN
    payload := json_build_object(
      'id',           NEW.id,
      'order_id',     NEW.order_id,
      'chat_id',      NEW.chat_id,
      'sender_id',    NEW.sender_id,
      'sender_name',  NEW.sender_name,
      'message_text', left(NEW.message_text, 120),
      'is_deleted',   NEW.is_deleted,
      'created_at',   NEW.created_at
    )::text;
  END IF;
  PERFORM pg_notify('chat_messages_insert', payload);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_chat_push_notify ON chat_messages;
CREATE TRIGGER trg_chat_push_notify
  AFTER INSERT ON chat_messages
  FOR EACH ROW
  EXECUTE FUNCTION notify_chat_messages_insert();

-- 2. order_entity_messages -> order_entity_messages_insert channel
CREATE OR REPLACE FUNCTION notify_order_entity_messages_insert()
RETURNS trigger AS $$
DECLARE
  payload text;
BEGIN
  payload := row_to_json(NEW)::text;
  IF octet_length(payload) > 7500 THEN
    payload := json_build_object(
      'id',              NEW.id,
      'order_entity_id', NEW.order_entity_id,
      'sender_id',       NEW.sender_id,
      'sender_name',     NEW.sender_name,
      'message_text',    left(NEW.message_text, 120),
      'created_at',      NEW.created_at
    )::text;
  END IF;
  PERFORM pg_notify('order_entity_messages_insert', payload);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_order_entity_push_notify ON order_entity_messages;
CREATE TRIGGER trg_order_entity_push_notify
  AFTER INSERT ON order_entity_messages
  FOR EACH ROW
  EXECUTE FUNCTION notify_order_entity_messages_insert();
