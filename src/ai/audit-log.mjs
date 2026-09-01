/**
 * Audit log wrapper for AI Assistant tool calls. Every tool's `execute`
 * function is wrapped so a row gets inserted into `ai_audit_log` with the
 * tool name, sanitized input, output row count, latency, and any error.
 *
 * Per-request user/thread context is stitched in via AsyncLocalStorage from
 * the API route (see `setAuditContext`). Insertion is fire-and-forget — a
 * failing audit write must never break the user's chat turn.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import pool from "./_db.mjs";

const auditStorage = new AsyncLocalStorage();

export function runWithAuditContext(ctx, fn) {
  return auditStorage.run(ctx, fn);
}

function currentAuditContext() {
  return auditStorage.getStore() ?? {};
}

/**
 * Per-request AI context (userId, threadId, question, and customerScope for
 * contractor data-scoping). Read by query-executor.mjs to enforce row-level
 * scoping for contractor users. Returns {} outside a request.
 */
export function getAiRequestContext() {
  return auditStorage.getStore() ?? {};
}

function extractRowCount(result) {
  if (typeof result !== "object" || result === null) return null;
  const r = result;
  if (typeof r.totalRows === "number") return r.totalRows;
  if (Array.isArray(r.rows)) return r.rows.length;
  if (Array.isArray(r.widgets)) return r.widgets.length;
  return null;
}

/**
 * The AI SDK's `tool({ execute })` types execute as
 * `(input: unknown) => Promise<unknown>` and validates the input via the
 * zod schema at runtime. Our wrapper preserves that exact signature so
 * `tool({ execute: withAuditLog(...) })` always type-checks. The inner
 * function can declare a more specific input type for its own convenience.
 */
export function withAuditLog(
  toolName,
  fn,
) {
  const wrapped = async (input) => {
    const startedAt = Date.now();
    const ctx = currentAuditContext();
    let outputRowCount = null;
    let errorMessage = null;

    try {
      const result = await fn(input);
      outputRowCount = extractRowCount(result);
      return result;
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      const latencyMs = Date.now() - startedAt;
      void pool.query(
        `INSERT INTO ai_audit_log (user_id, thread_id, question, tool_name, tool_input, output_row_count, latency_ms, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          ctx.userId ?? null,
          ctx.threadId ?? null,
          ctx.question ?? null,
          toolName,
          JSON.stringify(input),
          outputRowCount,
          latencyMs,
          errorMessage,
        ],
      ).catch((err) => {
        console.warn(`[ai_audit_log] insert failed for ${toolName}:`, err.message);
      });
    }
  };
  return wrapped;
}
