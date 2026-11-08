// Drives desktop apps on macOS, Windows and Linux through agent-desktop, plus the
// run bookkeeping the CLI needs.
//
// One tool, not forty: agent-desktop exposes a wide CLI, but the loop is always
// read -> act -> read and every action takes `--app`. An action enum keeps the
// prompt small and the contract in one description.
//
// Refs are snapshot-scoped and positional ("@<snapshot_id>:eN"), so a ref from an
// older snapshot is stale by construction. Every action answers with a fresh
// snapshot, which renumbers everything — that is the point, and it is why the
// guidelines say to act only from the most recent result.
//
// Signals map to pi's lifecycle as the CLI expects them:
//   agent_start      -> session start   a run begins
//   agent_settled    -> session end     nothing more will run
//   session_shutdown -> session end     pi leaves, so the apps are let go
//
// It is agent_settled, not agent_end: agent_end also fires before a retry,
// compaction or queued work starts another run, and ending there kills an action
// the run still needs.

import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// Two calls share app state (read, act, read), so they must not interleave.
const ACTIONS = [
  "snapshot",
  "click",
  "type",
  "press",
  "set_value",
  "select",
  "scroll",
  "hover",
  "drag",
  "list_apps",
  "list_windows",
  "screenshot",
] as const;

// Actions that only read; the rest act and are followed by a fresh snapshot.
const READ_ACTIONS = new Set<string>([
  "snapshot",
  "list_apps",
  "list_windows",
  "screenshot",
]);

// Tool action -> CLI command, for the two that differ. Everything else is a
// plain dash-for-underscore swap, so it needs no entry.
const COMMANDS: Record<string, string> = { list_apps: "list-apps" };

