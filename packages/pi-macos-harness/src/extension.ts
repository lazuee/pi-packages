// Drives macOS apps through macos-harness, plus the run bookkeeping the harness needs.
//
// One tool, not eleven: every command takes --app and the loop is always
// read -> act -> read, so an action enum keeps the prompt small and the
// contract in one description.
//
// Signals map to pi's lifecycle as the harness expects them:
//   agent_start    -> turn-started   a run begins, calls are allowed again
//   agent_settled  -> turn-ended --cancel   nothing more will run
//   session_shutdown -> turn-ended --cancel  pi leaves, so the apps are let go
//
// It is agent_settled, not agent_end: agent_end also fires before a retry,
// compaction or queued work starts another run, and --cancel there kills an
// action the run still needs.

import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// Two calls share app state (read, act, read), so they must not interleave.
const ACTIONS = [
  "get_app_state",
  "click",
  "type_text",
  "press_key",
  "set_value",
  "paste",
  "scroll",
  "drag",
  "select_text",
  "perform_secondary_action",
  "list_apps",
] as const;

const harness = defineTool({
  name: "macos_harness",
  label: "macOS Harness",
  description: [
    "Read and operate an app's apps on this Mac by their real UI. Nothing comes to the front and the pointer does not move.",
    "get_state prints the element tree AND the screenshot of the window, so you see what you are aiming at rather than guessing.",
    "Every action is followed by a fresh read on its own: the result you get back is already the new state, with valid numbers. Do not guess what changed.",
  ].join(" "),
  promptSnippet: "Drive a macOS app's real UI (read, click, type, keys)",
  promptGuidelines: [
    "Use macos_harness when a task needs an app's UI and no CLI or API does it. Do not use osascript or System Events.",
    "Call get_state once before acting. After every action the tool returns the new state itself; read that result instead of assuming the action worked.",
    "Prefer element_index: it survives window moves and zoom. Add point to click an element's centre with raw events when an app ignores accessibility clicks.",
    "Use x/y only when a click by index does nothing, and take them from the screenshot that arrived with the read. A pixel with nothing under it is refused, so aim again rather than assume.",
    "x/y are PIXELS of that screenshot, whose size is printed with it, not points and not your guess at the layout.",
    "A menu or sheet renumbers every element in the window. Act from the most recent read only, never from numbers in an older one.",
  ],
  parameters: Type.Object({
    action: Type.Union(
      ACTIONS.map((a) => Type.Literal(a)) as [
        ReturnType<typeof Type.Literal>,
        ...ReturnType<typeof Type.Literal>[],
      ],
      {
        description:
          "What to do. get_app_state and list_apps read; the rest act and need a prior read.",
      },
    ),
    app: Type.Optional(
      Type.String({
        description:
          "App display name, path or bundle id. Required for everything except list_apps.",
      }),
    ),
    element_index: Type.Optional(
      Type.Number({
        description:
          "Element number from the most recent read. Indices change after every action.",
      }),
    ),
    point: Type.Optional(
      Type.Boolean({
        description:
          "With element_index: click its centre with raw events instead of the accessibility action. Use when an app ignores accessibility clicks.",
      }),
    ),
    x: Type.Optional(
      Type.Number({
        description:
          "Pixel x in the screenshot delivered with the last read (not screen points).",
      }),
    ),
    y: Type.Optional(
      Type.Number({ description: "Pixel y in the same screenshot." }),
    ),
    text: Type.Optional(
      Type.String({
        description: "Text for type_text, paste and select_text.",
      }),
    ),
    delay: Type.Optional(
      Type.Number({
        description:
          "type_text: seconds between keys, when an app needs a slower or a faster pace.",
      }),
    ),
    value: Type.Optional(
      Type.String({ description: "Whole new field text for set_value." }),
    ),
    key: Type.Optional(
      Type.String({
        description:
          "xdotool key names, e.g. Return, Tab, super+c. Case matters.",
      }),
    ),
    action_name: Type.Optional(
      Type.String({
        description:
          "Name printed after Secondary Actions: for perform_secondary_action.",
      }),
    ),
    direction: Type.Optional(
      Type.String({ description: "Scroll direction: up, down, left, right." }),
    ),
    pages: Type.Optional(
      Type.Number({ description: "Scroll amount in pages." }),
    ),
    selection_type: Type.Optional(
      Type.String({ description: "text, cursor_before or cursor_after." }),
    ),
    mouse_button: Type.Optional(
      Type.String({ description: "left, right or middle." }),
    ),
    click_count: Type.Optional(
      Type.Number({ description: "Click count, e.g. 2 to double-click." }),
    ),
    from_x: Type.Optional(Type.Number({ description: "Drag start x." })),
    from_y: Type.Optional(Type.Number({ description: "Drag start y." })),
    to_x: Type.Optional(Type.Number({ description: "Drag end x." })),
    to_y: Type.Optional(Type.Number({ description: "Drag end y." })),
    disable_diff: Type.Optional(
      Type.Boolean({
        description:
          "get_app_state: print the full tree instead of only what changed.",
      }),
    ),
  }),
  executionMode: "sequential",

  async execute(_id, p, signal, _onUpdate, _ctx) {
    const bin = cmd;
    if (!bin || !api)
      throw new Error(
        "macos-harness is not on PATH. Install it with: uv tool install --python 3.12 macos-harness",
      );

    const [runBin, runArgs] = withSession(bin, buildArgs(p));
    const r = await api.exec(runBin, runArgs, { signal, timeout: 120_000 });
    const out = `${r.stdout}${r.stderr}`.trim();
    // The harness says "call this tool again" for an index that went stale; pass that on.
    if (r.code !== 0)
      throw new Error(
        out || `macos-harness ${p.action} failed with exit ${r.code}`,
      );

    // A read is the answer by itself.
    if (p.action === "get_app_state") return readResult(out);
    if (p.action === "list_apps")
      return {
        content: [{ type: "text" as const, text: out || "Done." }],
        details: { action: p.action },
      };

    // An action's own output is just "Done", which says nothing about what it did.
    // Read the whole tree again, not a diff: a diff leaves unchanged elements out,
    // so only the full tree makes the next numbers trustworthy.
    // A failed read must not hide that the action succeeded.
    const [afterBin, afterArgs] = withSession(bin, [
      "get_app_state",
      "--app",
      String(p.app),
      "--disableDiff",
    ]);
    const after = await api
      .exec(afterBin, afterArgs, { timeout: 60_000 })
      .catch(() => null);
    if (after?.code === 0) {
      const state = await readResult(
        `${after.stdout}${after.stderr}`.trim(),
        400,
      );
      state.content.unshift({
        type: "text" as const,
        text: `Ran ${p.action}. New state:`,
      });
      return state;
    }
    return {
      content: [
        {
          type: "text" as const,
          text: `${out || "Done."}\n\nThe read after it failed, call get_app_state before the next action.`,
        },
      ],
      details: { action: p.action, app: p.app },
    };
  },
});

