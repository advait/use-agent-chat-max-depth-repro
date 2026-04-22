import { AIChatAgent } from "@cloudflare/ai-chat";

import replayFixture from "../fixtures/trace8-replay.json";

function parseSpeedMultiplier(body: Record<string, unknown> | undefined) {
  const speedMultiplier = body?.speedMultiplier;

  return typeof speedMultiplier === "number" && speedMultiplier > 0 ? speedMultiplier : 1;
}

function waitForDelay(delayMs: number, abortSignal: AbortSignal | undefined) {
  if (delayMs <= 0 || abortSignal?.aborted) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
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

function createReplayResponse(
  replayEvents: typeof replayFixture.events,
  abortSignal: AbortSignal | undefined,
) {
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream({
      async start(controller) {
        try {
          for (const replayEvent of replayEvents) {
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

type ReplayAgentOnFinish = Parameters<AIChatAgent<Env>["onChatMessage"]>[0];
type ReplayAgentOptions = Parameters<AIChatAgent<Env>["onChatMessage"]>[1];

export class TraceReplayAgent extends AIChatAgent<Env> {
  override async onChatMessage(_onFinish: ReplayAgentOnFinish, options?: ReplayAgentOptions) {
    const speedMultiplier = parseSpeedMultiplier(options?.body);
    const replayEvents = replayFixture.events.map((event) => ({
      ...event,
      delayMs: Math.max(0, Math.round(event.delayMs / speedMultiplier)),
    }));

    return createReplayResponse(replayEvents, options?.abortSignal);
  }
}
