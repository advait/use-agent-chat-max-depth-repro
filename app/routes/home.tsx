import { useAgentChat } from "@cloudflare/ai-chat/react";
import { getToolPartState } from "@cloudflare/ai-chat/react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { useAgent } from "agents/react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import replayFixture from "../../fixtures/trace8-replay.json";

const REPLAY_AGENT_RUNTIME_NAME = "TraceReplayAgent";
const DEFAULT_PROMPT = "Trigger the captured multi-tool trace replay.";
const DEFAULT_REPLAY_SPEED_MULTIPLIER = 8;

interface ReplayFixtureSummary {
  readonly captureRequestId: string;
  readonly durationMs: number;
  readonly inputAvailableCount: number;
  readonly inputDeltaCount: number;
  readonly outputAvailableCount: number;
  readonly toolCount: number;
}

function formatDuration(durationMs: number) {
  return `${(durationMs / 1000).toFixed(3)}s`;
}

function getTextPartText(part: UIMessage["parts"][number]) {
  if (part.type !== "text") {
    return null;
  }

  const text = part.text.trim();

  return text.length > 0 ? text : null;
}

function getChatErrorMessage(error: Error | undefined) {
  const message = error?.message?.trim();

  return message && message.length > 0 ? message : "The chat could not complete this request.";
}

export function meta() {
  return [
    { title: "useAgentChat Max Depth Repro" },
    {
      name: "description",
      content:
        "Minimal Cloudflare Agents + AI Chat reproduction for Maximum update depth exceeded with streamed multi-tool replay.",
    },
  ];
}

export default function Home() {
  const fixtureSummary = replayFixture.summary as ReplayFixtureSummary;
  const [sessionGeneration, setSessionGeneration] = useState(0);
  const [sessionPrefix] = useState(() => crypto.randomUUID());
  const autoStartedSessionRef = useRef<string | null>(null);
  const sessionName = `repro-${sessionPrefix}-${sessionGeneration}`;
  const agent = useAgent({
    agent: REPLAY_AGENT_RUNTIME_NAME,
    name: sessionName,
  });
  const chat = useAgentChat({
    agent,
    body: () => ({ speedMultiplier: DEFAULT_REPLAY_SPEED_MULTIPLIER }),
    getInitialMessages: null,
  });

  const runReplay = useEffectEvent(async () => {
    try {
      await chat.sendMessage({
        parts: [{ text: DEFAULT_PROMPT, type: "text" }],
        role: "user",
      });
    } catch (error) {
      console.error("Repro sendMessage failed", error);
    }
  });

  useEffect(() => {
    if (!agent.identified || autoStartedSessionRef.current === sessionName) {
      return;
    }

    autoStartedSessionRef.current = sessionName;
    void runReplay();
  }, [agent.identified, runReplay, sessionName]);

  useEffect(() => {
    autoStartedSessionRef.current = null;
  }, [sessionName]);

  useEffect(() => {
    if (!chat.error) {
      return;
    }

    console.error("Repro chat error", chat.error);
  }, [chat.error]);

  const chatErrorMessage = getChatErrorMessage(chat.error);

  return (
    <main className="page">
      <section className="panel">
        <h1>`useAgentChat` Max Depth Repro</h1>
        <p>
          This page auto-replays a captured production multi-tool stream through a real{" "}
          <code>AIChatAgent</code> and <code>useAgentChat</code> client at{" "}
          <strong>{DEFAULT_REPLAY_SPEED_MULTIPLIER}x</strong> speed. Expected result:
        </p>
        <pre className="callout">
          Maximum update depth exceeded. This can happen when a component repeatedly calls
          setState inside componentWillUpdate or componentDidUpdate.
        </pre>

        <div className="controls">
          <button
            onClick={() => {
              setSessionGeneration((currentValue) => currentValue + 1);
            }}
            type="button"
          >
            Fresh session
          </button>
        </div>

        <div className="meta">
          <div>
            <strong>Status</strong>: {chat.status}
          </div>
          <div>
            <strong>Capture</strong>: {fixtureSummary.captureRequestId}
          </div>
          <div>
            <strong>Tools</strong>: {fixtureSummary.toolCount}
          </div>
          <div>
            <strong>Deltas</strong>: {fixtureSummary.inputDeltaCount}
          </div>
          <div>
            <strong>Replay</strong>: {formatDuration(fixtureSummary.durationMs)} at{" "}
            {DEFAULT_REPLAY_SPEED_MULTIPLIER}x
          </div>
        </div>

        <section className="discussion-shell">
          <div className="discussion-scroll">
            <div className="messages">
              {chat.messages.map((message) => {
                const renderedParts = message.parts
                  .map((part, index) => {
                    const text = getTextPartText(part);

                    if (text) {
                      return (
                        <p className="message-text" key={`${message.id}:text:${index}`}>
                          {text}
                        </p>
                      );
                    }

                    if (isToolUIPart(part)) {
                      return (
                        <div className="tool-pill" key={`${message.id}:tool:${index}`}>
                          <strong>{getToolName(part)}</strong>
                          <span>{getToolPartState(part)}</span>
                        </div>
                      );
                    }

                    return null;
                  })
                  .filter((part) => part !== null);

                if (renderedParts.length === 0) {
                  return null;
                }

                return (
                  <article className="message" key={message.id}>
                    <header>
                      <strong>{message.role}</strong>
                      <span>{message.id}</span>
                    </header>
                    <div className="parts">{renderedParts}</div>
                  </article>
                );
              })}

              {chat.error ? (
                <div className="error">
                  <strong>Observed error</strong>
                  <p>{chatErrorMessage}</p>
                </div>
              ) : null}
            </div>
          </div>
        </section>
      </section>
    </main>
  );
}
