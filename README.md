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

- `5` `query_history` tool calls
- `60` total `tool-input-delta` chunks
- replayed at `8x` speed

During the reduction pass:

- `5` tool calls with `55` total `tool-input-delta` chunks did **not** reproduce
- `5` tool calls with `60` total `tool-input-delta` chunks **did** reproduce
- the failure still reproduced after removing the local scroll-lock state machine, which points back to the chat client/store path rather than app-local React state

## Cause

The most likely root cause is a synchronous update storm inside the Cloudflare chat client stack, not in the application code.

Evidence from the reduction:

- the repro still fails with a static renderer that does not keep any local UI state besides the `useAgent` / `useAgentChat` hook state
- the failure depends on the density of streamed `tool-input-delta` updates rather than any specific business logic
- the stack observed in the original app pointed into the Cloudflare chat state path:
  `ReactChatState.replaceMessage -> callbacks -> forceStoreRerender`
- the reproduced failure surface is just:
  real `AIChatAgent` transport + real `useAgentChat` + a burst of streamed tool-input deltas

The working theory is:

1. the agent stream delivers many `tool-input-delta` chunks in a tight burst
2. `@cloudflare/ai-chat` applies each chunk by synchronously replacing the assistant message in the chat store
3. each replacement synchronously notifies React subscribers
4. under a dense enough burst, React hits its nested update guard and throws `Maximum update depth exceeded`

## Proposed Fix

The rough fix should happen in the Cloudflare chat client layer, not in application code.

Most promising options:

1. Coalesce `tool-input-delta` chunks before notifying React subscribers.
   For example, batch multiple deltas for the same assistant message into one store publish per microtask or animation frame.

2. Treat `tool-input-delta` as transient transport state rather than a full UI-store replacement boundary.
   In practice, many apps do not need every intermediate tool-input token to cause a full `replaceMessage()` fanout.

3. Defer subscriber notification from the synchronous `replaceMessage()` path.
   If the store must ingest every delta, the publish path should still avoid recursively forcing subscriber rerenders for each chunk.

4. Optionally suppress intermediate tool-input streaming for tool arguments on the client.
   A client could choose to surface only:
   - `tool-input-start`
   - `tool-input-available`
   - `tool-output-available`
   instead of every `tool-input-delta`

The highest-leverage change appears to be:

- keep ingesting the raw stream
- but batch or suppress intermediate `tool-input-delta` message-store updates before they hit React subscribers

## Why this is minimal

- one route
- one worker entry
- one `AIChatAgent`
- one reduced replay fixture derived from the captured production stream
- no application-specific database or tool code
- a stripped-down static renderer that only shows message text plus tool name/state

## Why React Router Is Still Here

React Router is not part of the suspected bug surface.

It remains only because it is the simplest way in this repo to serve:

- the single-page React client
- the Worker entry
- the same-origin `/agents/...` endpoints used by `useAgentChat`

The current reduction work suggests the bug lives in the `AIChatAgent` / `useAgentChat` stream application path, not in route handling.

## Relevant files

- `workers/replay-agent.ts`
- `fixtures/trace8-replay.json`
- `app/routes/home.tsx`
- `workers/app.ts`
