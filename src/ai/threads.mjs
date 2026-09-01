/**
 * AI Assistant chat-thread persistence (ported from the web app's
 * /api/ai/threads routes). All queries are scoped to the authenticated
 * user's id (the auth UUID carried in the backend JWT).
 */

import pool from './_db.mjs';

export async function listThreads(userId) {
  const { rows } = await pool.query(
    'SELECT id, title, updated_at, created_at FROM ai_chat_threads WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 100',
    [userId],
  );
  return rows;
}

export async function createThread(userId) {
  const { rows } = await pool.query(
    "INSERT INTO ai_chat_threads (user_id, messages) VALUES ($1, '[]'::jsonb) RETURNING id, title, updated_at, created_at",
    [userId],
  );
  return rows[0];
}

export async function getThread(userId, id) {
  const { rows } = await pool.query(
    'SELECT id, title, messages, updated_at, created_at FROM ai_chat_threads WHERE id = $1 AND user_id = $2 LIMIT 1',
    [id, userId],
  );
  return rows[0] || null;
}

export async function saveThread(userId, id, { messages, title }) {
  const setClauses = ['updated_at = $1'];
  const params = [new Date().toISOString()];
  let idx = 2;

  if (Array.isArray(messages)) {
    setClauses.push(`messages = $${idx}`);
    params.push(JSON.stringify(messages));
    idx++;
  }
  if (typeof title === 'string') {
    setClauses.push(`title = $${idx}`);
    params.push(title);
    idx++;
  }

  params.push(id, userId);
  const { rows } = await pool.query(
    `UPDATE ai_chat_threads SET ${setClauses.join(', ')} WHERE id = $${idx} AND user_id = $${idx + 1} RETURNING id, title, updated_at`,
    params,
  );
  return rows[0];
}

export async function deleteThread(userId, id) {
  await pool.query(
    'DELETE FROM ai_chat_threads WHERE id = $1 AND user_id = $2',
    [id, userId],
  );
  return { success: true };
}
