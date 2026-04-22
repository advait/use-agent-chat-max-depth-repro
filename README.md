# `useAgentChat` Maximum Update Depth Repro

Minimal Cloudflare Workers + Agents + React Router reproduction for:

```text
Maximum update depth exceeded. This can happen when a component repeatedly calls setState inside componentWillUpdate or componentDidUpdate.
```

## Purpose

This repo exists to demonstrate a bug in the Cloudflare chat client stack with the smallest honest surface I could get to while still preserving the real failure mode.

What is real here:

- real `AIChatAgent`
- real `useAgentChat`
- real streamed `cf_agent_use_chat_response` semantics
- replay data derived from a captured production failure

What is reduced:

- the original production tool outputs were replaced with tiny placeholders
- adjacent `tool-input-delta` chunks were merged during reduction to find the failure floor
- the UI is stripped down to one page that only renders status, a small amount of metadata, and the current tool states

This is not a hand-authored fake message list. The agent still streams SSE chunks through the normal `AIChatAgent` / `useAgentChat` path.

## Run

```bash
pnpm install
pnpm cf-typegen
pnpm dev --host 127.0.0.1 --port 43110
```

Open `http://127.0.0.1:43110/`.

The page auto-sends one prompt into a fresh agent session and replays the captured multi-tool stream at `8x` speed.

## Expected result

The page should:

1. connect to `TraceReplayAgent`
2. auto-send one user message
3. stream the replayed tool calls
4. end with `status: error`
5. render the React error text

```text
Maximum update depth exceeded. This can happen when a component repeatedly calls setState inside componentWillUpdate or componentDidUpdate.
```

The console stack points into the Cloudflare chat client path:

```text
ReactChatState.replaceMessage -> callbacks -> forceStoreRerender
```

## Current minimum failing shape

The current minimum known failing shape in this repo is:

- `5` `query_history` tool calls
- `57` total `tool-input-delta` chunks
- `5` `tool-input-start`
- `5` `tool-input-available`
- `5` `tool-output-available`
- replayed at `8x` speed

Important nearby non-failing points:

- `54` deltas: does **not** reproduce
- `56` deltas: does **not** reproduce
- `57` deltas: **does** reproduce

The threshold is also render-sensitive:

- rendering the flattened tool pills is enough to reproduce
- replacing that with a single derived summary string is not enough
- even a tiny extra read of `chat.messages.length` changes the failure threshold

That strongly suggests the bug is not just “too many deltas”. It is “a synchronous store-update burst plus enough concurrent React render work”.

## Current reduction state

What has been removed already:

- app-specific workout/coach logic
- route complexity beyond a single page
- large captured tool output payloads
- per-message text rendering
- local scroll state / sheet behavior from the production app
- nonessential controls and status chrome

What still remains because removing it stopped the repro:

- rendering each tool entry as its own DOM node
- a second `chat.messages`-derived read (`messageCount`) in render

Those last two points are useful signal, not fluff. They show that the failure threshold moves with render work even though the thrown stack stays inside the Cloudflare client.

## Cause

The best current explanation is:

1. the replay emits a dense burst of `tool-input-delta` chunks
2. `@cloudflare/ai-chat` handles each chunk by calling `ReactChatState.replaceMessage()`
3. `replaceMessage()` deep-clones the message and synchronously notifies every message subscriber
4. `useAgentChat()` exposes that store through `useSyncExternalStore`
5. when React is still reconciling the previous snapshot and another synchronous store publish lands, React eventually trips its nested update guard

Why I think this is the real root cause:

- the thrown stack is consistently inside `ReactChatState.replaceMessage -> callbacks -> forceStoreRerender`
- the repro survives after removing all application-specific logic
- the repro threshold moves when delta density changes
- the repro threshold also moves when render work changes, even though the application itself never calls `setState` in a loop

That combination fits a store-publish problem much better than an app-state bug.

## Proposed fix

The fix should happen in the Cloudflare chat client layer rather than in application code.

The most promising options are:

1. Batch `tool-input-delta` updates before publishing to React subscribers.
   One publish per microtask or animation frame is likely enough.

2. Do not treat every `tool-input-delta` as a full message replacement boundary.
   Keep ingesting the raw stream, but avoid `replaceMessage()` fanout for every partial tool-argument token.

3. Defer subscriber notification out of the synchronous `replaceMessage()` path.
   Even if the store wants every delta, React subscribers should not be forced synchronously for each one.

4. Optionally expose a client mode that suppresses intermediate tool-input streaming.
   Many UIs only need:
   - `tool-input-start`
   - `tool-input-available`
   - `tool-output-available`

The rough fix I would try first in `@cloudflare/ai-chat` is:

- coalesce consecutive `tool-input-delta` updates for the same message/tool call
- publish the merged snapshot once per tick instead of once per delta

## Why React Router Is Still Here

React Router is not the suspected bug surface.

It remains because it is the simplest same-origin way in this repo to serve:

- the single-page client
- the Worker entry
- the `/agents/...` endpoints used by `useAgentChat`

I attempted removing React Router entirely. That changed the dev/runtime shape enough that it was no longer a reliable reduction. I kept the smaller honest repro instead of a “cleaner” but non-reproducing one.

## Relevant files

- `app/routes/home.tsx`
- `fixtures/trace8-replay.json`
- `workers/replay-agent.ts`
- `workers/app.ts`
