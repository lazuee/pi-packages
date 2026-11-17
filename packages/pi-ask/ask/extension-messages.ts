import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { AskRequest, RequestChange } from "./requests.js";

const ENTRY = "shepherdr-extension-message";
const REPLY_CHANNEL = "@lazuee/pi-shepherdr/extension-reply/v1";
const EXTENSION = "@howaboua/pi-ask";

function questionText(request: AskRequest): string {
  return [
    request.handoff
      ? "Human action required; ask the user to complete this handoff"
      : request.steering
        ? "Question pending; the agent can continue reversible work, but still needs an answer"
        : "Question pending; the agent is waiting for an answer",
    ...request.prompts.map((prompt, index) =>
      [
        `${index + 1}. ${prompt.title}`,
        ...(prompt.body ? [prompt.body] : []),
        ...(prompt.choices.length
          ? [
              `Choose ${prompt.multiple ? "one or more" : "one"}:`,
              ...prompt.choices.map(
                (choice) =>
                  `- ${JSON.stringify(choice.label)}${choice.description ? `\n  ${choice.description}` : ""}`
              ),
            ]
          : ["Free-text answer"]),
      ].join("\n")
    ),
    ...(request.handoff
      ? []
      : [
          "Reply with a JSON array in prompt order: selections contains exact choice labels; other supplies free text; comment is optional. Blank other requests rephrasing. Replace the placeholders in the reply below, do not send them literally. An ordinary agent message does not resolve this question",
        ]),
  ].join("\n\n");
}

/** Ask owns question text and reply semantics; Shepherdr carries opaque strings. */
export function publishAskRequest(
  pi: ExtensionAPI,
  change: RequestChange
): void {
  const base = { version: 1, extension: EXTENSION };
  if (change.state === "closed") {
    pi.appendEntry(ENTRY, { ...base, id: change.id, state: "closed" });
    return;
  }
  const { request } = change;
  pi.appendEntry(ENTRY, {
    ...base,
    id: request.id,
    state: "pending",
    message: questionText(request),
    blocking: !request.steering,
    ...(request.handoff
      ? {}
      : {
          reply: JSON.stringify(
            request.prompts.map((prompt) =>
              prompt.choices.length
                ? { selections: ["<choice label>"] }
                : { other: "<answer>" }
            )
          ),
        }),
  });
}

export function registerAskReplies(
  pi: ExtensionAPI,
  reply: (id: string, message: string) => Promise<string>
): void {
  pi.events.on(REPLY_CHANNEL, (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const event = value as Record<string, unknown>;
    if (
      event["extension"] !== EXTENSION ||
      typeof event["id"] !== "string" ||
      typeof event["message"] !== "string" ||
      typeof event["respond"] !== "function"
    )
      return;
    event["respond"](reply(event["id"], event["message"]));
  });
}
