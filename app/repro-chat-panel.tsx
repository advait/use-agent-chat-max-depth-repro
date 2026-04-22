import {
  getToolApproval,
  getToolInput,
  getToolOutput,
  getToolPartState,
} from "@cloudflare/ai-chat/react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { startTransition, useEffect, useEffectEvent, useRef, useState } from "react";

import { LocalDateTime } from "./local-date-time";

type ReproMessagePart = UIMessage["parts"][number];
type ReproSendMessage = (message: Pick<UIMessage, "parts" | "role">) => Promise<unknown>;

export interface ReproChatController {
  addToolApprovalResponse: (args: { approved: boolean; id: string }) => void;
  clearError: () => void;
  clearHistory: () => void;
  error: Error | undefined;
  isServerStreaming: boolean;
  isStreaming: boolean;
  messages: readonly UIMessage[];
  sendMessage: ReproSendMessage;
  status: string;
  stop: () => void | Promise<unknown>;
}

function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getTextPartText(part: ReproMessagePart) {
  if (part.type !== "text") {
    return null;
  }

  const text = part.text;

  return text.trim().length > 0 ? text : null;
}

function getToolLabel(toolName: string) {
  switch (toolName) {
    case "create_workout":
      return "Create workout";
    case "patch_workout":
      return "Update workout";
    case "query_history":
      return "Query history";
    case "set_user_profile":
      return "Save profile";
    default:
      return toolName.replaceAll("_", " ");
  }
}

function getToolStatusLabel(state: ReturnType<typeof getToolPartState>, toolName: string) {
  switch (state) {
    case "complete":
      return "Done";
    case "approved":
      return "Approved";
    case "denied":
      return "Denied";
    case "error":
      return "Error";
    case "loading":
      return toolName === "patch_workout" ? "Queued" : "Pending";
    case "streaming":
      return toolName === "patch_workout" ? "Applying" : "Running";
    case "waiting-approval":
      return "Needs approval";
    default:
      return "Pending";
  }
}

function getToolStatusVariant(state: ReturnType<typeof getToolPartState>) {
  switch (state) {
    case "complete":
      return "tool-badge tool-badge-complete";
    case "error":
      return "tool-badge tool-badge-error";
    case "denied":
    case "waiting-approval":
      return "tool-badge tool-badge-outline";
    default:
      return "tool-badge tool-badge-outline";
  }
}

function isToolRunningState(state: ReturnType<typeof getToolPartState>) {
  return state === "loading" || state === "streaming";
}

function formatToolJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function formatHistoryMetric(metric: unknown) {
  switch (metric) {
    case "best_session":
      return "Best session";
    case "e1rm":
      return "Estimated 1RM";
    case "frequency":
      return "Frequency";
    case "max_load":
      return "Max load";
    case "reps_at_load":
      return "Reps at load";
    case "top_set":
      return "Top set";
    case "volume":
      return "Volume";
    default:
      return "History";
  }
}

function renderUnknownToolResult(output: unknown) {
  return (
    <details className="tool-details">
      <summary>View tool details</summary>
      <pre className="tool-json">{formatToolJson(output)}</pre>
    </details>
  );
}

