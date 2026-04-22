import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { UIMessage } from "ai";
import { useAgent } from "agents/react";
import { startTransition, useEffect, useEffectEvent, useId, useRef, useState } from "react";

import replayFixture from "../../fixtures/trace8-replay.json";
import { ReproChatPanel, type ReproChatController } from "../repro-chat-panel";
import {
  DEFAULT_PROMPT,
  DEFAULT_REPLAY_SPEED_MULTIPLIER,
  REPLAY_AGENT_RUNTIME_NAME,
  REPLAY_SPEED_OPTIONS,
  type ReplayFixtureSummary,
} from "../../shared/repro";

function formatDuration(durationMs: number) {
  return `${(durationMs / 1000).toFixed(3)}s`;
}

function getSubmittedMessageText(message: Pick<UIMessage, "parts">) {
  for (const part of message.parts) {
    if (part.type === "text" && part.text.trim().length > 0) {
      return part.text.trim();
    }
  }

  return DEFAULT_PROMPT;
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
  const [speedMultiplier, setSpeedMultiplier] = useState(DEFAULT_REPLAY_SPEED_MULTIPLIER);
  const [lastPrompt, setLastPrompt] = useState(DEFAULT_PROMPT);
  const [lastAction, setLastAction] = useState("idle");
  const [lastActionError, setLastActionError] = useState<string | null>(null);
  const autoStartedSessionRef = useRef<string | null>(null);
  const sessionName = `repro-${sessionPrefix}-${sessionGeneration}`;
  const agent = useAgent({
    agent: REPLAY_AGENT_RUNTIME_NAME,
    name: sessionName,
  });
  const chat = useAgentChat({
    agent,
    body: () => ({ speedMultiplier }),
    getInitialMessages: null,
  });

  const chatController: ReproChatController = {
    ...chat,
    sendMessage: async (message) => {
      const submittedPrompt = getSubmittedMessageText(message);

      setLastPrompt(submittedPrompt);
      return chat.sendMessage(message);
    },
  };

  const runReplay = useEffectEvent(async (prompt = lastPrompt) => {
    setLastPrompt(prompt);
    setLastAction("sending");
    setLastActionError(null);

    try {
      await chat.sendMessage({
        parts: [{ text: prompt, type: "text" }],
        role: "user",
      });
      setLastAction("sent");
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      setLastAction("send-failed");
      setLastActionError(errorMessage);
      console.error("Repro sendMessage failed", error);
    }
  });

  useEffect(() => {
    if (!agent.identified || autoStartedSessionRef.current === sessionName) {
      return;
    }

    autoStartedSessionRef.current = sessionName;
    setLastAction("auto-started");
    void runReplay();
  }, [agent.identified, runReplay, sessionName]);

  useEffect(() => {
    autoStartedSessionRef.current = null;
    setLastAction("idle");
    setLastActionError(null);
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
          This route mounts a real Cloudflare <code>AIChatAgent</code> and replays a captured
          production chunk sequence through <code>useAgentChat</code>. The expected failure is the
          same React error seen in production:
        </p>
        <pre className="callout">
          Maximum update depth exceeded. This can happen when a component repeatedly calls
          setState inside componentWillUpdate or componentDidUpdate.
        </pre>

        <dl className="stats">
          <div>
            <dt>Captured request</dt>
            <dd>{fixtureSummary.captureRequestId}</dd>
          </div>
          <div>
            <dt>Tool calls</dt>
            <dd>{fixtureSummary.toolCount}</dd>
          </div>
          <div>
            <dt>`tool-input-delta` chunks</dt>
            <dd>{fixtureSummary.inputDeltaCount}</dd>
          </div>
          <div>
            <dt>Replay duration</dt>
            <dd>{formatDuration(fixtureSummary.durationMs)}</dd>
          </div>
        </dl>

        <div className="controls">
          <label>
            <span>Replay speed</span>
            <select
              onChange={(event) => {
                setSpeedMultiplier(Number(event.currentTarget.value));
              }}
              value={String(speedMultiplier)}
            >
              {REPLAY_SPEED_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <button
            onClick={() => {
              startTransition(() => {
                void runReplay();
              });
            }}
            type="button"
          >
            Run replay
          </button>

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
            <strong>Agent</strong>: {REPLAY_AGENT_RUNTIME_NAME}
          </div>
          <div>
            <strong>Connected</strong>: {String(agent.identified)}
          </div>
          <div>
            <strong>Session</strong>: {sessionName}
          </div>
          <div>
            <strong>HTTP URL</strong>: {agent.getHttpUrl()}
          </div>
          <div>
            <strong>Prompt</strong>: {lastPrompt}
          </div>
          <div>
            <strong>Last action</strong>: {lastAction}
          </div>
          <div>
            <strong>Last action error</strong>: {lastActionError ?? "none"}
          </div>
          <div>
            <strong>Messages</strong>: {chat.messages.length}
          </div>
        </div>

        <ReproChatPanel
          chat={chatController}
          emptyState="Send the captured trace8 replay through the same chat surface the production coach sheet uses."
          placeholder="Ask anything. The replay agent ignores prompt text and always streams trace8."
        />
      </section>
    </main>
  );
}
