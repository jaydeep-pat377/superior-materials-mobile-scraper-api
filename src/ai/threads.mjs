/**
 * AI Assistant chat-thread persistence (ported from the web app's
 * /api/ai/threads routes). All queries are scoped to the authenticated
 * user's id (the auth UUID carried in the backend JWT).
 */

import pool from './_db.mjs';

export async function listThreads(userId) {
  const { rows } = await pool.query(
    `SELECT id, title, updated_at, created_at
     FROM ai_chat_threads
     WHERE user_id = $1
     ORDER BY updated_at DESC
     LIMIT 100`,
    [userId],
  );
  return rows;
}

export async function createThread(userId) {
  const { rows } = await pool.query(
    `INSERT INTO ai_chat_threads (user_id, messages)
     VALUES ($1, $2)
     RETURNING id, title, updated_at, created_at`,
    [userId, JSON.stringify([])],
  );
  return rows[0];
}

export async function getThread(userId, id) {
  const { rows } = await pool.query(
    `SELECT id, title, messages, updated_at, created_at
     FROM ai_chat_threads
     WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return rows[0] || null;
}

export async function saveThread(userId, id, { messages, title }) {
  const setClauses = ['updated_at = $3'];
  const params = [id, userId, new Date().toISOString()];
  let paramIdx = 4;

  if (Array.isArray(messages)) {
    setClauses.push(`messages = $${paramIdx}`);
    params.push(JSON.stringify(messages));
    paramIdx++;
  }
  if (typeof title === 'string') {
    setClauses.push(`title = $${paramIdx}`);
    params.push(title);
    paramIdx++;
  }

  const { rows } = await pool.query(
    `UPDATE ai_chat_threads
     SET ${setClauses.join(', ')}
     WHERE id = $1 AND user_id = $2
     RETURNING id, title, updated_at`,
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
