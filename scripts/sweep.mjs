#!/usr/bin/env node
// Sweep driver for the SandboxTimeoutSweepAgent eviction repro.
//
// What this script does:
//   1. For each timeoutMs in DEFAULT_SWEEP (10s .. 5m), it POSTs to
//      /agents/sandbox-timeout-sweep-agent/<sessionName>/start to kick off
//      one mock-bash run.
//   2. It then *waits without talking to the DO* for timeoutMs + pad.
//      During this wait there is no WebSocket client and no inbound HTTP
//      traffic, so the Agent DO has no liveness signal. This is the
//      whole point — it mirrors a `useAgentChat` tab that has been
//      closed while a long bash tool call is in flight.
//   3. After the wait, it polls /status to see whether the run actually
//      completed or is stuck in 'started' (the frozen non-error state).
//   4. At the end it prints a summary table.
//
// Usage:
//   BASE_URL=https://your-worker.workers.dev node scripts/sweep.mjs
//
// Useful env vars:
//   BASE_URL       — Worker URL (defaults to http://127.0.0.1:43110)
//   SESSION        — agent name suffix for the run (default: random)
//   TIMEOUTS_MS    — comma-separated override of timeout sweep
//   PAD_MS         — extra wait after timeoutMs before polling (default 30000)
//   KEEP_ALIVE     — "true" to use the keepAlive variant (proof of fix)
//   POLL_INTERVAL  — ms between progress logs while waiting (default 15000)
//
// Recommended: run `wrangler tail` (or watch the Cloudflare dashboard
// logs) in a second terminal so you can correlate the run.start /
// task.complete events with the constructorCount jumps.

const BASE_URL = (process.env.BASE_URL ?? "http://127.0.0.1:43110").replace(/\/$/, "");
const SESSION = process.env.SESSION ?? `sweep-${Date.now().toString(36)}`;
const PAD_MS = Number(process.env.PAD_MS ?? 30_000);
const POLL_INTERVAL = Number(process.env.POLL_INTERVAL ?? 15_000);
const KEEP_ALIVE = process.env.KEEP_ALIVE === "true";

const DEFAULT_SWEEP_MS = [10_000, 30_000, 60_000, 90_000, 120_000, 180_000, 240_000, 300_000];

const TIMEOUTS_MS = process.env.TIMEOUTS_MS
  ? process.env.TIMEOUTS_MS.split(",").map((s) => Number(s.trim())).filter(Number.isFinite)
  : DEFAULT_SWEEP_MS;

const AGENT_BASE = `${BASE_URL}/agents/sandbox-timeout-sweep-agent/${encodeURIComponent(SESSION)}`;

const summary = [];

function ts() {
  return new Date().toISOString();
}

function fmtMs(ms) {
  if (ms == null) return "n/a";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

async function startRun(timeoutMs) {
  const url = new URL(`${AGENT_BASE}/start`);
  if (KEEP_ALIVE) url.searchParams.set("keepAlive", "true");
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ timeoutMs, keepAlive: KEEP_ALIVE }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`start failed: ${res.status} ${text}`);
  }
  return res.json();
}

async function getStatus(runId) {
  const url = new URL(`${AGENT_BASE}/status`);
  url.searchParams.set("id", runId);
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`status failed: ${res.status} ${text}`);
  }
  return res.json();
}

