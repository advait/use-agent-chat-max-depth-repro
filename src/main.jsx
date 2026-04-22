import { useAgentChat } from "@cloudflare/ai-chat/react";
import { useAgent } from "agents/react";
import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";

import replayFixture from "../fixtures/trace8-replay.json";
import "./app.css";

const REPLAY_AGENT_RUNTIME_NAME = "TraceReplayAgent";
const PROMPT_TEXT = "Replay the captured multi-tool trace.";

function isToolPart(part) {
  return (
    part != null &&
    typeof part === "object" &&
    "toolCallId" in part &&
    typeof part.toolCallId === "string" &&
    "state" in part &&
    typeof part.state === "string"
  );
}

function getToolName(part) {
  if (typeof part.toolName === "string" && part.toolName.length > 0) {
    return part.toolName;
  }

  if (typeof part.type === "string" && part.type.startsWith("tool-")) {
    return part.type.slice(5);
  }

  return "tool";
}

function getToolParts(messages) {
  const toolParts = [];

  for (const message of messages) {
    for (const part of message.parts) {
      if (!isToolPart(part)) {
        continue;
      }

      toolParts.push({
        key: `${message.id}:${part.toolCallId}`,
        name: getToolName(part),
        state: part.state,
      });
    }
  }

  return toolParts;
}

function getChatErrorMessage(error) {
  const message = error?.message?.trim();
  return message && message.length > 0
    ? message
    : "The chat request failed without an error message.";
}

function App() {
  const sessionIdRef = useRef(`repro-${crypto.randomUUID()}`);
  const startedRef = useRef(false);
  const agent = useAgent({
    agent: REPLAY_AGENT_RUNTIME_NAME,
    name: sessionIdRef.current,
  });
  const chat = useAgentChat({
    agent,
    getInitialMessages: null,
  });
  const messageCount = chat.messages.length;
  const toolParts = getToolParts(chat.messages);

  useEffect(() => {
    if (!agent.identified || startedRef.current) {
      return;
    }

    startedRef.current = true;
    void chat.sendMessage({
      parts: [{ text: PROMPT_TEXT, type: "text" }],
      role: "user",
    });
  }, [agent.identified, chat]);

  return (
    <main className="page">
      <h1>`useAgentChat` maximum update depth repro</h1>
      <p>Real `AIChatAgent`. Real `useAgentChat`. Replayed production chunk stream.</p>
      <button
        onClick={() => {
          window.location.reload();
        }}
        type="button"
      >
        Reload page
      </button>

      <ul className="facts">
        <li>Status: {chat.status}</li>
        <li>Capture: {replayFixture.summary.captureRequestId}</li>
        <li>Tools: {replayFixture.summary.toolCount}</li>
        <li>Deltas: {replayFixture.summary.inputDeltaCount}</li>
        <li>Messages: {messageCount}</li>
      </ul>

      {chat.error ? <pre className="error">{getChatErrorMessage(chat.error)}</pre> : null}

      {toolParts.length > 0 ? (
        <ul className="tools">
          {toolParts.map((toolPart) => (
            <li key={toolPart.key}>
              {toolPart.name}: {toolPart.state}
            </li>
          ))}
        </ul>
      ) : null}
    </main>
  );
}

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Missing root element");
}

createRoot(rootElement).render(<App />);
