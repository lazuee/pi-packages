import { describe, expect, test } from "bun:test";

import { focusWire } from "../src/core/focus-channel-wire.mjs";

type Handle = ReturnType<typeof focusWire>;

/** Wire pair over shared buffers; traffic is pumped after send so both ends exist first. */
function pair(nonce = "nonce") {
  const errors: string[] = [];
  const received: unknown[] = [];
  const fromA: Buffer[] = [];
  const fromB: Buffer[] = [];
  const fail = (message: string) => errors.push(message);
  const a = focusWire(
    nonce,
    (bytes: Buffer) => fromA.push(bytes),
    (message: unknown) => received.push(message),
    (error: Error) => fail(error.message),
    () => {}
  );
  const b = focusWire(
    nonce,
    (bytes: Buffer) => fromB.push(bytes),
    (message: unknown) => received.push(message),
    (error: Error) => fail(error.message),
    () => {}
  );
  const pump = () => {
    while (fromA.length) b.push(fromA.shift()!);
    while (fromB.length) a.push(fromB.shift()!);
  };
  const send = async (message: unknown) => {
    a.send(message);
    // Deliver, then let the acknowledgement travel back so the window reopens.
    for (let round = 0; round < 20; round += 1) {
      pump();
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  };
  return { a, b, received, errors, send };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 15));

describe("focus wire framing", () => {
  test("round-trips a message carrying control bytes and delimiters", async () => {
    const { a, b, received, errors, send } = pair();
    const payload = {
      type: "data",
      message: {
        text: '\x1b[1mbold\x1b[0m\nline "q" \\ back ! bang\ttab\x00nul',
      },
    };
    await send(payload);
    expect(errors).toEqual([]);
    expect(received).toEqual([payload]);
    a.close();
    b.close();
  });

  test("round-trips every single byte value", async () => {
    const { a, b, received, errors, send } = pair();
    const raw = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
    await send({ type: "data", message: { raw: raw.toString("latin1") } });
    expect(errors).toEqual([]);
    const [frame] = received as { message: { raw: string } }[];
    expect(Buffer.from(frame!.message.raw, "latin1").equals(raw)).toBe(true);
    a.close();
    b.close();
  });

  test("still accepts a base64 frame from an older peer", async () => {
    const live: string[] = [];
    const wire = focusWire(
      "n",
      () => {},
      () => {},
      () => {},
      () => live.push("live")
    );
    const body = Buffer.from(JSON.stringify({ ping: true })).toString("base64");
    wire.push(Buffer.from(`!n!${body}!\n`));
    expect(live).toEqual(["live"]);
    wire.close();
  });

  test("accepts an escaped frame and acknowledges it", async () => {
    const written: string[] = [];
    const received: unknown[] = [];
    const wire = focusWire(
      "n",
      (bytes: Buffer) => written.push(bytes.toString("latin1")),
      (message: unknown) => received.push(message),
      () => {}
    );
    wire.push(Buffer.from(`!n!{"n":1,"data":"{\\"a\\":1}","end":true}!\n`));
    expect(received).toEqual([{ a: 1 }]);
    expect(written.join("")).toContain('"ack":1');
    wire.close();
  });

  test("rejects an out-of-order acknowledgement", async () => {
    const errors: string[] = [];
    const wire = focusWire(
      "n",
      () => {},
      () => {},
      (error: Error) => errors.push(error.message)
    );
    wire.push(Buffer.from(`!n!{"ack":5}!\n`));
    expect(errors[0]).toContain("out of order");
    wire.close();
  });
});