function renderQueryHistoryToolBody(
  state: ReturnType<typeof getToolPartState>,
  input: unknown,
  output: unknown,
) {
  if (state === "loading" || state === "streaming") {
    const metric =
      isRecord(input) && typeof input.metric === "string"
        ? formatHistoryMetric(input.metric)
        : null;

    return (
      <p className="tool-copy">
        {metric ? `Looking up ${metric.toLowerCase()}...` : "Looking up workout history..."}
      </p>
    );
  }

  if (!isRecord(output)) {
    return renderUnknownToolResult(output);
  }

  if (output.ok === true && isRecord(output.result)) {
    const sessionCount =
      typeof output.result.sessionCount === "number"
        ? output.result.sessionCount
        : Array.isArray(output.result.sessions)
          ? output.result.sessions.length
          : null;
    const sessionsSource = Array.isArray(output.result.previewSessions)
      ? output.result.previewSessions
      : Array.isArray(output.result.sessions)
        ? output.result.sessions
        : [];
    const sessions = sessionsSource
      .flatMap((session) => {
        if (
          !isRecord(session) ||
          typeof session.date !== "string" ||
          typeof session.title !== "string"
        ) {
          return [];
        }

        return [
          {
            date: session.date,
            title: session.title,
          },
        ];
      })
      .slice(0, 3);

    return (
      <div className="tool-body">
        {sessionCount == null ? null : (
          <p className="tool-copy">
            {sessionCount} matching session{sessionCount === 1 ? "" : "s"}
          </p>
        )}
        {sessions.length === 0 ? null : (
          <div className="tool-session-list">
            {sessions.map((session) => (
              <div className="tool-session" key={`${session.date}:${session.title}`}>
                <span className="tool-session-title">{session.title}</span>
                <span className="tool-session-date">
                  <LocalDateTime
                    formatOptions={{ day: "numeric", month: "short" }}
                    value={session.date}
                    valueKind="calendar-date"
                  />
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (output.ok === false) {
    return (
      <p className="tool-copy">
        {typeof output.message === "string" ? output.message : "Unable to query history."}
      </p>
    );
  }

  return renderUnknownToolResult(output);
}

function renderToolBody(
  toolName: string,
  state: ReturnType<typeof getToolPartState>,
  input: unknown,
  output: unknown,
) {
  switch (toolName) {
    case "query_history":
      return renderQueryHistoryToolBody(state, input, output);
    default:
      if (state === "loading" || state === "streaming") {
        return <p className="tool-copy">Running {getToolLabel(toolName)}...</p>;
      }

      return renderUnknownToolResult(output);
  }
}

function ToolPartCard({
  onApprovalResponse,
  part,
}: {
  onApprovalResponse: (approvalId: string, approved: boolean) => void;
  part: ReproMessagePart;
}) {
  if (!isToolUIPart(part)) {
    return null;
  }

  const toolName = getToolName(part);
  const toolLabel = getToolLabel(toolName);
  const toolState = getToolPartState(part);
  const input = getToolInput(part);
  const output = getToolOutput(part);
  const approval = getToolApproval(part);
  const isRunning = isToolRunningState(toolState);

  return (
    <div
      className={cn(
        "repro-tool-card",
        isRunning ? "repro-tool-card-running" : null,
      )}
    >
      <div className="repro-tool-card-header">
        <p className="repro-tool-card-title">{toolLabel}</p>
        <span className={getToolStatusVariant(toolState)}>
          {getToolStatusLabel(toolState, toolName)}
        </span>
      </div>

      {renderToolBody(toolName, toolState, input, output)}

      {toolState === "waiting-approval" && approval ? (
        <div className="composer-actions">
          <button
            onClick={() => {
              onApprovalResponse(approval.id, true);
            }}
            type="button"
          >
            Approve
          </button>
          <button
            onClick={() => {
              onApprovalResponse(approval.id, false);
            }}
            type="button"
          >
            Reject
          </button>
        </div>
      ) : null}
    </div>
  );
}

function renderMessagePart(
  onApprovalResponse: (approvalId: string, approved: boolean) => void,
  part: ReproMessagePart,
  key: string,
) {
  const text = getTextPartText(part);

  if (text) {
    return (
      <p className="message-text" key={key}>
        {text}
      </p>
    );
  }

  if (isToolUIPart(part)) {
    return <ToolPartCard key={key} onApprovalResponse={onApprovalResponse} part={part} />;
  }

  return null;
}

function getChatErrorMessage(error: Error | undefined) {
  const message = error?.message?.trim();

  return message && message.length > 0 ? message : "The chat could not complete this request.";
}

function ReproErrorCard({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="error">
      <div className="error-header">
        <strong>Coach unavailable</strong>
        <button onClick={onDismiss} type="button">
          Dismiss
        </button>
      </div>
      <p>{message}</p>
    </div>
  );
}

export function ReproChatPanel({
  chat,
  emptyState,
  placeholder,
}: {
  chat: ReproChatController;
  emptyState: string;
  placeholder: string;
}) {
  const [draft, setDraft] = useState("");
  const [isBottomLocked, setIsBottomLocked] = useState(true);
  const discussionScrollRef = useRef<HTMLDivElement | null>(null);
  const discussionEndRef = useRef<HTMLDivElement | null>(null);
  const programmaticScrollFrameRef = useRef<number | null>(null);
  const isProgrammaticScrollRef = useRef(false);
  const {
    addToolApprovalResponse,
    clearError,
    clearHistory,
    error,
    isServerStreaming,
    isStreaming,
    messages,
    sendMessage,
    status,
    stop,
  } = chat;
  const isSubmitting = status === "submitted";
  const isBusy = isSubmitting || isStreaming;
  const chatErrorMessage = error ? getChatErrorMessage(error) : null;

  const syncBottomLock = useEffectEvent((nextValue: boolean) => {
    setIsBottomLocked((currentValue) => (currentValue === nextValue ? currentValue : nextValue));
  });

  const isDiscussionTailVisible = useEffectEvent(() => {
    const discussionScroll = discussionScrollRef.current;
    const discussionEnd = discussionEndRef.current;

    if (!discussionScroll || !discussionEnd) {
      return true;
    }

    const scrollBounds = discussionScroll.getBoundingClientRect();
    const endBounds = discussionEnd.getBoundingClientRect();

    return endBounds.top <= scrollBounds.bottom && endBounds.bottom >= scrollBounds.top;
  });

  const releaseProgrammaticScrollLock = useEffectEvent(() => {
    if (programmaticScrollFrameRef.current != null) {
      window.cancelAnimationFrame(programmaticScrollFrameRef.current);
    }

    programmaticScrollFrameRef.current = window.requestAnimationFrame(() => {
      isProgrammaticScrollRef.current = false;
      syncBottomLock(isDiscussionTailVisible());
    });
  });

  const scrollDiscussionToTail = useEffectEvent((behavior: ScrollBehavior = "auto") => {
    if (!discussionEndRef.current) {
      return;
    }

    isProgrammaticScrollRef.current = true;
    discussionEndRef.current.scrollIntoView({
      behavior,
      block: "end",
    });
    releaseProgrammaticScrollLock();
  });

  const handleDiscussionScroll = useEffectEvent(() => {
    if (isProgrammaticScrollRef.current) {
      return;
    }

    syncBottomLock(isDiscussionTailVisible());
  });

  useEffect(() => {
    const discussionScroll = discussionScrollRef.current;
    const discussionEnd = discussionEndRef.current;

    if (!discussionScroll || !discussionEnd) {
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          syncBottomLock(true);
        }
      },
      {
        root: discussionScroll,
        threshold: 0.5,
      },
    );

    observer.observe(discussionEnd);

    return () => {
      observer.disconnect();
    };
  }, [syncBottomLock]);

  useEffect(() => {
    return () => {
      if (programmaticScrollFrameRef.current != null) {
        window.cancelAnimationFrame(programmaticScrollFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!isBottomLocked) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      scrollDiscussionToTail();
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [isBottomLocked, messages, status, scrollDiscussionToTail]);

  const handleClearThread = () => {
    void stop();
    clearError();
    clearHistory();
    setIsBottomLocked(true);
    setDraft("");
  };

  const submitDraft = () => {
    const nextDraft = draft.trim();

    if (nextDraft.length === 0 || isBusy) {
      return;
    }

    clearError();
    setIsBottomLocked(true);
    setDraft("");
    startTransition(() => {
      void sendMessage({
        parts: [{ text: nextDraft, type: "text" }],
        role: "user",
      }).catch(() => {
        setDraft(nextDraft);
      });
    });
  };

  const jumpToBottom = () => {
    setIsBottomLocked(true);
    scrollDiscussionToTail();
  };

  const showJumpToBottomButton = messages.length > 0 && !isBottomLocked;
  const activityStatusLabel = isSubmitting
    ? "Sending to agent"
    : isServerStreaming
      ? "Agent is working in the background"
      : "Agent is replying";

  return (
    <section className="repro-panel">
      <div className="repro-panel-header">
        <div className="composer-actions">
          <button onClick={handleClearThread} type="button">
            Clear
          </button>
          {isBusy ? <span className="activity-pill">{activityStatusLabel}</span> : null}
        </div>
      </div>

      <div className="discussion-shell">
        <div className="discussion-scroll" onScroll={handleDiscussionScroll} ref={discussionScrollRef}>
          <div className="messages">
            {messages.length === 0 && !chatErrorMessage ? (
              <div className="empty-state">{emptyState}</div>
            ) : (
              messages.map((message) => {
                const renderedParts = message.parts
                  .map((part, index) =>
                    renderMessagePart(
                      (approvalId, approved) => {
                        addToolApprovalResponse({ approved, id: approvalId });
                      },
                      part,
                      `${message.id}:${part.type}:${index}`,
                    ),
                  )
                  .filter((part) => part !== null);

                if (renderedParts.length === 0) {
                  return null;
                }

                return (
                  <article
                    className={cn(
                      "message",
                      message.role === "user" ? "message-user" : "message-assistant",
                    )}
                    key={message.id}
                  >
                    <header>
                      <strong>{message.role}</strong>
                      <span>{message.id}</span>
                    </header>
                    <div className="parts">{renderedParts}</div>
                  </article>
                );
              })
            )}
            {chatErrorMessage ? (
              <ReproErrorCard message={chatErrorMessage} onDismiss={clearError} />
            ) : null}
            <div aria-hidden className="discussion-end" ref={discussionEndRef} />
          </div>
        </div>

        {showJumpToBottomButton ? (
          <div className="jump-row">
            <button onClick={jumpToBottom} type="button">
              Jump to latest
            </button>
          </div>
        ) : null}
      </div>

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          submitDraft();
        }}
      >
        <textarea
          disabled={isBusy}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
              return;
            }

            event.preventDefault();
            submitDraft();
          }}
          placeholder={placeholder}
          value={draft}
        />
        <div className="composer-actions">
          <button disabled={draft.trim().length === 0 || isBusy} type="submit">
            Send
          </button>
        </div>
      </form>
    </section>
  );
}