const cli = defineTool({
  name: "agent_desktop",
  label: "Agent Desktop",
  description: [
    "Read and operate desktop apps on macOS, Windows and Linux by their native accessibility trees.",
    "snapshot prints the window's element tree with refs, so you see what you are aiming at rather than guessing.",
    "Every action is followed by a fresh snapshot on its own: the result you get back is already the new state, with valid refs. Do not guess what changed.",
    "It runs in the background by default: nothing moves the operator's pointer unless headed is set.",
  ].join(" "),
  promptSnippet: "Drive a desktop app's real UI on any OS (read, click, type)",
  promptGuidelines: [
    "Use agent_desktop when a task needs an app's UI and no CLI or API does it.",
    "Call snapshot once before acting. After every action the tool returns the new state itself; read that result instead of assuming the action worked.",
    "Act by ref (@e3, from the snapshot) wherever one exists; fall back to x/y only when no ref addresses the element.",
    "A menu, sheet or repaint renumbers every ref. Act from the most recent snapshot only, never from a ref in an older one.",
    "Check available_actions before choosing an action: click only what advertises Click. A bare text field advertises TypeText, not Click, so clicking it wastes a call in either mode - type into it, or set_value.",
    "Pass window_id from list_windows to pin one window. An app with two windows refuses as AMBIGUOUS_TARGET, and even with one visible window a second instance of the app can make an app-only target resolve to the other one.",
    "Headless is the default and never touches the operator's cursor. Pass headed true when an action needs the real pointer: hover and drag always do, and a click does when the element has no semantic delivery.",
    "Run `agent-desktop skills get desktop` in a shell before a long session; the skills are compiled into the binary, so they always match the installed version.",
  ],
  parameters: Type.Object({
    action: Type.Union(
      ACTIONS.map((a) => Type.Literal(a)) as [
        ReturnType<typeof Type.Literal>,
        ...ReturnType<typeof Type.Literal>[],
      ],
      {
        description:
          "What to do. snapshot and the list_* actions read; the rest act and need a prior snapshot.",
      },
    ),
    app: Type.Optional(
      Type.String({
        description:
          "Application name to scope the window. Required for everything except list_apps.",
      }),
    ),
    ref: Type.Optional(
      Type.String({
        description:
          "Element ref from the most recent snapshot, e.g. @e3. Preferred over x/y; press targets the focused window and takes none.",
      }),
    ),
    x: Type.Optional(
      Type.Number({
        description: "Pixel x, only when the element has no usable ref.",
      }),
    ),
    y: Type.Optional(Type.Number({ description: "Pixel y, same as x." })),
    text: Type.Optional(Type.String({ description: "Text for type." })),
    value: Type.Optional(
      Type.String({ description: "Whole new field text for set_value." }),
    ),
    key: Type.Optional(
      Type.String({
        description: 'Key chord for press, e.g. "cmd+s" or "Return".',
      }),
    ),
    direction: Type.Optional(
      Type.String({
        description: "Scroll direction: up, down, left, right.",
      }),
    ),
    amount: Type.Optional(
      Type.Number({ description: "Scroll amount in units (default 3)." }),
    ),
    from_x: Type.Optional(
      Type.Number({
        description:
          "Drag start x, with from_y; negative for a left-hand display.",
      }),
    ),
    from_y: Type.Optional(Type.Number({ description: "Drag start y." })),
    to_ref: Type.Optional(
      Type.String({
        description:
          "Destination ref for drag, e.g. @e7. Preferred over to_x/to_y.",
      }),
    ),
    to_x: Type.Optional(
      Type.Number({ description: "Drag end x, with to_y; negative allowed." }),
    ),
    to_y: Type.Optional(Type.Number({ description: "Drag end y." })),
    timeout_ms: Type.Optional(
      Type.Number({
        description:
          "Ref-resolution/actionability budget in milliseconds. Raise it for slow Chromium settles.",
      }),
    ),
    headed: Type.Optional(
      Type.Boolean({
        description:
          "Let the call use the real pointer. Off by default, so the extension never interrupts the operator's own cursor. hover and drag need it; so does a click on an element with no semantic delivery.",
      }),
    ),
    window_id: Type.Optional(
      Type.String({
        description:
          "Target one window by id from list_windows. Needed when an app name matches several windows, which the CLI otherwise refuses as AMBIGUOUS_TARGET.",
      }),
    ),
  }),
  executionMode: "sequential",

  async execute(_id, p, signal, _onUpdate, _ctx) {
    // A CLI installed or built mid-session is picked up here rather than needing
    // a restart; discovery is a no-op cost once it has succeeded.
    if (!cmd && rediscover) await rediscover();
    const bin = cmd;
    if (!bin || !api)
      throw new Error(
        "agent-desktop is not on PATH. Install it with: npm install -g agent-desktop",
      );

    const [runBin, runArgs] = withSession(bin, buildArgs(p));
    // Two actions have a positional the schema leaves optional, so name the
    // missing one here rather than let clap answer.
    if (p.action === "scroll" && !p.ref)
      throw new Error("scroll needs a ref from the snapshot, e.g. @e3");
    if (p.action === "type" && p.text === undefined)
      throw new Error(
        "type needs text; pass an empty string to insert nothing",
      );
    const r = await api.exec(runBin, runArgs, { signal, timeout: 120_000 });
    const out = `${r.stdout}${r.stderr}`.trim();
    // The CLI points at a re-snapshot for a ref that went stale; pass that on.
    if (r.code !== 0)
      throw new Error(
        out || `agent-desktop ${p.action} failed with exit ${r.code}`,
      );

    // A read is the answer by itself.
    if (READ_ACTIONS.has(String(p.action)))
      return {
        content: [{ type: "text" as const, text: out || "Nothing on screen." }],
        details: { action: p.action },
      };

    // An action's own output is just "Done", which says nothing about what it did.
    // Snapshot again rather than trust it, and let a failed read not hide success.
    const [afterBin, afterArgs] = withSession(bin, [
      "snapshot",
      "--app",
      String(p.app),
    ]);
    const after = await api
      .exec(afterBin, afterArgs, { timeout: 60_000 })
      .catch(() => null);
    if (after?.code === 0) {
      return {
        content: [
          { type: "text" as const, text: `Ran ${p.action}. New state:` },
          {
            type: "text" as const,
            text:
              `${after.stdout}${after.stderr}`.trim() || "Nothing on screen.",
          },
        ],
        details: { action: p.action, app: p.app },
      };
    }
    return {
      content: [
        {
          type: "text" as const,
          text: `${out || "Done."}\n\nThe snapshot after it failed; call snapshot before the next action.`,
        },
      ],
      details: { action: p.action, app: p.app },
    };
  },
});