describe("focus wire flow control", () => {
  test("holds a large burst back without withholding acknowledgements", async () => {
    const { a, b, received, errors, send } = pair();
    // Far more than one window of chunks.
    await send({ type: "data", message: { text: "x".repeat(400_000) } });
    expect(errors).toEqual([]);
    expect(received.length).toBe(1);
    a.close();
    b.close();
  });

  test("keeps more than four chunks in flight before an acknowledgement", async () => {
    const frames: string[] = [];
    // Standalone sender: every frame is recorded, nothing acknowledges it.
    const sender = focusWire(
      "n",
      (bytes: Buffer) => {
        frames.push(bytes.toString("latin1"));
      },
      () => {},
      () => {}
    );
    sender.send({ type: "data", message: { text: "y".repeat(8 * 1024 * 8) } });
    await new Promise((resolve) => setTimeout(resolve, 40));
    // Frames may pack several chunks; the point is the byte total in flight.
    const bytes = frames.reduce((total, frame) => total + frame.length, 0);
    expect(bytes).toBeGreaterThan(4 * 8 * 1024);
    sender.close();
  });

  test("packs a burst of small messages into one frame", async () => {
    const frames: string[] = [];
    const sender = focusWire(
      "n",
      (bytes: Buffer) => {
        frames.push(bytes.toString("latin1"));
      },
      () => {},
      () => {}
    );
    for (let index = 0; index < 200; index += 1)
      sender.send({ type: "data", message: { row: index, text: "x" } });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(frames.length).toBeLessThan(4);
    sender.close();
  });

  test("refuses a message over its size limit", () => {
    const errors: string[] = [];
    const wire = focusWire(
      "n",
      () => {},
      () => {},
      (error: Error) => errors.push(error.message),
      () => {},
      { maxMessageBytes: 64 }
    );
    expect(() =>
      wire.send({ type: "data", message: { text: "z".repeat(200) } })
    ).toThrow(/size limit/);
    expect(errors[0]).toContain("size limit");
    wire.close();
  });
  test("keeps messages intact across packed and spanning frames", async () => {
    const { a, b, received, errors, send } = pair();
    const big = "x".repeat(20_000);
    const tail = "y".repeat(30_000);
    await send({ type: "data", message: { big } });
    for (let index = 0; index < 5; index += 1)
      await send({ type: "data", message: { index } });
    await send({ type: "data", message: { tail } });
    const frames = received as {
      message: { big?: string; tail?: string; index?: number };
    }[];
    expect(errors).toEqual([]);
    expect(frames[0]!.message.big).toBe(big);
    expect(frames.at(-1)!.message.tail).toBe(tail);
    a.close();
    b.close();
  });
  test("keeps send offsets separate from received bytes", async () => {
    // A peer that both reads and writes must not let reads shift its send offsets.
    const { a, b, received, errors, send } = pair();
    await send({ type: "data", message: { first: "a".repeat(4000) } });
    const before = received.length;
    await send({ type: "data", message: { second: "b" } });
    expect(errors).toEqual([]);
    expect(received.length).toBe(before + 1);
    expect(
      (received.at(-1) as { message: { second: string } }).message.second
    ).toBe("b");
    a.close();
    b.close();
  });
  test("passes a helper log frame without breaking the stream", async () => {
    const { a, b, received, errors, send } = pair();
    b.push(Buffer.from(`!nonce!{"type":"log","message":"helper said"}!\n`));
    await send({ type: "data", message: { after: true } });
    expect(errors).toEqual([]);
    expect(received).toContainEqual({
      type: "log",
      message: "helper said",
      undecided: true,
    });
    expect(received.at(-1)).toEqual({ type: "data", message: { after: true } });
    a.close();
    b.close();
  });
  test("keeps a message whole when a log frame lands beside it", async () => {
    const { a, b, received, errors, send } = pair();
    const text = "w".repeat(30_000);
    await send({ type: "data", message: { text } });
    const logs = () =>
      received.filter((value) => (value as { type?: string }).type === "log");
    b.push(Buffer.from(`!nonce!{"type":"log","message":"mid"}!\n`));
    const frame = received.find(
      (value) =>
        "message" in (value as object) &&
        typeof (value as { message: unknown }).message === "object"
    ) as { message: { text: string } };
    await settle();
    // A log line between the chunks of one message must not renumber the stream.
    expect(errors).toEqual([]);
    expect(frame.message.text).toBe(text);
    expect(logs().length).toBe(1);
    a.close();
    b.close();
  });
  test("does not mistake a typed frame carrying n for a chunk", async () => {
    const { a, b, received, errors, send } = pair();
    b.push(Buffer.from(`!nonce!{"type":"log","n":7,"message":"counted"}!\n`));
    await send({ type: "data", message: { after: true } });
    expect(errors).toEqual([]);
    expect(received).toContainEqual({
      type: "log",
      n: 7,
      message: "counted",
      undecided: true,
    });
    a.close();
    b.close();
  });
  test("rejects a helper error frame through fail", async () => {
    const errors: string[] = [];
    const wire = focusWire(
      "n",
      () => {},
      (message: unknown) => {
        // As the owners dispatch it: the frame's own message is the failure.
        const { message: detail } = message as { message: string };
        throw new Error(detail);
      },
      (error: Error) => errors.push(error.message),
      () => {}
    );
    wire.push(
      Buffer.from(`!n!{"type":"error","message":"admission failed"}!\n`)
    );
    await settle();
    expect(errors).toEqual(["admission failed"]);
    wire.close();
  });
  test("hands up a kind the owner did not name instead of failing", async () => {
    const { a, b, received, errors, send } = pair();
    // A future control frame must reach its owner rather than fail the stream.
    b.push(Buffer.from(`!nonce!{"type":"start"}!\n`));
    await send({ type: "data", message: { after: true } });
    expect(errors).toEqual([]);
    expect(received).toContainEqual({ type: "start", undecided: true });
    a.close();
    b.close();
  });
});
