import { Socket } from "node:net";

import { object, response } from "./protocol.js";

// Core fixes the viewer size for the life of an attachment and exposes no resize
// method, so a wrong guess here reflows the whole screen on every repaint.
const DEFAULT_SIZE = { cols: 80, rows: 24 };
// Core sends this frame kind before replacing the screen.
const RESIZE_KIND = 4;

function clampCell(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value! > 0 && value! <= 65_535
    ? value!
    : fallback;
}

/** Released Core generation 1 framed attachment. Only attach a private helper. */
export function attachCoreTerminal(
  socketPath: string,
  terminal: string,
  onData: (bytes: Buffer) => void,
  onClose: (error: Error) => void,
  size: { cols?: number; rows?: number } = DEFAULT_SIZE
): {
  ready: Promise<void>;
  write(bytes: Buffer): void;
  close(): void;
} {
  const socket = new Socket();
  let buffer = Buffer.alloc(0);
  let framed = false;
  let channel = 0;
  // The wire that owns this stream pings on a one-second timer from the moment
  // it is built, which is before the attach handshake can have assigned a
  // channel. Buffer writes until then instead of failing the stream.
  const pending: Buffer[] = [];
  let ended = false;
  let resolveReady: () => void = () => {
    /* empty */
  };
  let rejectReady: (error: Error) => void = () => {
    /* empty */
  };
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const timer = setTimeout(
    () => fail(new Error("Remote focus connection timed out")),
    15_000
  );
  function close(error = new Error("Remote focus connection closed")) {
    ended = true;
    clearTimeout(timer);
    rejectReady(error);
    socket.destroy();
    buffer = Buffer.alloc(0);
  }
  function fail(error: Error) {
    if (ended) return;
    close(error);
    onClose(error);
  }
  function send(ch: number, kind: number, payload: Buffer) {
    if (ended) throw new Error("Remote focus connection closed");
    if (socket.writableLength + payload.length > 1024 * 1024)
      throw new Error("Remote focus output exceeded its buffer");
    const header = Buffer.alloc(9);
    header.writeUInt32LE(ch, 0);
    header[4] = kind;
    header.writeUInt32LE(payload.length, 5);
    socket.write(Buffer.concat([header, payload]));
  }
  socket.on("error", fail);
  socket.on("close", () =>
    fail(new Error("Remote focus connection disconnected"))
  );
  socket.on("data", (bytes: Buffer) => {
    try {
      buffer = Buffer.concat([buffer, bytes]);
      if (!framed) {
        const newline = buffer.indexOf(10);
        if (newline === -1) {
          if (buffer.length > 64 * 1024)
            throw new Error("Core handshake is too large");
          return;
        }
        const hello = object(
          response(object(JSON.parse(buffer.subarray(0, newline).toString())))
        );
        if (hello["generation"] !== 1 || hello["framed"] !== true)
          throw new Error("Core does not support generation 1 framed streams");
        buffer = buffer.subarray(newline + 1);
        framed = true;
        send(
          0,
          0,
          Buffer.from(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "terminal.attach",
              params: {
                terminal,
                cols: clampCell(size.cols, DEFAULT_SIZE.cols),
                rows: clampCell(size.rows, DEFAULT_SIZE.rows),
                history: 0,
                resize_notifications: true,
              },
            })
          )
        );
      }
      while (buffer.length >= 9 && !ended) {
        const ch = buffer.readUInt32LE(0);
        const kind = buffer[4] ?? 0;
        const length = buffer.readUInt32LE(5);
        if (length > 1024 * 1024)
          throw new Error("Remote focus frame exceeds 1 MiB");
        if (buffer.length < length + 9) return;
        const payload = buffer.subarray(9, length + 9);
        buffer = buffer.subarray(length + 9);
        if (ch === 0 && kind === 0) {
          const result = object(
            response(object(JSON.parse(payload.toString())))
          );
          if (
            channel ||
            typeof result["channel"] !== "number" ||
            !Number.isSafeInteger(result["channel"]) ||
            result["channel"] <= 0 ||
            result["channel"] > 0xff_ff_ff_ff
          )
            throw new Error("Core returned an invalid helper stream");
          ({ channel } = result);
          clearTimeout(timer);
          for (const queued of pending.splice(0)) send(channel, 0, queued);
          resolveReady();
        } else if (ch === channel && kind === 0) {
          onData(payload);
          if (ended) return;
          const credit = Buffer.alloc(4);
          credit.writeUInt32LE(length);
          send(channel, 1, credit);
        } else if (ch === channel && kind === 2) {
          throw new Error("Remote focus process ended");
        } else if (ch === channel && kind === RESIZE_KIND) {
          // Core resized its own view; the viewer follows on the next paint.
        } else if (ch === channel && kind === 1) {
          // Credit frames the far side emits for what we sent; nothing to do.
        } else throw new Error("Unexpected Remote focus stream frame");
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
  socket.connect(socketPath, () =>
    socket.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { generation: 1, framed: true } })}\n`
    )
  );
  // The attach handshake assigns the channel; pending writes flush there.
  return {
    ready,
    close,
    write(bytes) {
      if (!channel) {
        pending.push(bytes);
        return;
      }
      try {
        send(channel, 0, bytes);
      } catch (error) {
        const reason =
          error instanceof Error ? error : new Error(String(error));
        fail(reason);
        throw reason;
      }
    },
  };
}
