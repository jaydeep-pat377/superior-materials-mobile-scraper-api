/**
 * Daily Intelligence Compute Worker
 *
 * Computes KPI metrics from orders, tickets, and plant_weather tables
 * and upserts them into the daily_intelligence table.
 *
 * Runs on a schedule (every 5 minutes) via server.js or standalone.
 *
 * current_status mapping:
 *   0 = Normal (pre-pour)
 *   1 = Will Call (pre-pour)
 *   2 = Weather Permitting (pre-pour)
 *   3 = Hold Delivery (pre-pour)
 *   4 = Completed
 *   5 = Wait List (pre-pour)
 *   removed = true → Cancelled
 */

const { executeDirectSQL } = require('../utils/postgresExecutor');

const COMPUTE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Compute and upsert daily intelligence for a given date (defaults to today).
 */
async function computeDailyIntelligence(reportDate) {
  const date = reportDate || new Date().toISOString().slice(0, 10);
  const prevDate = new Date(new Date(date).getTime() - 86400000).toISOString().slice(0, 10);

  try {
    // --- 1. Status breakdown ---
    const statusResult = await executeDirectSQL(`
      SELECT
        count(*) FILTER (WHERE NOT COALESCE(removed, false) AND COALESCE(current_status, 0) IN (0, 1, 2, 3, 5)) AS status_pre_pour,
        count(*) FILTER (WHERE NOT COALESCE(removed, false) AND COALESCE(current_status, 0) = 0
          AND order_id IN (SELECT DISTINCT order_id FROM tickets t2 WHERE t2.order_id = o.order_id AND t2.printed_time IS NOT NULL AND t2.at_plant_time IS NULL)) AS status_in_process,
        count(*) FILTER (WHERE COALESCE(current_status, 0) = 4) AS status_completed,
        count(*) FILTER (WHERE COALESCE(removed, false) = true) AS status_canceled
      FROM orders o
      WHERE order_date::date = $1
    `, [date]);

    const statusRow = statusResult.data?.[0] || {};

    // --- 2. Late orders (orders with tickets that are behind schedule) ---
    const lateResult = await executeDirectSQL(`
      WITH order_tickets AS (
        SELECT o.order_id, o.order_code,
          count(t.ticket_id) FILTER (WHERE t.printed_time IS NOT NULL) AS started_tickets,
          count(t.ticket_id) FILTER (WHERE t.at_plant_time IS NOT NULL) AS completed_tickets,
          count(t.ticket_id) AS total_tickets,
          o.order_date, o.current_status, o.removed
        FROM orders o
        LEFT JOIN tickets t ON t.order_id = o.order_id
        WHERE o.order_date::date = $1
          AND NOT COALESCE(o.removed, false)
          AND COALESCE(o.current_status, 0) != 4
        GROUP BY o.order_id, o.order_code, o.order_date, o.current_status, o.removed
      )
      SELECT
        count(*) FILTER (WHERE order_date < NOW() AND started_tickets = 0) AS late_not_started,
        count(*) FILTER (WHERE order_date < NOW() AND started_tickets > 0 AND completed_tickets < total_tickets AND total_tickets > 0) AS late_slow_progress,
        count(*) FILTER (WHERE order_date < NOW() AND completed_tickets = total_tickets AND total_tickets > 0) AS late_past_finish
      FROM order_tickets
      WHERE order_date IS NOT NULL AND order_date < NOW()
    `, [date]);

    const lateRow = lateResult.data?.[0] || {};
    const lateNotStarted = parseInt(lateRow.late_not_started) || 0;
    const lateSlowProgress = parseInt(lateRow.late_slow_progress) || 0;
    const latePastFinish = parseInt(lateRow.late_past_finish) || 0;
    const lateTotal = lateNotStarted + lateSlowProgress + latePastFinish;

    // Late order details
    const lateDetailsResult = await executeDirectSQL(`
      SELECT o.order_id, o.order_code, o.order_date,
        CASE
          WHEN NOT EXISTS (SELECT 1 FROM tickets t WHERE t.order_id = o.order_id AND t.printed_time IS NOT NULL) THEN 'not_started'
          WHEN EXISTS (SELECT 1 FROM tickets t WHERE t.order_id = o.order_id AND t.at_plant_time IS NULL AND t.printed_time IS NOT NULL) THEN 'slow_progress'
          ELSE 'past_finish'
        END AS late_reason
      FROM orders o
      WHERE o.order_date::date = $1
        AND NOT COALESCE(o.removed, false)
        AND COALESCE(o.current_status, 0) != 4
        AND o.order_date IS NOT NULL
        AND o.order_date < NOW()
      LIMIT 50
    `, [date]);

    // --- 3. Average round trip ---
    const rtResult = await executeDirectSQL(`
      SELECT round(avg(EXTRACT(EPOCH FROM (at_plant_time - printed_time))/60)::numeric, 1) AS avg_mins,
        count(*) AS sample
      FROM tickets t
      JOIN orders o ON o.order_id = t.order_id
      WHERE o.order_date::date = $1
        AND t.at_plant_time IS NOT NULL AND t.printed_time IS NOT NULL
        AND EXTRACT(EPOCH FROM (at_plant_time - printed_time)) > 0
    `, [date]);

    const prevRtResult = await executeDirectSQL(`
      SELECT round(avg(EXTRACT(EPOCH FROM (at_plant_time - printed_time))/60)::numeric, 1) AS avg_mins
      FROM tickets t
      JOIN orders o ON o.order_id = t.order_id
      WHERE o.order_date::date = $1
        AND t.at_plant_time IS NOT NULL AND t.printed_time IS NOT NULL
        AND EXTRACT(EPOCH FROM (at_plant_time - printed_time)) > 0
    `, [prevDate]);

    const avgRt = rtResult.data?.[0]?.avg_mins ? parseFloat(rtResult.data[0].avg_mins) : null;
    const prevAvgRt = prevRtResult.data?.[0]?.avg_mins ? parseFloat(prevRtResult.data[0].avg_mins) : null;
    const rtSample = parseInt(rtResult.data?.[0]?.sample) || 0;
    const rtChangePercent = (avgRt && prevAvgRt) ? parseFloat(((avgRt - prevAvgRt) / prevAvgRt * 100).toFixed(1)) : null;

    const avgRtDisplay = avgRt
      ? `${Math.floor(avgRt / 60)}h ${Math.round(avgRt % 60)}m`
      : null;

    // --- 4. Stuck at job (tickets on-job for > 90 min without unload) ---
    const stuckResult = await executeDirectSQL(`
      SELECT t.ticket_id, t.ticket_code, t.truck_code, t.order_code,
        round(EXTRACT(EPOCH FROM (NOW() - t.on_job_time))/60) AS mins_on_job
      FROM tickets t
      JOIN orders o ON o.order_id = t.order_id
      WHERE o.order_date::date = $1
        AND t.on_job_time IS NOT NULL
        AND t.unload_time IS NULL
        AND t.at_plant_time IS NULL
        AND EXTRACT(EPOCH FROM (NOW() - t.on_job_time))/60 > 90
      ORDER BY mins_on_job DESC
      LIMIT 20
    `, [date]);

    const stuckDetails = (stuckResult.data || []).map(r => ({
      ticket_code: r.ticket_code,
      truck_code: r.truck_code,
      order_code: r.order_code,
      mins_on_job: parseInt(r.mins_on_job)
    }));

    // --- 5. Slow plants (avg round trip per plant, flag > 120 min) ---
    const slowPlantsResult = await executeDirectSQL(`
      SELECT t.plant_code, t.plant_name,
        round(avg(EXTRACT(EPOCH FROM (at_plant_time - printed_time))/60)::numeric, 1) AS avg_mins,
        count(*) AS sample
      FROM tickets t
      JOIN orders o ON o.order_id = t.order_id
      WHERE o.order_date::date = $1
        AND t.at_plant_time IS NOT NULL AND t.printed_time IS NOT NULL
        AND EXTRACT(EPOCH FROM (at_plant_time - printed_time)) > 0
      GROUP BY t.plant_code, t.plant_name
      HAVING avg(EXTRACT(EPOCH FROM (at_plant_time - printed_time))/60) > 120
      ORDER BY avg_mins DESC
    `, [date]);

    // --- 6. Congested sites (orders with > 3 trucks on-site simultaneously) ---
    const congestedResult = await executeDirectSQL(`
      SELECT o.order_code, o.order_id, count(*) AS trucks_on_site
      FROM tickets t
      JOIN orders o ON o.order_id = t.order_id
      WHERE o.order_date::date = $1
        AND t.on_job_time IS NOT NULL
        AND t.unload_time IS NULL
        AND t.at_plant_time IS NULL
      GROUP BY o.order_code, o.order_id
      HAVING count(*) > 3
      ORDER BY trucks_on_site DESC
    `, [date]);

    // --- 7. Weather risk (from plant_weather) ---
    const weatherResult = await executeDirectSQL(`
      SELECT pw.plant_id,
        pw.temperature_fahrenheit, pw.humidity, pw.wind_speed,
        pw.weather_condition, pw.weather_description
      FROM plant_weather pw
      WHERE pw.fetched_at > NOW() - interval '24 hours'
    `);

    let weatherRiskSevere = 0, weatherRiskVeryHigh = 0, weatherRiskHigh = 0, weatherRiskModerate = 0;
    const weatherDetails = [];

    for (const w of (weatherResult.data || [])) {
      const temp = parseFloat(w.temperature_fahrenheit) || 70;
      const wind = parseFloat(w.wind_speed) || 0;
      const humidity = parseInt(w.humidity) || 50;
      const cond = (w.weather_condition || '').toLowerCase();

      let risk = 'low';
      if (cond.includes('thunder') || cond.includes('tornado') || wind > 40) {
        risk = 'severe'; weatherRiskSevere++;
      } else if (temp > 100 || temp < 20 || wind > 30 || cond.includes('snow') || cond.includes('ice')) {
        risk = 'very_high'; weatherRiskVeryHigh++;
      } else if (temp > 95 || temp < 32 || wind > 20 || cond.includes('rain') || cond.includes('drizzle')) {
        risk = 'high'; weatherRiskHigh++;
      } else if (humidity > 90 || temp > 90 || wind > 15) {
        risk = 'moderate'; weatherRiskModerate++;
      }

      if (risk !== 'low') {
        weatherDetails.push({ plant_id: w.plant_id, risk, temp, wind, humidity, condition: w.weather_condition });
      }
    }

    const weatherRiskTotal = weatherRiskSevere + weatherRiskVeryHigh + weatherRiskHigh + weatherRiskModerate;

    // --- 8. Top products (from ticket_products, last 7 days) ---
    const productsResult = await executeDirectSQL(`
      SELECT tp.item_code, tp.description, count(*) AS cnt
      FROM ticket_products tp
      JOIN tickets t ON t.ticket_id = tp.ticket_id
      JOIN orders o ON o.order_id = t.order_id
      WHERE o.order_date::date = $1
        AND tp.is_mix = true
      GROUP BY tp.item_code, tp.description
      ORDER BY cnt DESC
      LIMIT 10
    `, [date]);

    const topProducts = (productsResult.data || []).map(p => ({
      code: p.item_code,
      description: p.description,
      count: parseInt(p.cnt)
    }));

    // --- UPSERT ---
    await executeDirectSQL(`
      INSERT INTO daily_intelligence (
        report_date, company_code, plant_code, region_name,
        late_orders_total, late_not_started, late_slow_progress, late_past_finish,
        late_orders_details,
        stuck_at_job_total, stuck_at_job_details,
        slow_plants_total, slow_plants_details,
        congested_sites_total, congested_sites_details,
        avg_round_trip_minutes, avg_round_trip_display,
        prev_day_avg_round_trip_minutes, round_trip_change_percent, round_trip_sample_count,
        weather_risk_total, weather_risk_severe, weather_risk_very_high, weather_risk_high, weather_risk_moderate,
        weather_risk_details,
        status_pre_pour, status_in_process, status_completed, status_canceled,
        top_products,
        computed_at, created_at
      ) VALUES (
        $1, 'ALL', NULL, NULL,
        $2, $3, $4, $5,
        $6,
        $7, $8,
        $9, $10,
        $11, $12,
        $13, $14,
        $15, $16, $17,
        $18, $19, $20, $21, $22,
        $23,
        $24, $25, $26, $27,
        $28,
        NOW(), NOW()
      )
      ON CONFLICT (report_date, company_code) WHERE plant_code IS NULL AND region_name IS NULL
      DO UPDATE SET
        late_orders_total = EXCLUDED.late_orders_total,
        late_not_started = EXCLUDED.late_not_started,
        late_slow_progress = EXCLUDED.late_slow_progress,
        late_past_finish = EXCLUDED.late_past_finish,
        late_orders_details = EXCLUDED.late_orders_details,
        stuck_at_job_total = EXCLUDED.stuck_at_job_total,
        stuck_at_job_details = EXCLUDED.stuck_at_job_details,
        slow_plants_total = EXCLUDED.slow_plants_total,
        slow_plants_details = EXCLUDED.slow_plants_details,
        congested_sites_total = EXCLUDED.congested_sites_total,
        congested_sites_details = EXCLUDED.congested_sites_details,
        avg_round_trip_minutes = EXCLUDED.avg_round_trip_minutes,
        avg_round_trip_display = EXCLUDED.avg_round_trip_display,
        prev_day_avg_round_trip_minutes = EXCLUDED.prev_day_avg_round_trip_minutes,
        round_trip_change_percent = EXCLUDED.round_trip_change_percent,
        round_trip_sample_count = EXCLUDED.round_trip_sample_count,
        weather_risk_total = EXCLUDED.weather_risk_total,
        weather_risk_severe = EXCLUDED.weather_risk_severe,
        weather_risk_very_high = EXCLUDED.weather_risk_very_high,
        weather_risk_high = EXCLUDED.weather_risk_high,
        weather_risk_moderate = EXCLUDED.weather_risk_moderate,
        weather_risk_details = EXCLUDED.weather_risk_details,
        status_pre_pour = EXCLUDED.status_pre_pour,
        status_in_process = EXCLUDED.status_in_process,
        status_completed = EXCLUDED.status_completed,
        status_canceled = EXCLUDED.status_canceled,
        top_products = EXCLUDED.top_products,
        computed_at = NOW()
    `, [
      date,
      lateTotal, lateNotStarted, lateSlowProgress, latePastFinish,
      JSON.stringify(lateDetailsResult.data || []),
      stuckDetails.length, JSON.stringify(stuckDetails),
      (slowPlantsResult.data || []).length, JSON.stringify(slowPlantsResult.data || []),
      (congestedResult.data || []).length, JSON.stringify(congestedResult.data || []),
      avgRt, avgRtDisplay,
      prevAvgRt, rtChangePercent, rtSample,
      weatherRiskTotal, weatherRiskSevere, weatherRiskVeryHigh, weatherRiskHigh, weatherRiskModerate,
      JSON.stringify(weatherDetails),
      parseInt(statusRow.status_pre_pour) || 0,
      parseInt(statusRow.status_in_process) || 0,
      parseInt(statusRow.status_completed) || 0,
      parseInt(statusRow.status_canceled) || 0,
      JSON.stringify(topProducts),
    ]);

    console.log(`[DailyIntelligence] Computed for ${date}: orders=${parseInt(statusRow.status_pre_pour || 0) + parseInt(statusRow.status_in_process || 0) + parseInt(statusRow.status_completed || 0) + parseInt(statusRow.status_canceled || 0)}, late=${lateTotal}, stuck=${stuckDetails.length}, rt=${avgRt || 'n/a'}min`);
    return true;
  } catch (error) {
    console.error('[DailyIntelligence] Compute error:', error.message);
    return false;
  }
}

/**
 * Start the periodic compute loop.
 */
function startDailyIntelligenceWorker() {
  console.log(`[DailyIntelligence] Worker started (interval=${COMPUTE_INTERVAL_MS / 1000}s)`);
  // Run immediately on start
  computeDailyIntelligence().catch(() => {});
  // Then every 5 minutes
  setInterval(() => computeDailyIntelligence().catch(() => {}), COMPUTE_INTERVAL_MS);
}

module.exports = { computeDailyIntelligence, startDailyIntelligenceWorker };

// Standalone mode
if (require.main === module) {
  computeDailyIntelligence(process.argv[2])
    .then(ok => process.exit(ok ? 0 : 1))
    .catch(() => process.exit(1));
}