// The tool runs outside the factory, so the extension api is handed over lazily.
let api: ExtensionAPI | undefined;
// Likewise discovery: the tool retries it on a call if session start found no CLI.
let rediscover: (() => Promise<boolean>) | undefined;
// The bundled checkout wins so a local patch is live at once; the installed CLI
// is the fallback for a machine without the source.
const SOURCE_BIN = fileURLToPath(
  new URL("../upstream/npm/bin/agent-desktop", import.meta.url),
);

// Filled on session_start so a missing binary never breaks factory load.
let cmd: string | undefined;

// One id per pi session, so two sessions (a subagent, a second window) do not
// count as one agent: without it the CLI falls back to the parent process, and
// one session's end would release apps the other is still driving.
let session: string | undefined;

/** pi.exec carries no env, so the id is prefixed onto the command instead. */
function withSession(bin: string, args: string[]): [string, string[]] {
  if (!session) return [bin, args];
  // export, because sh would otherwise not pass it to the binary it starts.
  return [
    "/bin/sh",
    [
      "-c",
      `export AGENT_DESKTOP_SESSION='${session}'; exec "$0" "$@"`,
      bin,
      ...args,
    ],
  ];
}

/** The CLI spells commands with dashes; the tool spells them with underscores. */
export function buildArgs(p: Record<string, unknown>): string[] {
  const action = String(p.action);
  const command =
    action === "list_apps"
      ? "list-apps"
      : (COMMANDS[action] ?? action.replace(/_/g, "-"));
  const args = [command];
  const ref = p.ref as string | undefined;
  const text = p.text as string | undefined;
  const key = p.key as string | undefined;
  const value = p.value as string | undefined;

  // Scroll is a ref command: a direction and an amount, not a wheel event. Only
  // `mouse-wheel` is coordinate-based, and scroll does not use it.
  if (action === "scroll") {
    if (ref) args.push(ref);
    putEq(args, "--direction", p.direction);
    putEq(args, "--amount", p.amount);
    put(args, "--timeout-ms", p.timeout_ms);
    return args;
  }

  if (action === "list_apps") return args;

  // hover and drag are the only actions that *must* move the cursor, and headless
  // delivery refuses them, so they are inert without this. It is opt-in, so the
  // extension never yanks the cursor of someone typing elsewhere.
  //
  // It is also honoured on the other actions, because the CLI falls back to a
  // physical click for an element with no semantic delivery (a bare text field
  // advertises TypeText but not Click) and refuses instead of trying. Which
  // elements those are cannot be known before the call, so the caller decides.
  if (p.headed) args.push("--headed");
  // Also global. Two windows of one app are indistinguishable by name, and the
  // CLI refuses that as AMBIGUOUS_TARGET rather than guessing.
  put(args, "--window-id", p.window_id);
  // A ref spares the pointer a coordinate round trip, and hover takes it as a
  // positional computed before any flag.
  if (action === "hover") {
    if (ref) args.push(ref);
    const xy = coords(p.x, p.y);
    if (xy) putEq(args, "--xy", xy);
    put(args, "--timeout-ms", p.timeout_ms);
    return args;
  }
  // Drag endpoints are refs where there is one, coordinates otherwise.
  if (action === "drag") {
    const toRef = p.to_ref as string | undefined;
    if (ref) put(args, "--from", ref);
    else {
      const from = coords(p.from_x, p.from_y);
      if (from) putEq(args, "--from-xy", from);
    }
    if (toRef) put(args, "--to", toRef);
    else {
      const to = coords(p.to_x, p.to_y);
      if (to) putEq(args, "--to-xy", to);
    }
    put(args, "--timeout-ms", p.timeout_ms);
    return args;
  }

  // A ref carries its own source window, so the ref commands take no --app and
  // would reject one. Press is the exception: its only positional is COMBO, so
  // it targets the focused window unless --app names one.
  if (action === "press") {
    putEq(args, "--app", p.app);
    // Flags go before `--`, which ends flag parsing: a combo can be a bare "--5".
    if (key) args.push("--", key);
    return args;
  }

  // The remaining read commands scope by --app.
  if (READ_ACTIONS.has(action)) {
    putEq(args, "--app", p.app);
    return args;
  }

  // The ref precedes TEXT/VALUE, which is the order the CLI declares. `--` then
  // ends flag parsing, because a typed or selected value can itself begin with a
  // hyphen (a menu item, a field seeded "--headed"); without it clap eats one as
  // a flag and the value is lost.
  if (ref) args.push(ref);
  put(args, "--timeout-ms", p.timeout_ms);
  if (action === "type" && text !== undefined) args.push("--", text);
  if ((action === "set_value" || action === "select") && value !== undefined)
    args.push("--", value);
  return args;
}

