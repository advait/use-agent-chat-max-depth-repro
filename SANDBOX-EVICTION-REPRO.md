# Sandbox bash tool call hang — Durable Object eviction repro

This branch (`claude/sandbox-timeout-eviction-repro-KqXr2`) reproduces the
failure where an Agent DO that fires a long-running sandbox bash command
(via `@cloudflare/think` + `@cloudflare/sandbox`) ends up with the tool
call frozen in a **no-error, no-success** state once the run length
crosses the platform's idle-eviction threshold for Durable Objects.

## Failure shape

1. Agent DO begins awaiting a long-running async operation. In real
   code this is `await getSandbox(env.SANDBOX, id).exec("…")` from
   inside a Think tool `execute()` callback, kicked off either by
   `streamText`'s tool loop or by user-initiated background work.
2. The fetch handler / WebSocket message handler that triggered the
   work has already returned, so the platform sees no inflight request
   on the **Agent** DO side. (The Sandbox DO is fine — it keeps itself
   alive via the `Container` parent's `inflightRequests` + `sleepAfter`
   logic; see `packages/sandbox/src/sandbox.ts` lines around 717-762
   in `cloudflare/sandbox-sdk`.)
3. With no WebSocket client connected and no incoming HTTP, the
   Agent DO becomes idle. The Agent SDK documents this at
   `packages/agents/src/index.ts` around the `keepAlive()` method:
   > Use this when you have long-running work and need to prevent the
   > DO from going idle (eviction after ~70-140s of inactivity).
4. When the DO is evicted, the in-memory `setTimeout` callback / pending
   RPC promise is **not** rejected — the JS isolate is torn down. The
   awaiting code never resumes. The persisted SQLite row stays in
   `status='started'`. The client (if it ever reconnects) sees the tool
   call as still running, forever.

This is the user-observed "tool call reached a hung state".

## What this repro adds

- `workers/sweep-agent.js`
  - `SandboxTimeoutSweepAgent` extends `Agent` from `agents`.
  - Schedules a mock bash call via `setTimeout(resolve, timeoutMs)` and
    returns the HTTP response immediately, mirroring the
    "WS disconnected mid-tool-call" topology.
  - Persists every run to SQLite (`sweep_runs`) so "started but never
    completed" rows survive DO eviction and become directly observable.
  - Logs structured JSON events (`ctor`, `run.start`, `task.enter`,
    `task.complete`, `task.error`) with an `instanceId` UUID and a
    `constructorCount` — both jump when the platform re-instantiates the
    DO, which is the smoking gun for eviction.
  - Supports `?keepAlive=true`, which wraps the same work in
    `keepAliveWhile()`. Same timeouts complete reliably — proof that the
    hang is specifically platform DO eviction, not a logic bug.
- `scripts/sweep.mjs`
  - Sweeps `[10s, 30s, 60s, 90s, 120s, 180s, 240s, 300s]` by default.
  - For each timeout, starts a run, then *deliberately makes no further
    requests to the DO* until `timeoutMs + PAD_MS` has elapsed. Polling
    during the wait would mask the bug by resetting the idle timer.
  - After the wait, polls `/status` once and classifies the run as
    `OK` / `ERROR` / `HUNG_NO_ERROR`.
  - Prints a summary table at the end and exits non-zero if any run
    hung.
- Updated `workers/app.js` and `wrangler.jsonc` to register the new
  Durable Object class and migration.

## Mock vs. real sandbox

The mock is `await new Promise(resolve => setTimeout(resolve, timeoutMs))`
inside the Agent DO. It is structurally identical to `await sandbox.exec(...)`
*from the caller's perspective*: a long-lived awaitable owned by the
Agent DO's isolate. The bug we're reproducing is in the **caller**
(Agent DO awaiting an async result), not in the sandbox container —
so the mock is faithful.

To swap in the real sandbox SDK, replace `mockRunBash(timeoutMs)` in
`workers/sweep-agent.js` with:

```js
import { getSandbox } from "@cloudflare/sandbox";

mockRunBash(timeoutMs) {
  const sandbox = getSandbox(this.env.SANDBOX, this.name);
  const seconds = Math.ceil(timeoutMs / 1000);
  return sandbox.exec(`sleep ${seconds}`);
}
```

