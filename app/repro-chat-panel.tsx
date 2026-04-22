import { getToolPartState } from "@cloudflare/ai-chat/react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { useEffect, useEffectEvent, useRef, useState } from "react";

export interface ReproChatController {
  error: Error | undefined;
  isStreaming: boolean;
  messages: readonly UIMessage[];
  status: string;
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

export function ReproChatPanel({ chat }: { chat: ReproChatController }) {
  const [isBottomLocked, setIsBottomLocked] = useState(true);
  const discussionScrollRef = useRef<HTMLDivElement | null>(null);
  const discussionEndRef = useRef<HTMLDivElement | null>(null);
  const programmaticScrollFrameRef = useRef<number | null>(null);
  const isProgrammaticScrollRef = useRef(false);
  const chatErrorMessage = getChatErrorMessage(chat.error);

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
  }, [chat.isStreaming, chat.messages, chat.status, isBottomLocked, scrollDiscussionToTail]);

  return (
    <section className="discussion-shell">
      <div className="discussion-scroll" onScroll={handleDiscussionScroll} ref={discussionScrollRef}>
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

          <div aria-hidden className="discussion-end" ref={discussionEndRef} />
        </div>
      </div>
    </section>
  );
}
