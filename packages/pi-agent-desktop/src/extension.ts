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
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

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
  "mouse_click",
  "find",
  "right_click",
  "double_click",
  "toggle",
  "check",
  "uncheck",
  "expand",
  "collapse",
  "clear",
  "focus",
  "scroll_to",
  "wait",
  "launch",
  "close_app",
  "focus_window",
  "maximize",
  "minimize",
  "restore",
  "move_window",
  "resize_window",
  "triple_click",
  "list_apps",
  "list_windows",
  "list_displays",
  "list_surfaces",
  "clipboard_get",
  "clipboard_set",
  "clipboard_clear",
  "screenshot",
  "get",
  "is",
] as const;

// Actions that only read; the rest act and are followed by a fresh snapshot.
const READ_ACTIONS = new Set<string>([
  "snapshot",
  "find",
  "list_surfaces",
  "clipboard_get",
  "list_displays",
  "list_apps",
  "list_windows",
  "screenshot",
  "get",
  "is",
]);

// Tool action -> CLI command, for the two that differ. Everything else is a
// plain dash-for-underscore swap, so it needs no entry.
const COMMANDS: Record<string, string> = {
  list_apps: "list-apps",
  mouse_click: "mouse-click",
  right_click: "right-click",
  scroll_to: "scroll-to",
  double_click: "double-click",
  close_app: "close-app",
  focus_window: "focus-window",
  triple_click: "triple-click",
  move_window: "move-window",
  resize_window: "resize-window",
  list_displays: "list-displays",
  list_surfaces: "list-surfaces",
  clipboard_get: "clipboard-get",
  clipboard_set: "clipboard-set",
  clipboard_clear: "clipboard-clear",
};