…and add a `SANDBOX` Durable Object binding pointing at the
`Sandbox` class. The hang pattern is the same — and on the real
sandbox you'll also see the container survive (because `Sandbox`
extends `Container` and bumps `inflightRequests`), while the Agent DO
is gone, which is exactly the "neither error nor success" surface
the user reports.

## Reproduction steps

### 1. Deploy

```bash
pnpm install
pnpm exec wrangler deploy
```

You need the deployed Worker URL, e.g.
`https://use-agent-chat-max-depth-repro.<account>.workers.dev`.

`wrangler dev` will technically run this locally, but the local
miniflare DO simulator does not implement the production eviction
heuristic — you will not see the bug locally. The whole point is
that this is a Cloudflare-platform behavior; it has to run on the
real edge.

### 2. Watch logs in one terminal

```bash
pnpm exec wrangler tail --format pretty
```

### 3. Run the sweep in another terminal

```bash
BASE_URL=https://use-agent-chat-max-depth-repro.<account>.workers.dev \
  node scripts/sweep.mjs
```

For the proof-of-fix run (same workload, but with `keepAliveWhile`):

```bash
KEEP_ALIVE=true \
BASE_URL=https://use-agent-chat-max-depth-repro.<account>.workers.dev \
  node scripts/sweep.mjs
```

### 4. Read the output

In the **driver** terminal you'll get a summary table like:

```
timeout  keepAlive  verdict           status     actualDuration  startCtor  endCtor  curCtor  evictedMidRun
10s      false      OK                completed  10.0s           1          1        1        false
30s      false      OK                completed  30.0s           1          1        1        false
60s      false      OK                completed  60.0s           1          1        1        false
90s      false      HUNG_NO_ERROR     started    n/a             1          n/a      2        true
120s     false      HUNG_NO_ERROR     started    n/a             2          n/a      3        true
180s     false      HUNG_NO_ERROR     started    n/a             3          n/a      4        true
240s     false      HUNG_NO_ERROR     started    n/a             4          n/a      5        true
300s     false      HUNG_NO_ERROR     started    n/a             5          n/a      6        true
```

Exact threshold varies (the docs say 70-140s) but the qualitative
result — short timeouts complete, longer ones flip to `HUNG_NO_ERROR`
mid-sweep, and `currentConstructorCount` jumps after each hang — is
stable.

In the **wrangler tail** terminal you'll see the matching pattern:

```
{"event":"ctor","instanceId":"…a","constructorCount":1}
{"event":"run.start","runId":"r1","timeoutMs":10000, …}
{"event":"task.enter","runId":"r1", …}
{"event":"task.complete","runId":"r1","actualDurationMs":10004, …}
{"event":"run.start","runId":"r2","timeoutMs":90000, …}
{"event":"task.enter","runId":"r2", …}
# … no task.complete for r2 …
{"event":"ctor","instanceId":"…b","constructorCount":2}   # ← eviction + re-instantiation
{"event":"run.start","runId":"r3","timeoutMs":120000, …}
```

The missing `task.complete` and the new `ctor` event with a fresh
`instanceId` are the structural proof: the DO was evicted while
awaiting the long-running operation, and the `setTimeout` callback
never fired.

## Why the keepAlive variant works

The Agent SDK's `keepAlive()` / `keepAliveWhile()` schedules alarm-based
heartbeats (`keepAliveIntervalMs`, default 30s, set to 5s in this repro
for snappier proof) that keep the DO active. With `?keepAlive=true`,
the same 5-minute task completes; the `keepAlive=true` sweep should
show all `verdict=OK`.

## Mitigations to apply in real Think / AIChatAgent code

- For sandbox tool `execute()` callbacks that may run longer than ~60s,
  wrap the body in `this.keepAliveWhile(...)` (or call `keepAlive()` at
  the top of `execute` and dispose at the end). Tool calls that run
  inside `streamText` while a WS client is connected are usually
  protected by the WS hibernation API, but the moment the client
  disconnects this protection disappears.
- For background sandbox work fired via `ctx.waitUntil`, always wrap
  in `keepAliveWhile`. `ctx.waitUntil` only extends the request
  handler's event-loop window — it does **not** prevent DO eviction.
- Consider `chatRecovery=true` on AIChatAgent so the chat turn runs as
  a `runFiber`, which is durable across evictions and resumed via
  `onFiberRecovered`. This is the structural fix when the work is too
  long for `keepAlive` to be reasonable.
