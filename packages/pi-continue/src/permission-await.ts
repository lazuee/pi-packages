/**
 * Track whether a permission prompt is waiting for the human.
 *
 * A prompt is an active `ask`: continuing over it would push work into a session
 * nobody can approve, and the recovery would look like a stall of its own. The
 * two channels pair by `requestId`, so open ids are tracked rather than a
 * counter — a decision for a request that never prompted must not clear
 * anything.
 *
 * The payloads are read defensively: they are written by an independently
 * versioned sibling extension and carry no protocol version.
 */
const PROMPT_CHANNEL = "permissions:ui_prompt";
const DECISION_CHANNEL = "permissions:decision";

export interface ObserverEvents {
  on(channel: string, handler: (payload: unknown) => void): () => void;
}

export class PermissionAwait {
  readonly #open = new Set<string>();
  readonly #unsubscribe: Array<() => void> = [];

  constructor(events: ObserverEvents) {
    this.#unsubscribe.push(
      events.on(PROMPT_CHANNEL, (payload) => {
        const id = requestId(payload);
        if (id) this.#open.add(id);
      }),
      events.on(DECISION_CHANNEL, (payload) => {
        const id = requestId(payload);
        if (id) this.#open.delete(id);
      }),
    );
  }

  /** Whether any prompt is still open. */
  get pending(): boolean {
    return this.#open.size > 0;
  }

  /** How many prompts are open, for diagnostics. */
  get pendingCount(): number {
    return this.#open.size;
  }

  dispose(): void {
    for (const off of this.#unsubscribe) off();
    this.#unsubscribe.length = 0;
    this.#open.clear();
  }
}

function requestId(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const id = (payload as { requestId?: unknown }).requestId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** Channel names, so a consumer need not re-spell them. */
export const PERMISSION_CHANNELS = {
  PROMPT: PROMPT_CHANNEL,
  DECISION: DECISION_CHANNEL,
} as const;