const cli = defineTool({
  name: "agent_desktop",
  label: "Agent Desktop",
  description: [
    "Read and operate desktop apps on macOS, Windows and Linux by their native accessibility trees.",
    "snapshot prints the window's element tree with refs, so you see what you are aiming at rather than guessing.",
    "Map before you act: snapshot with skeleton (and compact, interactive_only) is about a tenth the size and still lists the interactive refs; drill a region with root rather than re-reading the whole window.",
    "Every action is followed by a fresh snapshot on its own: the result you get back is already the new state, with valid refs. Do not guess what changed.",
    "It runs in the background by default: nothing moves the operator's pointer unless headed is set.",
  ].join(" "),
  promptSnippet: "Drive a desktop app's real UI on any OS (read, click, type)",
  promptGuidelines: [
    "Use agent_desktop when a task needs an app's UI and no CLI or API does it.",
    "Call snapshot once before acting. After every action the tool returns the new state itself; read that result instead of assuming the action worked.",
    "Act by ref (@e3) wherever one exists; without one, use its `at` with mouse-click, which is the only click that takes x/y.",
    "Every result is plain text, so read it directly: get reads one property of a ref and is checks one state. get bounds gives exact points, which beats a pixel estimated from a screenshot.",
    "is answering 'not applicable' means the element has no such state; that is not the same as false.",
    "A menu, sheet or repaint renumbers every ref. Act from the most recent snapshot only, never from a ref in an older one.",
    "Check available_actions before choosing an action: click only what advertises Click. A bare text field advertises TypeText, not Click, so clicking it wastes a call in either mode - type into it, or set_value.",
    "Pass window_id from list_windows to pin one window, for snapshot, screenshot and press only. An app with two windows refuses as AMBIGUOUS_TARGET, and even with one visible window a second instance of the app can make an app-only target resolve to the other one.",
    "Headless is the default and never touches the operator's cursor. Pass headed true when an action needs the real pointer: hover and drag always do, and a click does when the element has no semantic delivery.",
    "Run `agent-desktop skills get desktop` in a shell before a long session; the skills are compiled into the binary, so they always match the installed version.",
    "A node with neither a ref nor an `at` cannot be addressed: snapshot again with include_bounds for x/y, or use its keyboard shortcut.",
    "To find a known word use find, which searches name, value and title without a tree; after an async step use wait with wait_text rather than a fixed pause.",
    "launch opens an app and waits for a window, so a cold session can start; close_app quits one, focus_window brings a window forward, and maximize/minimize/restore/move_window/resize_window place one (they take window_id, not a ref). clipboard_set/get/clear move text in and out of the system clipboard; on a Homebrew install they refuse with ACTION_NOT_SUPPORTED because the helper sits under a group-writable /opt/homebrew/lib; chmod g-w /opt/homebrew/lib once fixes it, and a copy of the package on a clean path works meanwhile. toggle, check, uncheck, expand, collapse, clear, focus, scroll_to, right_click, double_click and triple_click are all covered; prefer them over a click on the same element. double_click needs the window frontmost and takes no window_id, so focus-window or a click first. scroll_to refuses a node inside a sheet (visibility cannot be verified), so click it instead.",
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
    property: Type.Optional(
      Type.String({
        description:
          "get: text (what a person reads), value, title, bounds, role, states. is: visible, enabled, checked, focused, expanded, selected. bounds is exact points, so it beats a pixel read off a screenshot.",
      }),
    ),
    text: Type.Optional(
      Type.String({
        description: "Text for type, or the text clipboard_set writes.",
      }),
    ),
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
          "Target one window by id from list_windows, for an app with several. Only snapshot, screenshot and press take it; a ref already names its own window, so it is rejected with a ref.",
      }),
    ),
    include_bounds: Type.Optional(
      Type.Boolean({
        description:
          "snapshot only: also report bounds, so a node that got no ref is still reachable by x/y. Adds about half again to the payload, so pass it when a snapshot showed a ref-less element you need.",
      }),
    ),
    skeleton: Type.Optional(
      Type.Boolean({
        description:
          "snapshot only: a shallow overview, with `+n` on the containers it cut. Only cuts a page deeper than the depth limit, so pair it with interactive_only.",
      }),
    ),
    compact: Type.Optional(
      Type.Boolean({
        description:
          "snapshot only: collapse single-child unnamed wrappers, which is most of a web tree's depth.",
      }),
    ),
    interactive_only: Type.Optional(
      Type.Boolean({
        description:
          "snapshot only: interactive elements only, dropping static text. The lever that always shrinks a tree; leave it off to tell which row a repeated button belongs to.",
      }),
    ),
    root: Type.Optional(
      Type.String({
        description:
          "snapshot only: start at this ref instead of the window root, to read one region. Refs outside it stay valid.",
      }),
    ),
    query: Type.Optional(
      Type.String({
        description:
          "find only: match by text across name, value, title and description. find is the cheap way to locate an element when you know its words, without dumping a tree.",
      }),
    ),
    role: Type.Optional(
      Type.String({ description: "find only: match by accessibility role." }),
    ),
    wait_ms: Type.Optional(
      Type.Number({
        description:
          "wait only: pause this many milliseconds. A fixed sleep is a race; prefer wait_text, which returns as soon as the text appears.",
      }),
    ),
    wait_text: Type.Optional(
      Type.String({
        description:
          "wait only: block until this text appears in the app's tree, then return. The reliable form after an async step.",
      }),
    ),
    width: Type.Optional(
      Type.Number({ description: "resize_window only: new width in points." }),
    ),
    height: Type.Optional(
      Type.Number({ description: "resize_window only: new height in points." }),
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
    // The single-ref actions would otherwise reach clap with no positional.
    if (ONE_REF.has(String(p.action)) && !p.ref)
      throw new Error(`${p.action} needs a ref from the snapshot, e.g. @e3`);
    if (p.action === "double_click" && !p.ref)
      throw new Error("double_click needs a ref from the snapshot, e.g. @e3");
    if (p.action === "find" && !p.query && !p.role)
      throw new Error("find needs a query (text) or a role to match");
    if (p.action === "triple_click" && !p.ref)
      throw new Error("triple_click needs a ref from the snapshot, e.g. @e3");
    if ((p.action === "launch" || p.action === "close_app") && !p.app)
      throw new Error(`${p.action} needs an app name`);
    if (
      (p.action === "focus_window" || WINDOW_GEOMETRY.has(String(p.action))) &&
      !p.window_id &&
      !p.app
    )
      throw new Error(`${p.action} needs a window_id or an app`);
    if (p.action === "move_window" && (p.x == null || p.y == null))
      throw new Error("move_window needs x and y in points");
    if (p.action === "resize_window" && (p.width == null || p.height == null))
      throw new Error("resize_window needs width and height in points");
    if (p.action === "wait" && !p.wait_text && typeof p.wait_ms !== "number")
      throw new Error("wait needs wait_text, or wait_ms as a fixed pause");
    if (p.action === "clipboard_set" && p.text === undefined)
      throw new Error("clipboard_set needs text to put on the clipboard");
    if (p.action === "mouse_click" && !coords(p.x, p.y))
      throw new Error(
        "mouse_click needs x and y; take them from an `at` line, the center being x+width/2, y+height/2",
      );
    if ((p.action === "get" || p.action === "is") && !p.ref)
      throw new Error(`${p.action} needs a ref from the snapshot, e.g. @e3`);
    if (p.action === "type" && p.text === undefined)
      throw new Error(
        "type needs text; pass an empty string to insert nothing",
      );
    // Both take VALUE as a required positional, so an omission would otherwise
    // reach clap and come back as an INVALID_ARGS envelope.
    if (
      (p.action === "set_value" || p.action === "select") &&
      p.value === undefined
    )
      throw new Error(
        p.action === "select"
          ? "select needs the option value to pick"
          : "set_value needs a value; pass an empty string to clear it",
      );
    const r = await api.exec(runBin, runArgs, { signal, timeout: 120_000 });
    const out = `${r.stdout}${r.stderr}`.trim();
    // minimize and restore verify through an AX read that times out when the
    // window goes away, so they report failure for an action that landed. Confirm
    // with list-windows before believing the error.
    if (r.code !== 0 && WINDOW_VISIBILITY.has(String(p.action))) {
      const landed = await windowMinimized(bin, p.window_id, signal);
      if (landed === (p.action === "minimize"))
        return {
          content: [
            {
              type: "text" as const,
              text: `Ran ${p.action}. The window is now ${
                landed ? "minimized" : "restored"
              }; the CLI's own verification read timed out, and this was confirmed with list_windows.\n\nCall snapshot before the next action.`,
            },
          ],
          details: { action: p.action, app: p.app },
        };
    }
    if (r.code !== 0) throw new Error(cliError(out, p.action, r.code));

    // A read is the answer by itself.
    if (READ_ACTIONS.has(String(p.action)))
      return {
        content:
          p.action === "screenshot"
            ? shotContent(out)
            : [{ type: "text" as const, text: render(out) }],
        details: { action: p.action },
      };

    // An action's own output is just "Done", which says nothing about what it did.
    // Snapshot again rather than trust it, and let a failed read not hide success.
    const [afterBin, afterArgs] = withSession(bin, afterSnapshot(p));
    const after = await api
      .exec(afterBin, afterArgs, { timeout: 60_000 })
      .catch(() => null);
    if (after?.code === 0) {
      return {
        content: [
          { type: "text" as const, text: `Ran ${p.action}. New state:` },
          {
            type: "text" as const,
            text: render(`${after.stdout}${after.stderr}`.trim()),
          },
        ],
        details: { action: p.action, app: p.app },
      };
    }
    return {
      content: [
        {
          type: "text" as const,
          // Closing an app has nothing left to snap, so say what happened rather
          // than report a failure the caller cannot act on.
          text: `${render(out)}${
            p.action === "close_app"
              ? "\n\nThe app is closed, so there is no snapshot to take."
              : "\n\nThe snapshot after it failed; call snapshot before the next action."
          }`,
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
/**
 * The snapshot taken after an action, to show what the action did.
 *
 * It repeats the window the action was pinned to: without that it is the app
 * only, which an app with two windows refuses, so a window-scoped action would
 * report success and then look like it broke.
 */
/**
 * Whether `list-windows` says the named window is minimized, or undefined when
 * the window is gone or the read fails. Only used to tell an action that landed
 * from one that did not.
 *
 * The listing has no `minimized` field; a minimized window is reported
 * `visible: false` instead.
 */
async function windowMinimized(
  bin: string,
  windowId: unknown,
  signal: AbortSignal | undefined,
): Promise<boolean | undefined> {
  const [listBin, listArgs] = withSession(bin, ["list-windows"]);
  try {
    const r = await api?.exec(listBin, listArgs, { signal, timeout: 10_000 });
    if (r?.code !== 0) return undefined;
    const windows =
      (
        JSON.parse(r.stdout) as {
          data?: { id?: string; visible?: boolean }[];
        }
      ).data ?? [];
    const visible = windows.find((w) => w.id === windowId)?.visible;
    return visible === undefined ? undefined : !visible;
  } catch {
    return undefined;
  }
}

export function afterSnapshot(p: Record<string, unknown>): string[] {
  const window = p.window_id;
  return [
    "snapshot",
    "--app",
    String(p.app),
    ...(typeof window === "string" && window ? ["--window-id", window] : []),
  ];
}

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

/**
 * The screenshot payload, nested under the CLI's `data` envelope field.
 *
 * The CLI wraps every result as `{ command, data, ok, version }`, so the payload
 * is one level down; reading the top level silently finds nothing.
 */
type Envelope = { data?: Shot };
type Shot = {
  data?: unknown;
  format?: unknown;
  width?: unknown;
  height?: unknown;
  scale_factor?: unknown;
};

/**
 * A screenshot arrives as base64 JSON, and the model sees pixels only if that
 * becomes ImageContent. The JSON is also kept as text: width and height are what
 * a pixel click needs, and the image alone does not report them.
 *
 * An unparseable shot, or one of a format the model does not take, falls back to
 * the raw text instead of losing the answer.
 */
export function shotContent(out: string): [TextContent, ...ImageContent[]] {
  let shot: Shot | undefined;
  try {
    shot = (JSON.parse(out) as Envelope).data;
  } catch {
    return [{ type: "text", text: out || "Nothing on screen." }];
  }
  const mimeType = MIME[String(shot?.format)];
  if (!mimeType || typeof shot?.data !== "string" || !shot.data)
    return [{ type: "text", text: out }];

  // These are device pixels while click/hover x/y are accessibility points, so
  // say the ratio: without it a pixel read off the image lands short on Retina.
  const size =
    typeof shot.width === "number" && typeof shot.height === "number"
      ? ` ${shot.width}x${shot.height} px${scaleNote(shot.scale_factor)}.`
      : "";
  return [
    { type: "text", text: `Screenshot${size}` },
    { type: "image", mimeType, data: shot.data },
  ];
}

// Only the case that needs arithmetic is worth naming; at 1x they are the same.
function scaleNote(scale: unknown): string {
  const n = Number(scale);
  return scale !== undefined && n !== 1 && Number.isFinite(n) && n > 0
    ? ` at ${n}x: divide a pixel by ${n} for a point`
    : "";
}

/**
 * The CLI answers a failure with its code, message and, usually, a suggestion.
 * Thrown whole as JSON it is unreadable, so the parts are lifted out and the
 * field that says what to do next is kept.
 *
 * An ambiguous target puts the very ids that disambiguate it in `details`, so
 * those are named too rather than left behind. Anything unparseable, or the
 * CLI's own ref-goes-stale advice which the raw text already carries, is passed
 * through unchanged.
 */
export function cliError(out: string, action: unknown, code: number): string {
  const fallback =
    out || `agent-desktop ${String(action)} failed with exit ${code}`;
  let e: { message?: unknown; suggestion?: unknown; details?: unknown };
  try {
    e = (JSON.parse(out) as { error?: typeof e }).error ?? {};
  } catch {
    return fallback;
  }
  if (typeof e.message !== "string") return fallback;
  const candidates = e.details as
    | { candidates?: { id?: unknown; pid?: unknown }[] }
    | undefined;
  const ids = (candidates?.candidates ?? [])
    .map((c) => scalar(c.id ?? c.pid ?? "?"))
    .filter((id) => id !== "?");
  return [
    e.message,
    typeof e.suggestion === "string" ? e.suggestion : "",
    ids.length ? `Candidates: ${ids.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// Only what pi-ai's ImageContent accepts; anything else stays text.
const MIME: Record<string, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/**
 * The CLI answers every success with `{ command, ok, data }`, and one level of
 * braces is what the agent then has to parse. `data` is written as text the agent
 * can act on instead, so it is shaped for the two things it must decide: which
 * element to aim at, and what the answer means.
 *
 * A tree node leads with its ref, so everything needed is on one line; `value`
 * on a document-sized field is clamped, and `get` reads it in full. A null
 * property is absent rather than the word "null", and `is` says *not applicable*
 * rather than a false `result` -- a text field is not unchecked.
 *
 * Anything that is not one of those envelopes, stdout and stderr both included,
 * is passed through untouched.
 */
export function render(out: string): string {
  let data: unknown;
  try {
    data = (JSON.parse(out) as { data?: unknown }).data;
  } catch {
    return out || "Nothing on screen.";
  }
  const lines = describe(data);
  if (!lines.length) return "Nothing on screen.";
  // The legend is ~360 fixed characters, so it only pays for itself on a big
  // tree; a small one -- which is what a drill returns -- reads shorter without
  // it, and `at`/`acts` still say what they are.
  // `hasTree` scopes it to snapshot-shaped payloads, but it is only a top-level
  // key check while the legend describes node fields, so the line count is what
  // actually decides. A drill also carries `data.tree`, so this gate, not
  // `hasTree`, is the one that suppresses it there.
  const hasTree = typeof data === "object" && data !== null && "tree" in data;
  return (
    hasTree && lines.length >= LEGEND_BREAKEVEN ? [LEGEND, ...lines] : lines
  ).join("\n");
}

// The measured crossover is 18 lines (at 18 the two are equal, above it the
// render wins); 20 keeps the legend on the side it pays for. It is a line count
// rather than a node count because the nodes are already counted once here.
const LEGEND_BREAKEVEN = 20;

// `label` is the list marker, and it goes on the entry's first line only: the
// indentation already carries ancestry, so repeating it on every line printed
// `#1   #1   #1` down a deep tree and made the text longer than the JSON it
// replaced. The entry's own fields are indented under that first line, so they
// stay visibly inside the item.
// One space per level, and no level spent on the marker: a deep tree indents
// itself to nothing at two spaces, and indentation is the bulk of the bytes.
const STEP = " ";

function describe(data: unknown, indent = "", label = ""): string[] {
  if (!label) return describeBody(data, indent);
  const inner = `${indent}${STEP}`;
  const lines = describeBody(data, inner);
  if (!lines.length) return lines;
  return [
    `${indent}${label}${lines[0].slice(inner.length)}`,
    ...lines.slice(1),
  ];
}

function describeBody(data: unknown, indent: string): string[] {
  if (Array.isArray(data))
    return data.flatMap((v, i) => describe(v, indent, `#${i + 1} `));
  // A null is an absent property (`title` on an unnamed button), never "null".
  if (data === null || data === undefined) return [];
  // A string, number, boolean or bigint: the whole non-object range.
  if (typeof data !== "object") return [`${indent}${scalar(data)}`];

  const o = data as Record<string, unknown>;
  // Both are a labelled property answer; they differ only in what a non-answer
  // means, so one flag picks the wording.
  if (typeof o.property === "string" && ("result" in o || "value" in o))
    return property(o, "result" in o, indent);

  if (isNode(o)) return node(o, indent);
  // Generic object: its own keys, one per line.
  return Object.entries(o).flatMap(([k, v]) =>
    typeof v === "object" && v !== null
      ? [`${indent}${k}:`, ...describeBody(v, `${indent}${STEP}`)]
      : v === null || v === undefined
        ? []
        : [`${indent}${k}: ${scalar(v)}`],
  );
}

// A get/is answer is intercepted before this, so `role` here is a node's role.
// A ref-less leaf still carries keys of its own -- the live CLI omits `children`
// on leaves, so `children` alone would send it to the generic path, where its
// `available_actions` prints as a numbered list instead of one `acts:` line.
// A get/is answer is intercepted before this, so a `role` here is a node's role
// and `role` alone means a node. A leaf carries almost nothing else: the live CLI
// gives it no ref, omits `children`, and an inert one has no actions or bounds,
// so keying on those sent a bare `{ role }` to the generic path, where it printed
// as `role: group` among refs.
const isNode = (o: Record<string, unknown>) => typeof o.role === "string";

/**
 * The actions that do not earn a ref on their own -- the docs' words. Web
 * runtimes advertise them on nearly every node, so on a ref-less node they are
 * the majority of `acts:` lines while offering no address to act by.
 */
const SITUATIONAL = new Set(["RightClick", "ScrollTo", "SetFocus"]);

/**
 * A `get` or `is` answer: the property name, then the value, so a bare word
 * still says which question it answers.
 *
 * A `get` is never clamped -- it is the documented way to read whole what a
 * snapshot line abbreviates -- so its value is flattened but kept whole. A null
 * value says so, since it is the answer here rather than an absent key. Only
 * `bounds` reports liveness, and a snapshot copy of it may be stale.
 */
function property(
  o: Record<string, unknown>,
  isCheck: boolean,
  indent: string,
): string[] {
  const name = `${indent}${o.property as string}: `;
  if (isCheck)
    return [
      o.applicable === false
        ? `${name}not applicable to this element`
        : `${name}${scalar(o.result)}`,
    ];
  const at = rect(o.value);
  const shown =
    at ??
    (o.value == null
      ? "(none)"
      : Array.isArray(o.value)
        ? o.value.map(scalar).join(", ") || "(none)"
        : scalar(o.value).replace(/\s+/g, " "));
  return o.live === false
    ? [
        `${name}${shown}`,
        `${indent}(from the snapshot, not live — re-read before a click)`,
      ]
    : [`${name}${shown}`];
}

/**
 * One line saying how to read what follows. It is a contract, not decoration:
 * it names the ref to act on, forbids reusing an old one, and says a pixel is a
 * last resort because the tree address is exact.
 */
const LEGEND =
  "Elements read `ref role name value`; act by the ref, from this result only. " +
  "`at` is x,y wxh in points (pixel fallback, with include_bounds); `acts` is what it accepts. " +
  "No `acts` on a ref-less node means only RightClick, ScrollTo and SetFocus, which need no ref. " +
  "`+n` means cut by depth — pass the ref as root to read just that region. " +
  "A … value is clamped; `get text` reads it whole.";

/** An unknown as text, for a place a value is only ever displayed. */
function scalar(v: unknown): string {
  if (typeof v === "number")
    // A scrollbar's name is a raw float position; the tail is noise.
    return Number.isInteger(v) ? `${v}` : `${Number(v.toFixed(4))}`;
  return typeof v === "string" ||
    typeof v === "boolean" ||
    typeof v === "bigint"
    ? `${v}`
    : JSON.stringify(v);
}

function rect(v: unknown): string | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const { x, y, width, height } = v as Record<string, number | undefined>;
  if (
    x === undefined ||
    y === undefined ||
    width === undefined ||
    height === undefined
  )
    return undefined;
  return `${x},${y} ${width}x${height}`;
}

/**
 * One accessibility node on its first line: ref, role, name and value, then the
 * states and what it advertises. Children follow indented, so the shape of the
 * line is the shape of the screen.
 *
 * The docs are explicit that an unnamed element carries its content in `value`,
 * so `value` is its identity there and is kept; on a named text field it is the
 * whole document and is clamped, with `get text` for the rest.
 */ function node(n: Record<string, unknown>, indent: string): string[] {
  // A scrollbar names itself with a float position, so a name is not only text.
  const named = n.name !== undefined && n.name !== null && n.name !== "";
  const actionless = !n.ref_id;
  const parts = [n.ref_id, n.role].filter(
    (v): v is string => typeof v === "string" && v !== "",
  );
  if (named) parts.push(clamp(scalar(n.name)));
  if (typeof n.value === "string" && n.value !== "")
    parts.push(named ? clamp(n.value) : clamp(n.value, 240));
  const lines = [`${indent}${parts.join(" ")}`];

  // A skeleton marks what it cut; that count is the drill target.
  if (typeof n.children_count === "number")
    lines.push(`${indent}${STEP}+${n.children_count}`);
  const at = rect(n.bounds);
  if (at) lines.push(`${indent}${STEP}at ${at}`);
  if (Array.isArray(n.states) && n.states.length)
    lines.push(`${indent}${STEP}states: ${n.states.join(", ")}`);
  const acts = (n.available_actions as unknown[] | undefined) ?? [];
  if (
    acts.length &&
    !(actionless && acts.every((a) => SITUATIONAL.has(String(a))))
  )
    lines.push(`${indent}${STEP}acts: ${acts.join(", ")}`);
  const children = n.children;
  if (Array.isArray(children))
    for (const [i, c] of children.entries())
      lines.push(...describe(c, `${indent}${STEP}`, `#${i + 1} `));
  return lines;
}

// One long value is one long token bill; the head is what identifies it.
function clamp(s: string, max = 120): string {
  const flat = s.replace(/\s+/g, " ").trim();
  // A scrollbar's value is a float position and arrives as a string; the tail is
  // noise on every read and it is long enough to crowd out the name.
  const short = /^-?0?\.\d{6,}$/.test(flat)
    ? `${Number(Number(flat).toFixed(4))}`
    : flat;
  return short.length > max ? `${short.slice(0, max)}…` : short;
}

// The commands whose --help carries --window-id; a ref command rejects it.
const WINDOW_SCOPED = new Set(["press", "screenshot", "snapshot"]);

// The two that move a window in or out of the Dock; their verification read
// times out while the window is away.
const WINDOW_VISIBILITY = new Set(["minimize", "restore"]);

// Window geometry commands: each scopes by window_id or app.
const WINDOW_GEOMETRY = new Set([
  "maximize",
  "minimize",
  "restore",
  "move_window",
  "resize_window",
]);
// spellings, so the two dashed CLI names appear with underscores.
const ONE_REF = new Set([
  "clear",
  "collapse",
  "expand",
  "focus",
  "right_click",
  "scroll_to",
  "toggle",
  "check",
  "uncheck",
]);

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
  const app = p.app as string | undefined;

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
  // Only snapshot, screenshot and press take this flag; the ref commands name their
  // own window through the ref and clap rejects it there. Two windows of one app
  // are indistinguishable by name, so it is what pins the rest.
  if (WINDOW_SCOPED.has(action)) put(args, "--window-id", p.window_id);
  // The only click that takes coordinates: `click` is ref-only, so this is how a
  // node the platform gave no ref reaches (`at` from an include_bounds snapshot).
  // It is always a real pointer event, so it is headed whatever the call says.
  if (action === "mouse_click") {
    const xy = coords(p.x, p.y);
    if (xy) putEq(args, "--xy", xy);
    args.push("--headed");
    return args;
  }
  // A physical gesture, so it always needs the real pointer.
  if (action === "double_click" || action === "triple_click") {
    if (ref) args.push(ref);
    args.push("--headed");
    return args;
  }
  // App lifecycle: the app is positional, and launching waits for a window so
  // the next snapshot has something to read.
  if (action === "launch") {
    args.push("--activate");
    if (app) args.push("--", app);
    return args;
  }
  if (action === "close_app") {
    if (app) args.push("--", app);
    return args;
  }
  if (action === "focus_window") {
    put(args, "--window-id", p.window_id);
    putEq(args, "--app", p.app);
    return args;
  }
  // Window geometry: all scoped the same way, plus grow or move where they do.
  if (WINDOW_GEOMETRY.has(action)) {
    put(args, "--window-id", p.window_id);
    putEq(args, "--app", p.app);
    if (action === "move_window") {
      put(args, "--x", p.x);
      put(args, "--y", p.y);
    }
    if (action === "resize_window") {
      put(args, "--width", p.width);
      put(args, "--height", p.height);
    }
    return args;
  }
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

  // get and is are ref reads: the ref is positional and both take the same
  // --property flag, which has its own default. Their answer is the value.
  if (action === "get" || action === "is") {
    if (ref) args.push(ref);
    putEq(args, "--property", p.property);
    return args;
  }

  // A search answers with matches, so it is a read and takes no ref.
  if (action === "find") {
    putEq(args, "--app", p.app);
    put(args, "--window-id", p.window_id);
    putEq(args, "--text", p.query);
    putEq(args, "--role", p.role);
    return args;
  }

  // A wait blocks until the condition holds, then answers. Text is the useful
  // form; a bare duration is the fallback the docs warn is a race.
  if (action === "wait") {
    putEq(args, "--app", p.app);
    put(args, "--window-id", p.window_id);
    putEq(args, "--text", p.wait_text);
    // Without a bound a text wait spends 30s before saying it did not match.
    put(args, "--timeout", p.timeout_ms);
    if (typeof p.wait_ms === "number") args.push(String(p.wait_ms));
    return args;
  }

  // The clipboard and the surface list are bare commands; surfaces filter by app.
  if (action === "list_surfaces") {
    putEq(args, "--app", p.app);
    return args;
  }
  if (action === "clipboard_get" || action === "clipboard_clear") return args;
  // Text is positional and may begin with a hyphen, so `--` ends flag parsing.
  if (action === "clipboard_set") {
    if (text !== undefined) args.push("--", text);
    return args;
  }

  // One positional ref, nothing else: the semantic single-state actions.
  if (ONE_REF.has(action)) {
    if (ref) args.push(ref);
    return args;
  }

  // The remaining read commands scope by --app.
  if (READ_ACTIONS.has(action)) {
    putEq(args, "--app", p.app);
    // A leaf the platform will not qualify still needs an address: an `unknown`
    // toolbar button has no ref but is pressable by pixel, and bounds are the
    // only way to reach it. It costs about half again the payload, so it is asked
    // for only when such a node is actually present.
    if (action === "snapshot" && p.include_bounds)
      args.push("--include-bounds");
    // The shaping flags the docs make the normal loop: map shallow, drill one
    // region. Without them every snapshot is the whole tree.
    if (action === "snapshot") {
      if (p.skeleton) args.push("--skeleton");
      if (p.compact) args.push("--compact");
      if (p.interactive_only) args.push("--interactive-only");
      put(args, "--root", p.root);
    }
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
