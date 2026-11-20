import { randomUUID } from "node:crypto";

/**
 * Reverse context traffic shares the live Core transport, never exec polls.
 * @param {any} context
 * @param {(message:unknown)=>void} send
 */
export function helperContext(context, send) {
  const incoming = new Map();
  const outgoing = new Map();
  // path -> live close, replaced only once its listener is actually bound.
  const relays = new Map();
  let closed = false;
  /** @param {unknown} request @param {AbortSignal} signal */
  function requestController(request, signal) {
    signal.throwIfAborted();
    if (closed) throw new Error("Shared context controller disconnected");
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      /** @param {unknown} [error] @param {unknown} [result] */
      const finish = (error, result) => {
        if (!outgoing.delete(id)) return;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(result);
      };
      const abort = () => {
        try {
          if (!closed) send({ type: "context_cancel", id });
        } catch (error) {
          finish(error);
          return;
        }
        finish(
          new Error(
            "Shared context request cancelled; a write may have completed. Reread before retrying"
          )
        );
      };
      const timer = setTimeout(abort, 35_000);
      outgoing.set(id, { finish });
      signal.addEventListener("abort", abort, { once: true });
      try {
        send({ type: "context_request", id, request });
      } catch (error) {
        finish(error);
      }
    });
  }
  return {
    /** @param {string} id @param {(signal:AbortSignal)=>Promise<unknown>} execute */
    async request(id, execute) {
      if (closed) throw new Error("Shared context connection closed");
      const controller = new AbortController();
      incoming.set(id, controller);
      try {
        return await execute(controller.signal);
      } finally {
        incoming.delete(id);
      }
    },
    /** @param {string} threadId @param {string} routeId */
    async start(threadId, routeId) {
      if (closed) throw new Error("Shared context connection closed");
      const path = context.relayContextPath(threadId, routeId);
      const starting = relays.get(path);
      if (typeof starting === "function") return path;
      let ready = starting;
      if (!ready) {
        ready = context.listenContext(path, requestController);
        relays.set(path, ready);
      }
      let close;
      try {
        close = await ready;
      } catch (error) {
        relays.delete(path);
        throw error;
      }
      // Leaving the listener published after the controller dropped would make
      // the routed relay look reachable while nobody answers over its Core.
      relays.set(path, close);
      return path;
    },
    /** @param {string} threadId @param {string} routeId */
    async stop(threadId, routeId) {
      // Routes are keyed by the path the controller was handed for this identity.
      const path = context.relayContextPath(threadId, routeId);
      const closing = relays.get(path);
      if (!closing) return false;
      if (typeof closing === "function") return false;
      relays.delete(path);
      await closing();
      return true;
    },
    /** @param {any} message */
    consume(message) {
      if (message.op === "context_cancel") {
        incoming.get(message.id)?.abort();
        return true;
      }
      if (message.op === "context_reply") {
        outgoing
          .get(message.id)
          ?.finish(
            message.ok ? undefined : new Error(message.error),
            message.result
          );
        return true;
      }
      return false;
    },
    async close() {
      closed = true;
      for (const controller of incoming.values()) controller.abort();
      for (const entry of outgoing.values())
        entry.finish(new Error("Shared context controller disconnected"));
      await Promise.allSettled(
        [...relays.values()].map(async (closing) =>
          typeof closing === "function" ? undefined : (await closing)()
        )
      );
      relays.clear();
    },
  };
}
