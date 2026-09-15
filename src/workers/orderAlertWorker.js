/**
 * Order Alert Worker
 *
 * Periodically scans today's orders and sends FCM push notifications for:
 *   - NEW_ORDER          — order synced in the last polling interval
 *   - LATE_ORDER          — scheduled time passed, no tickets started
 *   - DELAY_ORDER         — started but slow progress (some tickets, not all)
 *   - STUCK_AT_JOB        — truck on-site > 90 min without unloading
 *   - ORDER_CANCELLED     — order was removed/cancelled
 *   - ORDER_COMPLETED     — order reached status 4
 *
 * Notifications go to a single target user (configurable via env).
 * Dedup: each (event_code, entity_id) pair is tracked in-memory per day to
 * avoid duplicate pushes within the same server lifetime.
 *
 * Runs every 5 minutes via server.js.
 */

const crypto = require('crypto');
const { executeDirectSQL } = require('../utils/postgresExecutor');
const deviceService = require('../services/deviceService');
const { getMessaging } = require('../config/Firebase');
const { getNotificationPool } = require('../config/notificationDatabase');

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const TARGET_USER_ID = process.env.ORDER_ALERT_USER_ID || 'a05892d9-6d78-40ec-9bf6-30c1ad59d462';
const TARGET_TENANT_ID = parseInt(process.env.ORDER_ALERT_TENANT_ID || process.env.TENANT_ID || '42', 10);

/**
 * DB-level dedup: check notification_queue to see if this (event_code, entity_id)
 * was already sent today. Works across multiple pods.
 */
