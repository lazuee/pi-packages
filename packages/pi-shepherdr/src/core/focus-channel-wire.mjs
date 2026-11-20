// Credit keeps Core's repaint fallback out of this stream.
const LIMIT = 1024 * 1024;
const CHUNK = 8192;
// In-flight frames before an ack; a repaint exceeds four chunks.
const WINDOW = 16;
const MAX_MESSAGE = 512 * 1024 + 128;
// Payloads cross a pty, which rewrites \n and some controls.
const PCT = 0x25;
const BAD = new Set([0, 3, 4, 10, 13, 17, 19, 21, 26, 33, 37, 92, 127]);
/** @param {Buffer} bytes */
function escape(bytes) {
  let out = "";
  for (const b of bytes)
    out +=
      b < 32 || b > 126 || BAD.has(b)
        ? `%${b.toString(16).padStart(2, "0")}`
        : String.fromCharCode(b);
  return out;
}
/** @param {string} s */
function unescape(s) {
  const out = Buffer.allocUnsafe(s.length);
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c === PCT) {
      const h = s.slice(i + 1, i + 3);
      if (h.length !== 2 || Number.isNaN(Number.parseInt(h, 16)))
        throw new Error("Focus stream escape is malformed");
      out[n++] = Number.parseInt(h, 16);
      i += 2;
    } else out[n++] = c & 0xff;
  }
  return out.subarray(0, n);
}
/**
 * @param {string} nonce
 * @param {(bytes:Buffer)=>void} write
 * @param {(message:unknown)=>void} receive
 * @param {(error:Error)=>void} fail
 * @param {()=>void} [onLive]
 * @param {{maxMessageBytes?:number,maxQueuedBytes?:number}} [limits]
 */
