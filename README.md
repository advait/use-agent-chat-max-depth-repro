# `useAgentChat` Maximum Update Depth Reproduction

This repository reproduces:

```text
Maximum update depth exceeded. This can happen when a component repeatedly calls setState inside componentWillUpdate or componentDidUpdate.
```

## What This Reproduces

This is a minimal Cloudflare-oriented repro for a streamed multi-tool chat failure in the `useAgentChat` stack.

The reproduction uses:

- a real `AIChatAgent`
- a real `useAgentChat` client
- the normal `cf_agent_use_chat_response` streaming path
- a replay derived from a real production chunk sequence

The agent is not returning a hand-written final message list. It streams replayed chunks through the normal transport path so the failure happens in the same client-side stream application code that production uses.

## Versions

Core package versions in this repo:

- `@cloudflare/ai-chat@0.4.4`
- `agents@0.11.0`
- `ai@6.0.162`
- `react@19.2.4`
- `react-dom@19.2.4`

## Repro Steps

```bash
pnpm install
pnpm dev
```

Then open:

```text
http://127.0.0.1:43110/
```

The page automatically:

1. connects to `TraceReplayAgent`
2. sends one user message
3. replays a captured multi-tool stream at fixed `8x` speed

## Expected Result

The page should end in an error state and render:

```text
Maximum update depth exceeded. This can happen when a component repeatedly calls setState inside componentWillUpdate or componentDidUpdate.
```

In my verification runs, the page also shows the assistant tool list partially applied when the error occurs, which is consistent with the stream failing mid-update rather than after completion.

## Default Replay Shape

The checked-in replay uses the full captured failure shape because it reproduces reliably:

- `6` `query_history` tool calls
- `91` `tool-input-delta` chunks
- `6` `tool-input-start`
- `6` `tool-input-available`
- `6` `tool-output-available`
- fixed `8x` replay speed

The replay metadata is in [`fixtures/trace8-replay.json`](./fixtures/trace8-replay.json).

## Why This Repo Exists

The point of this repo is to isolate the failure to the chat streaming stack with as little unrelated surface as possible:

- one page
- one agent
- one request
- one captured stream

That makes it easier to reason about whether the bug lives in application code, Cloudflare transport code, or the downstream AI SDK React store.

## Root Cause Hypothesis

The strongest current explanation is:

```text
streamed chunk burst -> per-chunk assistant message replacement -> synchronous external-store rerender storm
```

Pinned source references below use the exact published package commits:

