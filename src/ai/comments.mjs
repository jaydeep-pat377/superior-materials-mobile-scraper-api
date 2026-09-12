/** Per-widget comments on saved dashboards (ported from /api/ai/dashboards/[id]/comments). */
import pool from './_db.mjs';

async function canReadDashboard(userId, id) {
  const { rows: dashRows } = await pool.query(
    'SELECT user_id, is_public FROM ai_dashboards WHERE id = $1',
    [id],
  );
  const dash = dashRows[0];
  if (!dash) return false;
  if (dash.user_id === userId || dash.is_public) return true;
  const { rows: shareRows } = await pool.query(
    'SELECT id FROM ai_dashboard_shares WHERE dashboard_id = $1 AND shared_with_user_id = $2',
    [id, userId],
  );
  return shareRows.length > 0;
}

export async function listComments(userId, id, widgetId) {
  if (!(await canReadDashboard(userId, id))) {
    throw Object.assign(new Error('Not found'), { status: 404 });
  }
  const params = [id];
  let widgetClause = '';
  if (widgetId) {
    widgetClause = ' AND widget_id = $2';
    params.push(widgetId);
  }
  const { rows } = await pool.query(
    `SELECT id, widget_id, user_id, body, parent_id, created_at
     FROM ai_widget_comments
     WHERE dashboard_id = $1${widgetClause}
     ORDER BY created_at ASC`,
    params,
  );
  return { comments: rows };
}

export async function addComment(userId, id, { widgetId, body, parentId } = {}) {
  if (!(await canReadDashboard(userId, id))) {
    throw Object.assign(new Error('Not found'), { status: 404 });
  }
  if (!widgetId || !body || !body.trim()) {
    throw Object.assign(new Error('widgetId and body required'), { status: 400 });
  }
  if (body.length > 4000) throw Object.assign(new Error('body too long'), { status: 400 });
  const { rows } = await pool.query(
    `INSERT INTO ai_widget_comments (dashboard_id, widget_id, user_id, body, parent_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, widget_id, user_id, body, parent_id, created_at`,
    [id, widgetId, userId, body, parentId ?? null],
  );
  return { comment: rows[0] };
}

export async function editComment(userId, commentId, body) {
  if (!body || body.length > 4000) {
    throw Object.assign(new Error('body required (≤4000 chars)'), { status: 400 });
  }
  const { rows } = await pool.query(
    `UPDATE ai_widget_comments
     SET body = $1
     WHERE id = $2 AND user_id = $3
     RETURNING id, body, updated_at`,
    [body, commentId, userId],
  );
  return { comment: rows[0] };
}

export async function deleteComment(userId, commentId) {
  await pool.query(
    'DELETE FROM ai_widget_comments WHERE id = $1 AND user_id = $2',
    [commentId, userId],
  );
  return { ok: true };
}
