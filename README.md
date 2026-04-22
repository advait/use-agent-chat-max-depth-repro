# `useAgentChat` Maximum Update Depth Repro

Single-purpose reproduction for:

```text
Maximum update depth exceeded. This can happen when a component repeatedly calls setState inside componentWillUpdate or componentDidUpdate.
```

## Purpose

This repo demonstrates the bug with the smallest surface I could keep while still reproducing it consistently.

What is intentionally real here:

- a real `AIChatAgent`
- a real `useAgentChat` client
- the normal `cf_agent_use_chat_response` chunk path
- a replay derived from a real production failure

What is intentionally gone:

- React Router
- app-specific business logic
- TypeScript/tooling that is not required to trigger the bug

The repo is now a plain Vite React page plus a vanilla Cloudflare Worker entry.

## Direct Dependencies

Runtime:

- `@cloudflare/ai-chat`
- `agents`
- `ai`
- `react`
- `react-dom`

Dev-only:

- `vite`
- `@vitejs/plugin-react`
- `@cloudflare/vite-plugin`
- `wrangler`

## Run

```bash
pnpm install
pnpm dev
```

Open `http://127.0.0.1:43110/`.

The page auto-sends one prompt into a fresh agent session and replays the captured tool stream at a fixed `8x` speed.

## Expected Result

The page should:

1. connect to `TraceReplayAgent`
2. auto-send one message
3. stream the replayed tool calls
4. end in `Status: error`
5. render:

```text
Maximum update depth exceeded. This can happen when a component repeatedly calls setState inside componentWillUpdate or componentDidUpdate.
```

## Default Replay Shape

The default checked-in replay is the full captured `trace8` failure shape:

- `6` `query_history` tool calls
- `91` `tool-input-delta` chunks
- `6` `tool-input-start`
- `6` `tool-input-available`
- `6` `tool-output-available`
- replayed at fixed `8x` speed

I am using that fuller replay as the default because it reproduces reliably under repeated fresh-browser verification.

## Reduced Floor I Found

While stripping the repro down, the smallest reduced replay I saw fail in this plain-JS / no-router version was:

- `69` `tool-input-delta` chunks

Nearby non-failing point:

- `68` `tool-input-delta` chunks did **not** reproduce

The current renderer is also intentionally small:

- one `chat.messages.length` read
- one list of tool states
- one rendered error block

That matters because it shows the bug does **not** require React Router or a large application shell. It only needs enough synchronous render work on top of the streamed chat updates.

## Why This Is Not A React Router Bug

This repo does not use React Router anymore and it still reproduces.

So React Router can affect the render threshold in a larger app, but it is not the fundamental write loop that triggers this error.

## Root Cause

The most plausible root cause is a synchronous external-store publish storm across the Cloudflare transport boundary and the AI SDK React store.

Pinned source references below use the exact published package commits:

- `@cloudflare/ai-chat@0.4.4`: [`2982b019736376b7fe3f7447839946618997a44f`](https://github.com/cloudflare/agents/tree/2982b019736376b7fe3f7447839946618997a44f)
- `@ai-sdk/react@3.0.170` / `ai@6.0.162`: [`c38119a2e3df201a95a9979580f2c7a3c1b319ab`](https://github.com/vercel/ai/tree/c38119a2e3df201a95a9979580f2c7a3c1b319ab)

The critical path is:

1. `useAgentChat()` is a thin wrapper over `useChat()`, and it forwards the remaining chat options straight into `useChat(...)`: [`react.tsx#L366-L370`](https://github.com/cloudflare/agents/blob/2982b019736376b7fe3f7447839946618997a44f/packages/ai-chat/src/react.tsx#L366-L370), [`react.tsx#L820-L829`](https://github.com/cloudflare/agents/blob/2982b019736376b7fe3f7447839946618997a44f/packages/ai-chat/src/react.tsx#L820-L829).
2. Cloudflare's `WebSocketChatTransport` parses each websocket body as a `UIMessageChunk` and immediately forwards it with `controller.enqueue(chunk)`, with no batching at the transport boundary: [`ws-chat-transport.ts#L241-L245`](https://github.com/cloudflare/agents/blob/2982b019736376b7fe3f7447839946618997a44f/packages/ai-chat/src/ws-chat-transport.ts#L241-L245), [`ws-chat-transport.ts#L526-L529`](https://github.com/cloudflare/agents/blob/2982b019736376b7fe3f7447839946618997a44f/packages/ai-chat/src/ws-chat-transport.ts#L526-L529), [`ws-chat-transport.ts#L607-L611`](https://github.com/cloudflare/agents/blob/2982b019736376b7fe3f7447839946618997a44f/packages/ai-chat/src/ws-chat-transport.ts#L607-L611).
3. In the AI SDK, every `tool-input-delta` chunk reparses partial JSON and then calls `write()` immediately: [`process-ui-message-stream.ts#L564-L600`](https://github.com/vercel/ai/blob/c38119a2e3df201a95a9979580f2c7a3c1b319ab/packages/ai/src/ui/process-ui-message-stream.ts#L564-L600).
4. That write path updates the active assistant message through `replaceMessage(...)` on every streamed step: [`chat.ts#L687-L708`](https://github.com/vercel/ai/blob/c38119a2e3df201a95a9979580f2c7a3c1b319ab/packages/ai/src/ui/chat.ts#L687-L708).
5. `ReactChatState.replaceMessage(...)` deep-clones the full message and synchronously notifies all message subscribers: [`chat.react.ts#L56-L97`](https://github.com/vercel/ai/blob/c38119a2e3df201a95a9979580f2c7a3c1b319ab/packages/react/src/chat.react.ts#L56-L97).
6. `useChat()` consumes that state through `useSyncExternalStore(...)`: [`use-chat.ts#L111-L135`](https://github.com/vercel/ai/blob/c38119a2e3df201a95a9979580f2c7a3c1b319ab/packages/react/src/use-chat.ts#L111-L135).

That matches the production stack:

```text
ReactChatState.replaceMessage -> callbacks -> forceStoreRerender
```

So the failure is best described as:

```text
chunk burst -> per-chunk message replacement -> synchronous external-store rerender storm
```

## Rough Fix

The best first fix is in the Cloudflare transport layer, not in application code.

Most promising change:

- coalesce consecutive `tool-input-delta` chunks before calling `controller.enqueue(chunk)`

Why that fix is attractive:

- it preserves the real websocket protocol
- it reduces pressure before the chunks reach `useChat()`
- it targets the exact boundary where Cloudflare currently forwards each chunk one-by-one

If Cloudflare wants to preserve fully granular transport semantics, then the next best fix is in the AI SDK React store:

- batch `replaceMessage()` subscriber notifications
- or defer them out of the synchronous callback path

## Temporary Mitigation

This is not the root fix, but there is an existing mitigation path:

- `useChat()` already supports `experimental_throttle`: [`use-chat.ts#L42-L50`](https://github.com/vercel/ai/blob/c38119a2e3df201a95a9979580f2c7a3c1b319ab/packages/react/src/use-chat.ts#L42-L50)
- throttled subscriptions are wired through `~registerMessagesCallback(...)`: [`chat.react.ts#L68-L79`](https://github.com/vercel/ai/blob/c38119a2e3df201a95a9979580f2c7a3c1b319ab/packages/react/src/chat.react.ts#L68-L79)
- `useAgentChat()` inherits those options because it extends `UseChatParams` and forwards `...rest` into `useChat(...)`: [`react.tsx#L366-L370`](https://github.com/cloudflare/agents/blob/2982b019736376b7fe3f7447839946618997a44f/packages/ai-chat/src/react.tsx#L366-L370), [`react.tsx#L820-L829`](https://github.com/cloudflare/agents/blob/2982b019736376b7fe3f7447839946618997a44f/packages/ai-chat/src/react.tsx#L820-L829)

So an app can try:

```tsx
useAgentChat({
  agent,
  experimental_throttle: 50,
})
```

That can reduce the symptom, but it does not change the underlying fact that the transport and store still process the full burst one chunk at a time.