- `@cloudflare/ai-chat@0.4.4`: [`2982b019736376b7fe3f7447839946618997a44f`](https://github.com/cloudflare/agents/tree/2982b019736376b7fe3f7447839946618997a44f)
- `@ai-sdk/react@3.0.170` / `ai@6.0.162`: [`c38119a2e3df201a95a9979580f2c7a3c1b319ab`](https://github.com/vercel/ai/tree/c38119a2e3df201a95a9979580f2c7a3c1b319ab)

The relevant path is:

1. `useAgentChat()` forwards the chat options into `useChat(...)` and installs `WebSocketChatTransport` as the transport layer:
   [`react.tsx#L366-L370`](https://github.com/cloudflare/agents/blob/2982b019736376b7fe3f7447839946618997a44f/packages/ai-chat/src/react.tsx#L366-L370),
   [`react.tsx#L820-L829`](https://github.com/cloudflare/agents/blob/2982b019736376b7fe3f7447839946618997a44f/packages/ai-chat/src/react.tsx#L820-L829)
2. Cloudflare transport parses each websocket body and immediately forwards each parsed chunk with `controller.enqueue(chunk)`:
   [`ws-chat-transport.ts#L241-L245`](https://github.com/cloudflare/agents/blob/2982b019736376b7fe3f7447839946618997a44f/packages/ai-chat/src/ws-chat-transport.ts#L241-L245),
   [`ws-chat-transport.ts#L526-L529`](https://github.com/cloudflare/agents/blob/2982b019736376b7fe3f7447839946618997a44f/packages/ai-chat/src/ws-chat-transport.ts#L526-L529),
   [`ws-chat-transport.ts#L607-L611`](https://github.com/cloudflare/agents/blob/2982b019736376b7fe3f7447839946618997a44f/packages/ai-chat/src/ws-chat-transport.ts#L607-L611)
3. In the AI SDK, every `tool-input-delta` chunk reparses partial JSON and calls `write()` immediately:
   [`process-ui-message-stream.ts#L564-L600`](https://github.com/vercel/ai/blob/c38119a2e3df201a95a9979580f2c7a3c1b319ab/packages/ai/src/ui/process-ui-message-stream.ts#L564-L600)
4. That write path updates the active assistant message through `replaceMessage(...)` on each streamed step:
   [`chat.ts#L687-L708`](https://github.com/vercel/ai/blob/c38119a2e3df201a95a9979580f2c7a3c1b319ab/packages/ai/src/ui/chat.ts#L687-L708)
5. `ReactChatState.replaceMessage(...)` deep-clones the message and synchronously notifies subscribers:
   [`chat.react.ts#L56-L97`](https://github.com/vercel/ai/blob/c38119a2e3df201a95a9979580f2c7a3c1b319ab/packages/react/src/chat.react.ts#L56-L97)
6. `useChat()` consumes that store through `useSyncExternalStore(...)`:
   [`use-chat.ts#L111-L135`](https://github.com/vercel/ai/blob/c38119a2e3df201a95a9979580f2c7a3c1b319ab/packages/react/src/use-chat.ts#L111-L135)

That path matches the observed stack shape:

```text
ReactChatState.replaceMessage -> callbacks -> forceStoreRerender
```

## Why I Think The Bug Is In This Layer

The evidence this repo isolates:

- The failure happens while streaming tool-call input deltas, not after the stream is complete.
- The error is triggered by a burst of `tool-input-delta` chunks.
- The observed stack points at chat-store update fanout, not application-local state.
- The reproduction still occurs with a very small app surface.

That makes this look less like an app bug and more like a transport/store interaction under high-frequency chunk delivery.

## Likely Fix Surface

The most promising fix is at the Cloudflare transport boundary:

- coalesce consecutive `tool-input-delta` chunks before calling `controller.enqueue(chunk)`

Why that seems like the best first fix:

- it preserves the websocket protocol
- it reduces update pressure before the chunks reach `useChat()`
- it targets the exact place where Cloudflare currently forwards every parsed chunk one-by-one

If Cloudflare wants to preserve fully granular chunk delivery, then the next best fix is in the AI SDK React store:

- batch `replaceMessage()` subscriber notifications
- or defer subscriber fanout out of the synchronous `replaceMessage()` path

## Existing Mitigation

There is already a mitigation path in the AI SDK:

- `useChat()` supports `experimental_throttle`:
  [`use-chat.ts#L42-L50`](https://github.com/vercel/ai/blob/c38119a2e3df201a95a9979580f2c7a3c1b319ab/packages/react/src/use-chat.ts#L42-L50)
- `useAgentChat()` inherits that option because it extends `UseChatParams` and forwards the remaining options into `useChat(...)`:
  [`react.tsx#L366-L370`](https://github.com/cloudflare/agents/blob/2982b019736376b7fe3f7447839946618997a44f/packages/ai-chat/src/react.tsx#L366-L370),
  [`react.tsx#L820-L829`](https://github.com/cloudflare/agents/blob/2982b019736376b7fe3f7447839946618997a44f/packages/ai-chat/src/react.tsx#L820-L829)

Example:

```tsx
useAgentChat({
  agent,
  experimental_throttle: 50,
})
```

That may reduce or hide the symptom, but it does not change the underlying one-chunk-at-a-time transport behavior.