// Attach the screenshot the read wrote, so pixels can be aimed at instead of guessed.
// `maxLines` caps an automatic read: a long file list is mostly noise, the shot covers it.
async function readResult(out: string, maxLines?: number) {
  const shot = /^Screenshot \(\d+x\d+ px\): (.+)$/m.exec(out);
  const lines = out ? out.split("\n") : [];
  const cut = maxLines && lines.length > maxLines;
  const text = cut
    ? `${lines.slice(0, maxLines).join("\n")}\n… ${lines.length - maxLines} more lines: get_app_state shows them.`
    : out || "Nothing on screen.";
  const content: (
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  )[] = [{ type: "text", text }];
  if (shot && api) {
    const file = shot[1].trim();
    const b64 = await api
      .exec("base64", ["-i", file], { timeout: 20_000 })
      .catch(() => undefined);
    if (b64?.code === 0 && b64.stdout.trim()) {
      content.push({
        type: "image",
        data: b64.stdout.replace(/\s/g, ""),
        mimeType: "image/jpeg",
      });
    }
  }
  return { content, details: { action: "get_app_state" as const } };
}

// The tool runs outside the factory, so the extension api is handed over lazily.
let api: ExtensionAPI | undefined;
// The checkout, so a patch is live at once. Falls back to the installed tool.
// The bundled checkout, so a patch is live at once. Built from this file's own
// place, because the package can be installed anywhere. The installed tool is only
// a fallback for a machine without the checkout.
const SOURCE_BIN = fileURLToPath(
  new URL("../upstream/macos-harness", import.meta.url),
);

