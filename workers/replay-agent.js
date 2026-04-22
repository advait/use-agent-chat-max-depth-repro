import { AIChatAgent } from "@cloudflare/ai-chat";

import replayFixture from "../fixtures/trace8-replay.json";

const REPLAY_SPEED_MULTIPLIER = 8;
const REPLAY_EVENTS = replayFixture.events.map((event) => ({
  ...event,
  delayMs: Math.max(0, Math.round(event.delayMs / REPLAY_SPEED_MULTIPLIER)),
}));

function waitForDelay(delayMs, abortSignal) {
  if (delayMs <= 0 || abortSignal?.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      abortSignal?.removeEventListener("abort", handleAbort);
      resolve();
    }, delayMs);

    const handleAbort = () => {
      clearTimeout(timeoutId);
      resolve();
    };

    abortSignal?.addEventListener("abort", handleAbort, { once: true });
  });
}

function createReplayResponse(abortSignal) {
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream({
      async start(controller) {
        try {
          for (const replayEvent of REPLAY_EVENTS) {
            if (abortSignal?.aborted) {
              break;
            }

            await waitForDelay(replayEvent.delayMs, abortSignal);

            if (abortSignal?.aborted) {
              break;
            }

            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(replayEvent.chunk)}\n\n`),
            );
          }
        } catch (error) {
          controller.error(error);
          return;
        }

        controller.close();
      },
    }),
    {
      headers: {
        "cache-control": "no-cache",
        "content-type": "text/event-stream; charset=utf-8",
      },
    },
  );
}

export class TraceReplayAgent extends AIChatAgent {
  async onChatMessage(_onFinish, options) {
    return createReplayResponse(options?.abortSignal);
  }
}
