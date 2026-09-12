/**
 * Saved & shared dashboards (ported from the web app's /api/ai/dashboards
 * routes). Backed by the `ai_dashboards` and `ai_dashboard_shares` tables.
 * All ownership is keyed by the JWT user id.
 */

import pool from './_db.mjs';

export async function listDashboards(userId) {
  const { rows: owned } = await pool.query(
    `SELECT id, title, thread_id, is_public, share_token, updated_at, created_at
     FROM ai_dashboards
     WHERE user_id = $1
     ORDER BY updated_at DESC
     LIMIT 200`,
    [userId],
  );

  let shared = [];
  try {
    const { rows } = await pool.query(
      `SELECT s.dashboard_id, d.id, d.title, d.user_id, d.thread_id, d.updated_at, d.created_at
       FROM ai_dashboard_shares s
       INNER JOIN ai_dashboards d ON d.id = s.dashboard_id
       WHERE s.shared_with_user_id = $1`,
      [userId],
    );
    shared = rows;
  } catch {
    // Sharing is optional — degrade gracefully if the table is absent.
  }

  return { owned, shared };
}

export async function saveDashboard(userId, body) {
  if (!body || !body.title || !Array.isArray(body.widgets)) {
    throw new Error('title and widgets required');
  }
  const { rows } = await pool.query(
    `INSERT INTO ai_dashboards (user_id, title, layout, widgets, thread_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, title, updated_at, created_at`,
    [userId, body.title, JSON.stringify(body.layout ?? {}), JSON.stringify(body.widgets), body.threadId ?? null],
  );
  return rows[0];
}

async function dashboardReadable(userId, dashboardId) {
  const { rows: dashRows } = await pool.query(
    'SELECT id, user_id, is_public FROM ai_dashboards WHERE id = $1',
    [dashboardId],
  );
  const dash = dashRows[0];
  if (!dash) return false;
  if (dash.user_id === userId) return true;
  if (dash.is_public) return true;
  const { rows: shareRows } = await pool.query(
    'SELECT id FROM ai_dashboard_shares WHERE dashboard_id = $1 AND shared_with_user_id = $2',
    [dashboardId, userId],
  );
  return shareRows.length > 0;
}

export async function getDashboard(userId, id) {
  if (!(await dashboardReadable(userId, id))) return null;
  const { rows } = await pool.query(
    `SELECT id, user_id, title, layout, widgets, thread_id, share_token, is_public, updated_at, created_at
     FROM ai_dashboards
     WHERE id = $1`,
    [id],
  );
  return rows[0] || null;
}

export async function updateDashboard(userId, id, body) {
  const setClauses = ['updated_at = $3'];
  const params = [id, userId, new Date().toISOString()];
  let paramIdx = 4;

  if (typeof body.title === 'string') {
    setClauses.push(`title = $${paramIdx++}`);
    params.push(body.title);
  }
  if (body.layout) {
    setClauses.push(`layout = $${paramIdx++}`);
    params.push(JSON.stringify(body.layout));
  }
  if (Array.isArray(body.widgets)) {
    setClauses.push(`widgets = $${paramIdx++}`);
    params.push(JSON.stringify(body.widgets));
  }
  if (setClauses.length === 1) throw new Error('no fields to update');

  const { rows } = await pool.query(
    `UPDATE ai_dashboards
     SET ${setClauses.join(', ')}
     WHERE id = $1 AND user_id = $2
     RETURNING id, title, updated_at`,
    params,
  );
  return rows[0];
}

export async function deleteDashboard(userId, id) {
  await pool.query(
    'DELETE FROM ai_dashboards WHERE id = $1 AND user_id = $2',
    [id, userId],
  );
  return { ok: true };
}
