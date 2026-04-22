# `useAgentChat` Maximum Update Depth Repro

Minimal Cloudflare Workers + Agents + React Router reproduction for:

```text
Maximum update depth exceeded. This can happen when a component repeatedly calls setState inside componentWillUpdate or componentDidUpdate.
```

This repo uses:

- a real `AIChatAgent`
- a real `useAgentChat` client
- a replay of a captured production multi-tool stream

The replay fixture is not hand-authored message state. It is a serialized production chunk sequence derived from a real failing run.

## Run

```bash
pnpm install
pnpm cf-typegen
pnpm dev
```

Open the local URL printed by Vite and wait for the page to auto-run the replay.
The page defaults to `8x` replay speed because the failure is burst-sensitive in this stripped-down repro.

## Expected result

The page should:

1. connect to the `TraceReplayAgent`
2. auto-send one prompt into a fresh session
3. replay the captured multi-tool stream
4. end with `status: error`
5. render the React error text:

```text
Maximum update depth exceeded. This can happen when a component repeatedly calls setState inside componentWillUpdate or componentDidUpdate.
```

## Current reduced failure shape

This repo is no longer replaying the full captured trace.

The current minimum known failing shape in this stripped-down app is:

- `6` `query_history` tool calls
- `72` total `tool-input-delta` chunks
- replayed at `8x` speed

During the reduction pass:

- `5` tool calls did **not** reproduce in this stripped-down app
- `48` total `tool-input-delta` chunks did **not** reproduce
- `72` total `tool-input-delta` chunks did reproduce on repeated fresh loads

## Why this is minimal

- one route
- one worker entry
- one `AIChatAgent`
- one reduced replay fixture derived from the captured production stream
- no application-specific database or tool code
- a stripped-down chat panel that only keeps the stateful scroll behavior needed to trigger the bug

## Why React Router Is Still Here

React Router is not part of the suspected bug surface.

It remains only because it is the simplest way in this repo to serve:

- the single-page React client
- the Worker entry
- the same-origin `/agents/...` endpoints used by `useAgentChat`

The current reduction work suggests the bug lives in the `AIChatAgent` / `useAgentChat` stream application path plus the minimal local scroll state, not in route handling.

## Relevant files

- `workers/replay-agent.ts`
- `fixtures/trace8-replay.json`
- `app/routes/home.tsx`
- `workers/app.ts`
