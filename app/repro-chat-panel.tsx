import { getToolPartState } from "@cloudflare/ai-chat/react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";

export interface ReproChatController {
  error: Error | undefined;
  messages: readonly UIMessage[];
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
  const chatErrorMessage = getChatErrorMessage(chat.error);

  return (
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
  );
}