/** The CLI takes a whole point as one "x,y" argument, not two. */
function coords(x: unknown, y: unknown): string | undefined {
  return typeof x === "number" && typeof y === "number"
    ? `${x},${y}`
    : undefined;
}

// Every param is a string or a number, so a plain String() is the whole job.
function put(args: string[], flag: string, v: unknown): void {
  if (typeof v === "string" && v !== "") args.push(flag, v);
  else if (typeof v === "number") args.push(flag, String(v));
}

/**
 * Like `put`, but joins with `=`. A value that starts with `-` (a negative
 * coordinate, so any left-hand display) is otherwise read as a flag.
 */
function putEq(args: string[], flag: string, v: unknown): void {
  if (typeof v === "string" && v !== "") args.push(`${flag}=${v}`);
  else if (typeof v === "number") args.push(`${flag}=${v}`);
}

export default function (pi: ExtensionAPI) {
  api = pi;
  let ready = false; // CLI present and answering
  let inRun = false; // a session start we have not answered with an end
  // pi.exec does not throw on a non-zero exit, so the exit code is the only
  // honest signal.
  async function call(...args: string[]): Promise<boolean> {
    if (!cmd) return false;
    const [runBin, runArgs] = withSession(cmd, args);
    try {
      const r = await pi.exec(runBin, runArgs, { timeout: 5000 });
      return r.code === 0;
    } catch {
      return false;
    }
  }

  async function tell(ctx: ExtensionContext, ...args: string[]) {
    if (!ready || !cmd) return false;
    const ok = await call(...args);
    if (!ok && ctx.hasUI)
      ctx.ui.notify(`agent-desktop ${args[0]} ${args[1]} failed`, "warning");
    return ok;
  }

  // A candidate must answer, not merely exist: the checkout's bin is a Node
  // launcher that is always executable and dies on the native binary missing
  // beside it, so accepting it on mode alone never reaches the PATH fallback.
  async function probe(bin: string): Promise<boolean> {
    // The tool list is the real question, not just that the binary loads.
    const [runBin, runArgs] = withSession(bin, ["list-apps"]);
    try {
      const r = await pi.exec(runBin, runArgs, { timeout: 5000 });
      return r.code === 0;
    } catch {
      return false;
    }
  }

  // Discovery runs at session start, and again on a call if that found nothing:
  // a CLI installed or built mid-session should not need a Pi restart. It is
  // cheap in the broken case and free once `cmd` is set.
  async function discover(): Promise<boolean> {
    if (cmd) return true;
    const found = await pi
      .exec("which", ["agent-desktop"], { timeout: 3000 })
      .catch(() => undefined);
    const onPath =
      found?.code === 0 ? found.stdout.trim() || undefined : undefined;
    for (const candidate of [SOURCE_BIN, onPath]) {
      if (!candidate) continue;
      if (await probe(candidate)) {
        cmd = candidate;
        break;
      }
    }
    ready = !!cmd;
    return ready;
  }
  rediscover = discover;

  pi.on("session_start", async (event, ctx) => {
    // Before the first call, so even the probe runs under this session's id.
    session = `${process.pid}-${Date.now().toString(36)}`;
    cmd = undefined;
    const found = await discover();
    if (
      found &&
      ctx.hasUI &&
      ctx.mode === "tui" &&
      event.reason === "startup"
    ) {
      ctx.ui.setStatus("agent-desktop", "🖥 ready");
    }
  });

  pi.on("agent_start", async (_e, ctx) => {
    // --cursor turns on the visual cursor overlay: it draws where actions land
    // and never replaces the pointer. A platform without a renderer answers
    // rendered:false instead of failing, so it is asked for unconditionally.
    inRun = (await tell(ctx, "session", "start", "--cursor")) || inRun;
  });

  pi.on("agent_settled", async (_e, ctx) => {
    if (inRun) inRun = !(await tell(ctx, "session", "end"));
  });

  pi.on("session_shutdown", async (_e, ctx) => {
    await tell(ctx, "session", "end");
    inRun = false;
    session = undefined;
  });

  pi.registerTool(cli);
}