// Filled on session_start so a missing binary never breaks factory load.
let cmd: string | undefined;

// One key per pi session, so two sessions (a subagent, a second window) do not count
// as one agent: without it the harness falls back to the parent process, and one
// session's turn end would cancel the other's action and drop its app state.
let session: string | undefined;

/** pi.exec carries no env, so the key is prefixed onto the command instead. */
function withSession(
  bin: string,
  args: string[],
): [string, string[], { timeout?: number }?] {
  if (!session) return [bin, args];
  // export, because sh would otherwise not pass it to the binary it starts.
  return [
    "/bin/sh",
    [
      "-c",
      `export MACOS_HARNESS_SESSION='${session}'; exec "$0" "$@"`,
      bin,
      ...args,
    ],
  ];
}

export function buildArgs(p: Record<string, unknown>): string[] {
  const args = [String(p.action)];
  if (p.action === "list_apps") return args;

  // Every param is a string or a number, so a plain String() is the whole job.
  const put = (flag: string, v: unknown) => {
    if (typeof v === "string" && v !== "") args.push(flag, v);
    else if (typeof v === "number") args.push(flag, String(v));
  };
  put("--app", p.app);
  put("--element_index", p.element_index);
  put("--x", p.x);
  put("--y", p.y);
  put("--value", p.value);
  put("--delay", p.delay);
  put("--key", p.key);
  put("--action", p.action_name);
  put("--direction", p.direction);
  put("--pages", p.pages);
  put("--selection_type", p.selection_type);
  put("--mouse_button", p.mouse_button);
  put("--click_count", p.click_count);
  put("--from_x", p.from_x);
  put("--from_y", p.from_y);
  put("--to_x", p.to_x);
  put("--to_y", p.to_y);
  if (p.disable_diff) args.push("--disableDiff");
  if (p.point) args.push("--point");

  // --text takes the text exactly, newlines included; exec has no stdin to feed.
  const text = p.text as string | undefined;
  if (text) args.push("--text", text);
  return args;
}

export default function (pi: ExtensionAPI) {
  api = pi;
  let ready = false; // harness present and answering
  let inRun = false; // a turn-started we have not answered with a turn-ended

  // pi.exec does not throw on a non-zero exit, so the exit code is the only honest signal.
  async function call(...args: string[]): Promise<boolean> {
    if (!cmd) return false;
    try {
      const r = await pi.exec(cmd, args, { timeout: 5000 });
      return r.code === 0;
    } catch {
      return false;
    }
  }

  async function tell(ctx: ExtensionContext, ...args: string[]) {
    if (!ready || !cmd) return false;
    const ok = await call(...args);
    if (!ok && ctx.hasUI)
      ctx.ui.notify(`macos-harness ${args[0]} failed`, "warning");
    return ok;
  }

  pi.on("session_start", async (event, ctx) => {
    // Before the first call, so even doctor runs under this session's key.
    session = `${process.pid}-${Date.now().toString(36)}`;
    // The checkout first, so a local patch is live without a reinstall; the
    // installed tool is only a fallback for a machine without the source.
    cmd = undefined;
    for (const candidate of [SOURCE_BIN, null]) {
      const found = candidate
        ? await pi
            .exec("test", ["-x", candidate], { timeout: 3000 })
            .catch(() => undefined)
        : await pi
            .exec("which", ["macos-harness"], { timeout: 3000 })
            .catch(() => undefined);
      if (found?.code === 0) {
        cmd = candidate ?? (found.stdout.trim() || undefined);
        break;
      }
    }
    ready = false;
    if (cmd) ready = (await call("doctor")) || (await call("list_apps"));
    if (
      ready &&
      ctx.hasUI &&
      ctx.mode === "tui" &&
      event.reason === "startup"
    ) {
      ctx.ui.setStatus("macos-harness", "⌘ ready");
    }
  });

  pi.on("agent_start", async (_e, ctx) => {
    inRun = (await tell(ctx, "turn-started")) || inRun;
  });

  pi.on("agent_settled", async (_e, ctx) => {
    if (inRun) inRun = !(await tell(ctx, "turn-ended", "--cancel"));
  });

  pi.on("session_shutdown", async (_e, ctx) => {
    await tell(ctx, "turn-ended", "--cancel");
    inRun = false;
    session = undefined;
  });

  pi.registerTool(harness);
}