async function alreadySent(eventCode, entityId) {
  try {
    const pool = getNotificationPool();
    const { rows } = await pool.query(
      `SELECT 1 FROM notification_queue
       WHERE user_id = $1 AND event_code = $2 AND entity_id = $3
         AND created_at > CURRENT_DATE
       LIMIT 1`,
      [TARGET_USER_ID, eventCode, String(entityId)]
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

// ── FCM push helper ──────────────────────────────────────────────────────

async function sendPush(title, body, data) {
  try {
    const tokens = await deviceService.getUserDeviceTokens(TARGET_USER_ID);
    if (!tokens || tokens.length === 0) return { successCount: 0, skipped: 'no_tokens' };

    const messaging = getMessaging();
    const fcmData = Object.entries(data).reduce((acc, [k, v]) => {
      acc[k] = v == null ? '' : String(v);
      return acc;
    }, {});

    const message = {
      notification: { title, body },
      data: fcmData,
      android: { priority: 'high', notification: { channelId: 'orders', sound: 'default', priority: 'high' } },
      apns: { headers: { 'apns-priority': '10' }, payload: { aps: { alert: { title, body }, sound: 'default', badge: 1, 'mutable-content': 1 } } },
      tokens,
    };

    const response = await messaging.sendEachForMulticast(message);

    // Deactivate invalid tokens
    const invalid = response.responses
      .map((r, i) => (!r.success && r.error?.code?.includes('not-registered') ? tokens[i] : null))
      .filter(Boolean);
    if (invalid.length > 0) deviceService.batchDeactivateTokens(invalid).catch(() => {});

    return { successCount: response.successCount, failureCount: response.failureCount };
  } catch (err) {
    console.error('[OrderAlerts] push error:', err.message);
    return { successCount: 0, error: err.message };
  }
}

// ── Queue helper (notification history) ──────────────────────────────────

async function queueNotification(eventCode, entityId, subject, body, orderCode, orderDate) {
  try {
    const pool = getNotificationPool();
    await pool.query(
      `INSERT INTO notification_queue
        (queue_uuid, channel_code, user_id, tenant_id, event_code, event_name, entity_type, entity_id, subject, body, priority, status, order_code, order_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [crypto.randomUUID(), 'push', TARGET_USER_ID, TARGET_TENANT_ID, eventCode, eventCode.replace(/_/g, ' '),
       'order', entityId, subject, body, 1, 'sent', orderCode || null, orderDate || null]
    );
  } catch (err) {
    console.error('[OrderAlerts] queue insert error:', err.message);
  }
}

// ── Alert logic ──────────────────────────────────────────────────────────

async function sendAlert(eventCode, orderId, orderCode, orderDate, title, body) {
  if (await alreadySent(eventCode, orderId)) return;

  // Insert into queue FIRST (acts as the atomic claim across pods)
  await queueNotification(eventCode, orderId, title, body, orderCode, orderDate);

  const data = { event_code: eventCode, order_id: String(orderId), order_code: String(orderCode), order_date: orderDate || '' };
  const result = await sendPush(title, body, data);

  console.log(`[OrderAlerts] ${eventCode} order=#${orderCode} -> ${result.successCount || 0} pushed`);
}

// ── Main scan ────────────────────────────────────────────────────────────

async function scanAndNotify() {
  const today = new Date().toISOString().slice(0, 10);

  try {
    // 1. NEW ORDERS — synced in the last polling interval
    const newOrders = await executeDirectSQL(`
      SELECT order_id, order_code, order_date::date as od, customer_name
      FROM orders
      WHERE order_date::date = $1
        AND NOT COALESCE(removed, false)
        AND created_date > NOW() - interval '6 minutes'
      ORDER BY order_id
      LIMIT 20
    `, [today]);

    for (const o of (newOrders.data || [])) {
      await sendAlert('NEW_ORDER', o.order_id, o.order_code, today,
        `New Order #${o.order_code}`,
        `${o.customer_name || 'Customer'} placed a new order`);
    }

    // 2. LATE ORDERS — past schedule, no tickets started
    const lateOrders = await executeDirectSQL(`
      SELECT o.order_id, o.order_code, o.customer_name
      FROM orders o
      WHERE o.order_date::date = $1
        AND NOT COALESCE(o.removed, false)
        AND COALESCE(o.current_status, 0) NOT IN (4)
        AND o.order_date < NOW()
        AND NOT EXISTS (
          SELECT 1 FROM tickets t
          WHERE t.order_id = o.order_id AND t.printed_time IS NOT NULL
        )
      ORDER BY o.order_date
      LIMIT 20
    `, [today]);

    for (const o of (lateOrders.data || [])) {
      await sendAlert('LATE_ORDER', o.order_id, o.order_code, today,
        `Late Order #${o.order_code}`,
        `${o.customer_name || 'Order'} — scheduled time passed, no deliveries started`);
    }

    // 3. DELAY ORDERS — started but slow progress
    const delayOrders = await executeDirectSQL(`
      SELECT o.order_id, o.order_code, o.customer_name,
        COUNT(t.ticket_id) FILTER (WHERE t.printed_time IS NOT NULL) AS started,
        COUNT(t.ticket_id) FILTER (WHERE t.at_plant_time IS NOT NULL) AS completed,
        COUNT(t.ticket_id) AS total
      FROM orders o
      JOIN tickets t ON t.order_id = o.order_id
      WHERE o.order_date::date = $1
        AND NOT COALESCE(o.removed, false)
        AND COALESCE(o.current_status, 0) NOT IN (4)
        AND o.order_date < NOW() - interval '30 minutes'
      GROUP BY o.order_id, o.order_code, o.customer_name
      HAVING COUNT(t.ticket_id) FILTER (WHERE t.printed_time IS NOT NULL) > 0
        AND COUNT(t.ticket_id) FILTER (WHERE t.at_plant_time IS NOT NULL) < COUNT(t.ticket_id)
      LIMIT 20
    `, [today]);

    for (const o of (delayOrders.data || [])) {
      await sendAlert('DELAY_ORDER', o.order_id, o.order_code, today,
        `Delayed Order #${o.order_code}`,
        `${o.customer_name || 'Order'} — ${o.completed}/${o.total} loads completed, delivery behind schedule`);
    }

    // 4. STUCK AT JOB — on-site > 90 min without unload
    const stuckTickets = await executeDirectSQL(`
      SELECT t.ticket_id, t.ticket_code, t.truck_code, o.order_id, o.order_code,
        ROUND(EXTRACT(EPOCH FROM (NOW() - t.on_job_time))/60) AS mins
      FROM tickets t
      JOIN orders o ON o.order_id = t.order_id
      WHERE o.order_date::date = $1
        AND t.on_job_time IS NOT NULL
        AND t.unload_time IS NULL
        AND t.at_plant_time IS NULL
        AND EXTRACT(EPOCH FROM (NOW() - t.on_job_time))/60 > 90
      ORDER BY mins DESC
      LIMIT 10
    `, [today]);

    for (const t of (stuckTickets.data || [])) {
      await sendAlert('STUCK_AT_JOB', t.ticket_id, t.ticket_code || t.order_code, today,
        `Truck Stuck at Job`,
        `Truck ${t.truck_code || '?'} on order #${t.order_code} — on-site ${t.mins} min without unloading`);
    }

    // 5. CANCELLED ORDERS — recently removed
    const cancelledOrders = await executeDirectSQL(`
      SELECT order_id, order_code, customer_name
      FROM orders
      WHERE order_date::date = $1
        AND COALESCE(removed, false) = true
      LIMIT 30
    `, [today]);

    for (const o of (cancelledOrders.data || [])) {
      await sendAlert('ORDER_CANCELLED', o.order_id, o.order_code, today,
        `Order #${o.order_code} Cancelled`,
        `${o.customer_name || 'Order'} has been cancelled`);
    }

    // 6. COMPLETED ORDERS — status = 4
    const completedOrders = await executeDirectSQL(`
      SELECT order_id, order_code, customer_name
      FROM orders
      WHERE order_date::date = $1
        AND COALESCE(current_status, 0) = 4
        AND NOT COALESCE(removed, false)
      LIMIT 30
    `, [today]);

    for (const o of (completedOrders.data || [])) {
      await sendAlert('ORDER_COMPLETED', o.order_id, o.order_code, today,
        `Order #${o.order_code} Completed`,
        `${o.customer_name || 'Order'} delivery completed`);
    }

  } catch (err) {
    console.error('[OrderAlerts] scan error:', err.message);
  }
}

// ── Public API ───────────────────────────────────────────────────────────

function startOrderAlertWorker() {
  console.log(`[OrderAlerts] Worker started (interval=${POLL_INTERVAL_MS / 1000}s, user=${TARGET_USER_ID})`);
  // Run after a short delay (let DB connect first)
  setTimeout(() => scanAndNotify().catch(() => {}), 10000);
  setInterval(() => scanAndNotify().catch(() => {}), POLL_INTERVAL_MS);
}

module.exports = { startOrderAlertWorker, scanAndNotify };
