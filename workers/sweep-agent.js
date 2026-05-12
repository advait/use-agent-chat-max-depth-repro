import { Agent } from "agents";

/**
 * SandboxTimeoutSweepAgent
 *
 * Reproduces the "tool call hangs in non-error state" failure mode that
 * `@cloudflare/think` + `@cloudflare/sandbox` users hit when an Agent DO
 * fires a long-running bash command via the sandbox tool and then has no
 * inbound liveness signal (no WebSocket client, no incoming HTTP) while
 * the command is running.
 *
 * The shape of the bug:
 *
 *   1. Agent DO begins awaiting a long-running async operation (in real
 *      code: `await sandbox.exec("...")` over RPC; here: a setTimeout).
 *   2. The fetch handler that started the work returns immediately, so
 *      the platform sees no inflight request on the Agent DO side.
 *   3. With no WS connection and no incoming HTTP, the Agent DO becomes
 *      idle. Per `Agent.keepAlive()` docs in agents/src/index.ts, idle
 *      DOs are evicted after ~70-140s.
 *   4. When the DO is evicted, its in-memory `setTimeout` callback (or
 *      pending RPC promise) is *not* rejected — the JS isolate is just
 *      torn down. The persisted SQLite row stays in `status='started'`
 *      forever.
 *   5. From the client's perspective: the tool call neither succeeds
 *      nor errors. It's stuck.
 *
 * This file ships two ways to run the work so you can A/B the
 * difference:
 *
 *   - `?keepAlive=false` (default): no eviction protection. Long
 *      timeouts (>= ~90s) reliably hang.
 *   - `?keepAlive=true`: wraps the work in `keepAliveWhile()`, which
 *      uses the Agent SDK's alarm-heartbeat to prevent eviction. Same
 *      timeouts complete reliably.
 *
 * The bash call is mocked with `setTimeout` because the bug is in the
 * caller (Agent DO awaiting an async result), not in the sandbox
 * container. A real `Sandbox` DO from `@cloudflare/sandbox` keeps
 * *itself* alive via its `Container` parent's `inflightRequests` +
 * `sleepAfter` machinery (see sandbox.ts in sandbox-sdk), but that does
 * nothing for the *caller* Agent DO awaiting the RPC. To swap the mock
 * for a real sandbox call, replace `mockRunBash(timeoutMs)` with
 * `getSandbox(this.env.SANDBOX, this.name).exec(\`sleep ${timeoutMs/1000}\`)`.
 *
 * Routing (via routeAgentRequest):
 *   POST   /agents/sandbox-timeout-sweep-agent/:name/start?keepAlive=<bool>
 *   GET    /agents/sandbox-timeout-sweep-agent/:name/status?id=<runId>
 *   GET    /agents/sandbox-timeout-sweep-agent/:name/info
 *   POST   /agents/sandbox-timeout-sweep-agent/:name/reset
 */
export class SandboxTimeoutSweepAgent extends Agent {
  // Tighter heartbeat for the keepAlive variant — see Agent SDK options
  // in agents/src/index.ts ("keepAliveIntervalMs"). Default is 30s which
  // works fine; tightening to 5s makes the proof-of-fix snappier during
  // demos.
  static options = { keepAliveIntervalMs: 5_000 };

  // Bumped on every DO constructor invocation. Persisted across
  // hibernation so we can see how many times the platform re-instantiated
  // this DO during a single sweep.
  constructorCount = 0;

  // Process-instance UUID. Changes every time the JS isolate is
  // re-created — that's our smoking gun for eviction.
  instanceId = crypto.randomUUID();

  constructor(ctx, env) {
    super(ctx, env);

    // Block concurrency briefly so the constructor counter is consistent
    // before any fetch/onRequest call arrives.
    this.ctx.blockConcurrencyWhile(async () => {
      this.sql`
        CREATE TABLE IF NOT EXISTS sweep_runs (
          id TEXT PRIMARY KEY,
          timeout_ms INTEGER NOT NULL,
          keep_alive INTEGER NOT NULL,
          status TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          expected_complete_at INTEGER NOT NULL,
          completed_at INTEGER,
          actual_duration_ms INTEGER,
          start_instance_id TEXT NOT NULL,
          end_instance_id TEXT,
          start_constructor_count INTEGER NOT NULL,
          end_constructor_count INTEGER,
          error TEXT
        )
      `;

      this.sql`
        CREATE TABLE IF NOT EXISTS sweep_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `;

      const stored = this.sql`
        SELECT value FROM sweep_meta WHERE key = 'constructorCount'
      `;
      const prior = stored.length > 0 ? Number(stored[0].value) : 0;
      this.constructorCount = prior + 1;

      this.sql`
        INSERT INTO sweep_meta (key, value)
        VALUES ('constructorCount', ${String(this.constructorCount)})
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `;

      console.log(
        JSON.stringify({
          event: "ctor",
          instanceId: this.instanceId,
          constructorCount: this.constructorCount,
          wallClock: new Date().toISOString(),
        }),
      );
    });
  }

  async onRequest(request) {
    const url = new URL(request.url);
    const route = url.pathname.split("/").pop() ?? "";

    if (request.method === "POST" && route === "start") {
      return this.handleStart(request, url);
    }

    if (request.method === "GET" && route === "status") {
      return this.handleStatus(url);
    }

    if (request.method === "GET" && route === "info") {
      return this.handleInfo();
    }

    if (request.method === "POST" && route === "reset") {
      return this.handleReset();
    }

    return new Response("Not found", { status: 404 });
  }

