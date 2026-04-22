import { useAgentChat } from "@cloudflare/ai-chat/react";
import { useAgent } from "agents/react";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";

import replayFixture from "../../fixtures/trace8-replay.json";
import { ReproChatPanel } from "../repro-chat-panel";
import {
  DEFAULT_PROMPT,
  DEFAULT_REPLAY_SPEED_MULTIPLIER,
  REPLAY_AGENT_RUNTIME_NAME,
  type ReplayFixtureSummary,
} from "../../shared/repro";

function formatDuration(durationMs: number) {
  return `${(durationMs / 1000).toFixed(3)}s`;
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
  const sessionPrefix = useId().replaceAll(":", "-");
  const [sessionGeneration, setSessionGeneration] = useState(0);
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

        <ReproChatPanel chat={chat} />
      </section>
    </main>
  );
}
