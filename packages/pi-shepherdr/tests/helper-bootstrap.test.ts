import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";

/**
 * The bootstrap is spawned the way Core spawns it: an inline `-e` source whose
 * only argv is the nonce/wire bootstrap. Nothing here is mocked, so these cover
 * the console shim and the frame dispatch a unit test cannot reach.
 */
const BOOTSTRAP = new URL("../src/core/helper-bootstrap.mjs", import.meta.url);
const NONCE = "ab12";

let child: ChildProcessWithoutNullStreams | undefined;
afterEach(() => {
  child?.kill("SIGKILL");
  child = undefined;
});

async function start() {
  const source = await readFile(BOOTSTRAP, "utf-8");
  const wire = new URL("../src/core/focus-channel-wire.mjs", import.meta.url)
    .href;
  const argument = Buffer.from(JSON.stringify({ nonce: NONCE, wire })).toString(
    "base64"
  );
  child = spawn("node", ["--input-type=module", "-e", source, argument], {
    stdio: "pipe",
  });
  const out = new FrameReader(child);
  return { out, child };
}

/** Collects the window's own frames and ignores everything else on stdout. */
class FrameReader {
  private buffered = "";
  private readonly frames: Record<string, unknown>[] = [];
  constructor(readable: ChildProcessWithoutNullStreams) {
    readable.stdout.setEncoding("latin1");
    readable.stdout.on("data", (chunk: string) => this.push(chunk));
  }
  private push(chunk: string) {
    this.buffered += chunk;
    for (;;) {
      const start = this.buffered.indexOf(`!${NONCE}!`);
      if (start === -1) return;
      const end = this.buffered.indexOf("!", start + NONCE.length + 2);
      if (end === -1) return;
      const body = this.buffered.slice(start + NONCE.length + 2, end);
      this.buffered = this.buffered.slice(end + 1);
      try {
        // Frames are escaped: `%5c` is the quote itself, so unescape first.
        const text = body.replaceAll(/%([0-9a-f]{2})/gi, (_, hex: string) =>
          String.fromCodePoint(Number.parseInt(hex, 16))
        );
        this.frames.push(JSON.parse(text) as Record<string, unknown>);
      } catch {
        // A partial or non-JSON frame is what a broken escape would produce.
        this.frames.push({ unparseable: body });
      }
    }
  }
  /**
   * Waits for a frame of `type`. A kind frame is sent as-is; one the wire does
   * not know is data, so those arrive as chunks and are reassembled here.
   */
  async expect(type: string, timeout = 5000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const found = [...this.frames, ...this.decoded()].find(
        (frame) => frame["type"] === type
      );
      if (found) return found;
      if (Date.now() > deadline)
        throw new Error(
          `No ${type} frame; saw ${JSON.stringify(this.frames)} (raw ${JSON.stringify(this.buffered)})`
        );
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  /** Waits for a whole message carrying `key`, kind or data. */
  async expectKey(key: string, timeout = 5000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const found = [...this.frames, ...this.decoded()].find(
        (frame) => key in frame
      );
      if (found) return found;
      if (Date.now() > deadline)
        throw new Error(`No ${key}; saw ${JSON.stringify(this.seen)}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  /** Every whole message carried by the data path, split on the `ends` marks. */
  decoded() {
    const out: Record<string, unknown>[] = [];
    let pending: Buffer = Buffer.alloc(0);
    let consumed = 0;
    for (const frame of this.frames) {
      if (typeof frame["data"] !== "string") continue;
      pending = Buffer.concat([pending, Buffer.from(frame["data"], "latin1")]);
      const bounds = Array.isArray(frame["ends"])
        ? (frame["ends"] as number[])
        : [];
      let from = consumed;
      for (const bound of bounds) {
        if (typeof bound !== "number" || bound <= consumed) continue;
        try {
          out.push(
            JSON.parse(pending.subarray(from, bound).toString()) as Record<
              string,
              unknown
            >
          );
        } catch {
          // A message the wire would also reject.
        }
        from = bound;
        consumed = bound;
      }
    }
    return out;
  }
  get seen() {
    return [...this.frames, ...this.decoded()];
  }
}

/** Sends one frame the way the owner does. */
function send(target: ChildProcessWithoutNullStreams, value: unknown) {
  target.stdin.write(`!${NONCE}!${JSON.stringify(value)}!\n`);
}

/** A module the bootstrap can import as its `serve`, with a controllable body. */
const moduleUrl = (code: string) =>
  `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;

describe("helper bootstrap", () => {
  test("reports a diagnostic as a frame instead of writing to stdout", async () => {
    const { out, child } = await start();
    send(child, {
      type: "start",
      input: {
        modules: {
          helper: moduleUrl(`
      export async function serve(_input, send) {
        console.log("[shepherdr] terminal identity failed");
        return { receive: () => undefined, close: () => undefined };
      }
    `),
        },
      },
    });
    // Without the shim this text reaches stdout bare and the owner loses the link.
    const log = await out.expect("log");
    expect(log["message"]).toContain("terminal identity failed");
  });

  test("serves, reports ready, and routes later frames to the runtime", async () => {
    const { out, child } = await start();
    const helper = moduleUrl(`
      export async function serve(_input, send, _fail) {
        console.log("[shepherdr] terminal identity failed");
        return {
          receive: (message) => send({ echo: message }),
          close: () => undefined,
        };
      }
    `);
    send(child, { type: "start", input: { modules: { helper } } });

    await out.expect("ready");
    // The module's own console call crossed the wire as a log frame.
    const log = await out.expect("log");
    expect(log["message"]).toContain("terminal identity failed");

    send(child, { request: 1 });
    const echo = await out.expectKey("echo");
    expect(echo["echo"]).toEqual({ request: 1 });
  });

  test("reports a failing serve as an error frame, then closes", async () => {
    const { out, child } = await start();
    const helper = moduleUrl(
      `export async function serve() { throw new Error("admission failed"); }`
    );
    send(child, { type: "start", input: { modules: { helper } } });

    const error = await out.expect("error");
    expect(error["message"]).toBe("admission failed");
    await out.expect("closed");
  });

  test("answers close with closed after a successful serve", async () => {
    const { out, child } = await start();
    const helper = moduleUrl(
      `export async function serve() {
         return { receive: () => undefined, close: () => undefined };
       }`
    );
    send(child, { type: "start", input: { modules: { helper } } });
    await out.expect("ready");
    send(child, { type: "close" });
    await out.expect("closed");
    expect(out.seen.some((frame) => frame["type"] === "error")).toBe(false);
  });

  test("holds a request that arrives before serve finishes", async () => {
    const { out, child } = await start();
    const helper = moduleUrl(`
      export async function serve(_input, send) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return {
          receive: (message) => send({ handled: message.op }),
          close: () => undefined,
        };
      }
    `);
    // The owner's first requests can beat the import; they must not fail the link.
    send(child, { type: "start", input: { modules: { helper } } });
    send(child, { op: "identity" });
    await out.expect("ready");
    const handled = await out.expectKey("handled");
    expect(handled["handled"]).toBe("identity");
    expect(out.seen.some((frame) => frame["type"] === "error")).toBe(false);
  });
  test("keeps a frame's own type when it reaches the runtime", async () => {
    const { out, child } = await start();
    const helper = moduleUrl(`
      export async function serve(_input, send) {
        return {
          receive: (message) => send({ got: message.type ?? "none" }),
          close: () => undefined,
        };
      }
    `);
    send(child, { type: "start", input: { modules: { helper } } });
    await out.expect("ready");
    // `op` frames carry no type; `ready` and friends must not reach the runtime.
    send(child, { op: "identity" });
    const got = await out.expectKey("got");
    expect(got["got"]).toBe("none");
  });
});
