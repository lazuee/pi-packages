// Core owns this private terminal. Nothing touches stdout before attachment.
const bootstrap = JSON.parse(
  Buffer.from(String(process.argv[1]), "base64").toString()
);
const { focusWire } = await import(bootstrap.wire);
/** @type {{close:()=>Promise<void>,receive:(message:unknown,undecided?:true)=>void} | undefined} */
let runtime;
// Requests can beat `serve`; they wait here rather than failing the connection.
/** @type {unknown[]} */
let queued = [];
let starting = false;
let stopped = false;
/** @param {Error} [error] */
async function stop(error) {
  if (stopped) return;
  stopped = true;
  if (error) {
    try {
      wire.send({ type: "error", message: error.message });
    } catch {}
  }
  // Cleanup must finish before a replacement publishes the same context path.
  const deadline = setTimeout(() => process.exit(1), 8000);
  deadline.unref();
  try {
    await runtime?.close();
    try {
      wire.send({ type: "closed" });
    } catch {}
  } finally {
    wire.close();
    process.stdin.destroy();
    process.stdout.end(() => process.exit(error ? 1 : 0));
  }
}
// The wire owns stdout, but a PTY merges stderr into it, so imported modules
// logging mid-frame would otherwise reach the owner as raw text.
for (const level of /** @type {const} */ (["log", "error", "warn", "info"]))
  console[level] = (/** @type {unknown[]} */ ...args) => {
    try {
      wire.send({ type: "log", message: args.map(String).join(" ") });
    } catch {}
  };
const wire = focusWire(
  bootstrap.nonce,
  (/** @type {Buffer} */ bytes) => {
    if (process.stdout.writableLength + bytes.length > 1024 * 1024)
      throw new Error("Remote connection output exceeded its buffer");
    process.stdout.write(bytes);
  },
  (/** @type {any} */ value) => {
    if (value?.type === "close") {
      void stop();
      return;
    }
    if (value?.type === "start" && !starting) {
      starting = true;
      void import(value.input.modules.helper)
        .then(async ({ serve }) => {
          const served = await serve(
            value.input,
            (/** @type {unknown} */ message) => wire.send(message),
            stop
          );
          if (stopped) {
            await served.close();
            return;
          }
          runtime = served;
          wire.send({ type: "ready" });
          // Nothing more waits once served; a backlog is small and bounded above.
          for (const pending of queued) served.receive(pending);
          queued = [];
        })
        .catch(stop);
    } else if (value?.type === "log" || value?.type === "ready") {
      /* the owner logs its own diagnostics; neither is a request */
    } else if (runtime) runtime.receive(value);
    else if (queued.length < 64) queued.push(value);
    else throw new Error("Remote connection is not ready");
  },
  stop,
  undefined,
  { maxMessageBytes: 8 * 1024 * 1024, maxQueuedBytes: 24 * 1024 * 1024 }
);
// A PTY is the normal case; a pipe has no raw mode to set.
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on("data", (/** @type {Buffer} */ bytes) => wire.push(bytes));
process.stdin.on("error", () => stop().catch(() => null));
process.stdin.on("end", () => {
  /* empty */
});
process.stdout.on("error", () => stop().catch(() => null));
process.on("SIGTERM", () => {
  /* empty */
});
process.on("SIGHUP", () => {
  /* empty */
});