  async handleStart(request, url) {
    let body = {};
    try {
      body = await request.json();
    } catch {
      // Allow empty body — timeout_ms can also come via query string.
    }

    const timeoutMs = Number(body.timeoutMs ?? url.searchParams.get("timeoutMs") ?? 30000);
    const keepAliveFlag =
      (body.keepAlive ?? url.searchParams.get("keepAlive")) === true ||
      (body.keepAlive ?? url.searchParams.get("keepAlive")) === "true";

    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Response.json({ error: "timeoutMs must be a positive number" }, { status: 400 });
    }

    const runId = crypto.randomUUID();
    const startedAt = Date.now();
    const expectedCompleteAt = startedAt + timeoutMs;

    this.sql`
      INSERT INTO sweep_runs (
        id, timeout_ms, keep_alive, status,
        started_at, expected_complete_at,
        start_instance_id, start_constructor_count
      ) VALUES (
        ${runId}, ${timeoutMs}, ${keepAliveFlag ? 1 : 0}, 'started',
        ${startedAt}, ${expectedCompleteAt},
        ${this.instanceId}, ${this.constructorCount}
      )
    `;

    console.log(
      JSON.stringify({
        event: "run.start",
        runId,
        timeoutMs,
        keepAlive: keepAliveFlag,
        startedAt: new Date(startedAt).toISOString(),
        expectedCompleteAt: new Date(expectedCompleteAt).toISOString(),
        instanceId: this.instanceId,
        constructorCount: this.constructorCount,
      }),
    );

    // Schedule the long-running work and return immediately. This is
    // structurally identical to firing `sandbox.exec(...)` from a tool
    // `execute()` after the fetch handler has already produced its
    // response, or from inside `streamText`'s tool loop after the WS
    // client has disconnected.
    //
    // `ctx.waitUntil` does NOT prevent DO eviction — it only extends
    // the lifetime of the current request handler by up to ~30s.
    this.ctx.waitUntil(
      keepAliveFlag
        ? this.keepAliveWhile(() => this.runTask(runId, timeoutMs))
        : this.runTask(runId, timeoutMs),
    );

    return Response.json({
      runId,
      timeoutMs,
      keepAlive: keepAliveFlag,
      startedAt,
      expectedCompleteAt,
      instanceId: this.instanceId,
      constructorCount: this.constructorCount,
    });
  }

  async runTask(runId, timeoutMs) {
    const enteredAt = Date.now();
    console.log(
      JSON.stringify({
        event: "task.enter",
        runId,
        timeoutMs,
        instanceId: this.instanceId,
        constructorCount: this.constructorCount,
        wallClock: new Date(enteredAt).toISOString(),
      }),
    );

    try {
      await this.mockRunBash(timeoutMs);

      const completedAt = Date.now();
      const actualDuration = completedAt - enteredAt;

      this.sql`
        UPDATE sweep_runs
           SET status = 'completed',
               completed_at = ${completedAt},
               actual_duration_ms = ${actualDuration},
               end_instance_id = ${this.instanceId},
               end_constructor_count = ${this.constructorCount}
         WHERE id = ${runId}
      `;

      console.log(
        JSON.stringify({
          event: "task.complete",
          runId,
          timeoutMs,
          actualDurationMs: actualDuration,
          instanceId: this.instanceId,
          constructorCount: this.constructorCount,
          wallClock: new Date(completedAt).toISOString(),
        }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sql`
        UPDATE sweep_runs
           SET status = 'errored',
               completed_at = ${Date.now()},
               error = ${message},
               end_instance_id = ${this.instanceId},
               end_constructor_count = ${this.constructorCount}
         WHERE id = ${runId}
      `;

      console.log(
        JSON.stringify({
          event: "task.error",
          runId,
          timeoutMs,
          error: message,
          instanceId: this.instanceId,
          constructorCount: this.constructorCount,
        }),
      );
    }
  }

  // Mock of a real bash invocation. Structurally a Promise that fulfils
  // after `timeoutMs`. Swap for `getSandbox(this.env.SANDBOX, this.name).exec(...)`
  // to exercise the same path against a real sandbox container.
  mockRunBash(timeoutMs) {
    return new Promise((resolve) => {
      setTimeout(resolve, timeoutMs);
    });
  }

  async handleStatus(url) {
    const id = url.searchParams.get("id");
    if (!id) {
      return Response.json({ error: "id query param required" }, { status: 400 });
    }

    const rows = this.sql`SELECT * FROM sweep_runs WHERE id = ${id}`;
    if (rows.length === 0) {
      return Response.json({ error: "run not found", id }, { status: 404 });
    }

    const row = rows[0];
    return Response.json({
      runId: row.id,
      timeoutMs: row.timeout_ms,
      keepAlive: row.keep_alive === 1,
      status: row.status,
      startedAt: row.started_at,
      expectedCompleteAt: row.expected_complete_at,
      completedAt: row.completed_at,
      actualDurationMs: row.actual_duration_ms,
      startInstanceId: row.start_instance_id,
      endInstanceId: row.end_instance_id,
      startConstructorCount: row.start_constructor_count,
      endConstructorCount: row.end_constructor_count,
      error: row.error,
      currentInstanceId: this.instanceId,
      currentConstructorCount: this.constructorCount,
      nowWallClock: Date.now(),
    });
  }

  async handleInfo() {
    const counts = this.sql`
      SELECT status, COUNT(*) AS n FROM sweep_runs GROUP BY status
    `;
    return Response.json({
      instanceId: this.instanceId,
      constructorCount: this.constructorCount,
      countsByStatus: Object.fromEntries(counts.map((r) => [r.status, Number(r.n)])),
      nowWallClock: Date.now(),
    });
  }

  async handleReset() {
    this.sql`DELETE FROM sweep_runs`;
    return Response.json({ ok: true });
  }
}