async function getInfo() {
  const res = await fetch(`${AGENT_BASE}/info`);
  if (!res.ok) {
    return { error: `info failed: ${res.status}` };
  }
  return res.json();
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runOne(timeoutMs) {
  console.log(`\n[${ts()}] === Starting iteration timeoutMs=${fmtMs(timeoutMs)} keepAlive=${KEEP_ALIVE} ===`);

  const started = await startRun(timeoutMs);
  console.log(
    `[${ts()}] started runId=${started.runId} expectedCompleteAt=${new Date(started.expectedCompleteAt).toISOString()} constructorCount=${started.constructorCount}`,
  );

  // Important: we deliberately do *not* poll during the wait. Polling
  // is itself an HTTP request to the DO, which would reset the
  // platform's idle-eviction timer and mask the bug. We only poll once,
  // at the very end, after `timeoutMs + PAD_MS` has elapsed.
  const waitTotalMs = timeoutMs + PAD_MS;
  const waitedTicks = Math.ceil(waitTotalMs / POLL_INTERVAL);

  for (let i = 0; i < waitedTicks; i++) {
    const remaining = Math.max(0, waitTotalMs - i * POLL_INTERVAL);
    const tickWait = Math.min(POLL_INTERVAL, remaining);
    if (tickWait <= 0) break;
    console.log(
      `[${ts()}] waiting ${fmtMs(remaining)} remaining (no requests sent to DO)…`,
    );
    await sleep(tickWait);
  }

  const status = await getStatus(started.runId);
  const observedAt = Date.now();
  const evicted = status.endConstructorCount != null && status.endConstructorCount > started.constructorCount;
  const sameInstance = status.startInstanceId === status.currentInstanceId;
  const restartedSinceStart = status.currentConstructorCount > started.constructorCount;

  console.log(`[${ts()}] status:`, JSON.stringify(status, null, 2));

  const verdict =
    status.status === "completed"
      ? "OK"
      : status.status === "errored"
        ? "ERROR"
        : "HUNG_NO_ERROR";

  summary.push({
    timeoutMs,
    keepAlive: KEEP_ALIVE,
    verdict,
    status: status.status,
    actualDurationMs: status.actualDurationMs,
    expectedDurationMs: timeoutMs,
    startConstructorCount: status.startConstructorCount,
    endConstructorCount: status.endConstructorCount,
    currentConstructorCount: status.currentConstructorCount,
    startInstanceId: status.startInstanceId,
    currentInstanceId: status.currentInstanceId,
    sameInstance,
    restartedSinceStart,
    evictedMidRun: evicted,
    observedAt,
  });
}

async function main() {
  console.log(`Sweep driver against ${BASE_URL}`);
  console.log(`Session: ${SESSION}`);
  console.log(`KeepAlive variant: ${KEEP_ALIVE}`);
  console.log(`Pad after each timeout: ${fmtMs(PAD_MS)}`);
  console.log(`Timeouts: ${TIMEOUTS_MS.map(fmtMs).join(", ")}`);

  const before = await getInfo();
  console.log(`Initial agent info:`, before);

  for (const t of TIMEOUTS_MS) {
    try {
      await runOne(t);
    } catch (err) {
      console.error(`[${ts()}] iteration timeoutMs=${t} threw:`, err);
      summary.push({
        timeoutMs: t,
        keepAlive: KEEP_ALIVE,
        verdict: "DRIVER_ERROR",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const after = await getInfo();
  console.log(`\nFinal agent info:`, after);

  console.log(`\n=== Sweep summary ===`);
  console.table(
    summary.map((row) => ({
      timeout: fmtMs(row.timeoutMs),
      keepAlive: row.keepAlive,
      verdict: row.verdict,
      status: row.status,
      actualDuration: fmtMs(row.actualDurationMs),
      startCtor: row.startConstructorCount,
      endCtor: row.endConstructorCount,
      curCtor: row.currentConstructorCount,
      evictedMidRun: row.evictedMidRun,
    })),
  );

  const hung = summary.filter((r) => r.verdict === "HUNG_NO_ERROR");
  if (hung.length > 0) {
    console.log(
      `\n${hung.length}/${summary.length} runs reached the frozen-no-error state. ` +
        `First hung timeout: ${fmtMs(hung[0].timeoutMs)}.`,
    );
    process.exit(1);
  } else {
    console.log(`\nAll ${summary.length} runs completed without hanging.`);
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("driver crashed:", err);
  process.exit(2);
});
