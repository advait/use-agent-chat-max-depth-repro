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
The page defaults to `4x` replay speed because the failure is burst-sensitive; `1x` may complete successfully.

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

## Why this is minimal

- one route
- one worker entry
- one `AIChatAgent`
- one replay fixture
- no application-specific database or tool code
- a stripped-down coach-sheet-style panel because the transport alone was not sufficient to trigger the bug

## Relevant files

- `workers/replay-agent.ts`
- `fixtures/trace8-replay.json`
- `app/routes/home.tsx`
- `workers/app.ts`