export function focusWire(nonce, write, receive, fail, onLive, limits = {}) {
  const maxMessage = limits.maxMessageBytes ?? MAX_MESSAGE;
  const maxQueued = limits.maxQueuedBytes ?? LIMIT;
  const prefix = `!${nonce}!`;
  let buffer = "";
  let ended = false;
  let heard = Date.now();
  let sent = 0;
  let received = 0;
  let accepted = 0;
  let held = 0;
  let acknowledged = 0;
  /** Send-stream byte count for `ends`; separate from what is read. */
  let sentBytes = 0;
  let readBytes = 0;
  let queuedBytes = 0;
  /** @type {Buffer[]} */
  let chunks = [];
  let chunkBytes = 0;
  /** @type {Array<{data:string,end:boolean,bytes:number}>} */
  const queue = [];
  /** @param {object} value */
  const emit = (value) => {
    if (!ended)
      write(
        Buffer.from(`${prefix}${escape(Buffer.from(JSON.stringify(value)))}!\n`)
      );
  };
  const flush = () => {
    while (!ended && queue.length && sent - acknowledged < WINDOW) {
      // A burst of small messages otherwise spends one window slot and one write
      // each. Pack the queued bytes and let the ends mark the messages they
      // drain, so several small messages share one frame and one round trip.
      let data = "";
      let packed = 0;
      /** @type {number[]} ends, in bytes from the start of the send stream */
      const ends = [];
      for (let next = queue[0]; next; next = queue[0]) {
        if (data && data.length + next.data.length > CHUNK * 3) break;
        queue.shift();
        queuedBytes -= next.bytes;
        data += next.data;
        // An end is the byte count at the message's last byte. Bytes still
        // queued come after it, so a message never drains before it arrives.
        packed += next.data.length;
        if (next.end) ends.push(sentBytes + packed);
      }
      sentBytes += packed;
      emit({ n: ++sent, data, ends });
    }
  };
  // A short window lets a burst of small messages queue up so flush can pack
  // them, instead of one write and one round trip per 100-byte fragment.
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let soon;
  const flushSoon = () => {
    if (soon !== undefined) return;
    soon = setTimeout(() => {
      soon = undefined;
      if (!ended) flush();
    }, 8);
    soon.unref?.();
  };
  /** @param {unknown} error */
  const failed = (error) => {
    if (ended) return;
    const reason = error instanceof Error ? error : new Error(String(error));
    // Error control bypasses a full data queue; never hide remote overflow as EOF.
    try {
      emit({ error: reason.message });
    } catch {}
    close();
    fail(reason);
  };
  // Both sides ping every second; the lease only fires when a link has gone quiet
  // for far longer than one round trip on a slow machine.
  const LEASE = 30_000;
  const timer = setInterval(() => {
    try {
      if (Date.now() - heard > LEASE)
        throw new Error("Focus stream lease expired");
      emit({ ping: true });
    } catch (error) {
      failed(error);
    }
  }, 1000);
  function close() {
    ended = true;
    clearInterval(timer);
    if (soon !== undefined) clearTimeout(soon);
    soon = undefined;
    queue.length = 0;
    chunks = [];
    buffer = "";
  }
  return {
    close,
    /** @param {unknown} message */
    send(message) {
      if (ended) throw new Error("Focus stream is closed");
      try {
        const json = JSON.stringify(message);
        if (json === undefined) throw new Error("Focus stream requires JSON");
        const bytes = Buffer.from(json);
        if (bytes.length > maxMessage)
          throw new Error("Remote message exceeds its size limit");
        // Chunk the raw bytes; the whole frame is escaped on emit. An escaped byte
        // can cost three characters, so keep a chunk under half CHUNK to leave room.
        for (let at = 0; at < bytes.length; at += CHUNK >> 1) {
          const data = bytes.subarray(at, at + (CHUNK >> 1)).toString("latin1");
          queue.push({ data, end: at + (CHUNK >> 1) >= bytes.length, bytes: 0 });
        }
        queuedBytes += bytes.length;
        flushSoon();
      } catch (error) {
        failed(error);
        throw error;
      }
    },
    /** @param {Buffer} bytes */
    push(bytes) {
      if (ended) return;
      try {
        buffer += bytes.toString("latin1");
        if (buffer.length > LIMIT)
          throw new Error("Focus stream input exceeded its buffer");
        for (;;) {
          const start = buffer.indexOf(prefix);
          if (start === -1) {
            buffer = buffer.slice(-prefix.length);
            return;
          }
          const end = buffer.indexOf("!", start + prefix.length);
          if (end === -1) {
            buffer = buffer.slice(start);
            return;
          }
          const body = buffer.slice(start + prefix.length, end);
          // Transitional: an earlier build base64-encoded the whole frame, so it
          // never starts with '{' the way an escaped JSON frame does.
          const frame = JSON.parse(
            (body.startsWith("{")
              ? unescape(body)
              : Buffer.from(body, "base64")
            ).toString()
          );
          buffer = buffer.slice(end + 1);
          heard = Date.now();
          if (typeof frame.error === "string") throw new TypeError(frame.error);
          if (frame.ping === true) {
            onLive?.();
            continue;
          }
          if (Number.isSafeInteger(frame.ack)) {
            if (frame.ack !== acknowledged + 1 || frame.ack > sent)
              throw new Error("Focus stream acknowledgement is out of order");
            acknowledged = frame.ack;
            flush();
            continue;
          }
          if (
            frame.n !== received + 1 ||
            typeof frame.data !== "string" ||
            frame.data.length > 110_000 ||
            (typeof frame.end !== "boolean" && !Array.isArray(frame.ends))
          )
            throw new Error("Focus stream data is out of order or invalid");
          const chunk = Buffer.from(frame.data, "latin1");
          chunks.push(chunk);
          chunkBytes += chunk.length;
          if (chunkBytes > maxMessage)
            throw new Error("Remote message exceeds its size limit");
          // Ends are byte counts in the send stream. `chunks` holds every byte from
          // `held` onward, so a message still arriving is sliced from its own start.
          const bounds = Array.isArray(frame.ends)
            ? frame.ends
            : frame.end
              ? [readBytes + chunk.length]
              : [];
          let from = accepted;
          readBytes += chunk.length;
          for (const bound of bounds) {
            if (!Number.isSafeInteger(bound) || bound <= accepted) continue;
            const whole = Buffer.concat(chunks);
            receive(JSON.parse(whole.subarray(from - held, bound - held).toString()));
            from = bound;
            accepted = bound;
          }
          const rest = Buffer.concat(chunks).subarray(accepted - held);
          chunks = rest.length ? [rest] : [];
          chunkBytes = rest.length;
          held = accepted;
          received++;
          emit({ ack: received });
        }
      } catch (error) {
        failed(error);
      }
    },
  };
}
