import { getToolPartState, useAgentChat } from "@cloudflare/ai-chat/react";
import { getToolName, isToolUIPart } from "ai";
import { useAgent } from "agents/react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import replayFixture from "../../fixtures/trace8-replay.json";

const REPLAY_AGENT_RUNTIME_NAME = "TraceReplayAgent";
const DEFAULT_PROMPT = "Trigger the captured multi-tool trace replay.";
const DEFAULT_REPLAY_SPEED_MULTIPLIER = 8;

interface ReplayFixtureSummary {
  readonly captureRequestId: string;
  readonly inputDeltaCount: number;
  readonly toolCount: number;
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
  const sessionPrefixRef = useRef(crypto.randomUUID());
  const autoStartedSessionRef = useRef<string | null>(null);
  const sessionName = `repro-${sessionPrefixRef.current}-${sessionGeneration}`;
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
    if (!chat.error) {
      return;
    }

    console.error("Repro chat error", chat.error);
  }, [chat.error]);

  const chatErrorMessage = getChatErrorMessage(chat.error);
  const messageCount = chat.messages.length;
  const toolParts = chat.messages.flatMap((message) =>
    message.parts.filter(isToolUIPart).map((part) => ({
      key: `${message.id}:${part.toolCallId}`,
      name: getToolName(part),
      state: getToolPartState(part),
    })),
  );

  return (
    <main className="page">
      <section className="panel">
        <h1>`useAgentChat` Max Depth Repro</h1>
        <p>
          This page auto-replays a captured production multi-tool stream through a real{" "}
          <code>AIChatAgent</code> and <code>useAgentChat</code> client at{" "}
          <strong>{DEFAULT_REPLAY_SPEED_MULTIPLIER}x</strong> speed.
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
            <strong>Messages</strong>: {messageCount}
          </div>
        </div>

        {chat.error ? (
          <div className="error">
            <strong>Observed error</strong>
            <p>{chatErrorMessage}</p>
          </div>
        ) : null}

        {toolParts.length > 0 ? (
          <div className="messages">
            {toolParts.map((toolPart) => (
              <div className="tool-pill" key={toolPart.key}>
                <strong>{toolPart.name}</strong>
                <span>{toolPart.state}</span>
              </div>
            ))}
          </div>
        ) : null}
      </section>
    </main>
  );
}
