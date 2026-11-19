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
//   session_shutdown -> session end     pi leaves, so an open run is let go
//
// It is agent_settled, not agent_end: agent_end also fires before a retry,
// compaction or queued work starts another run, and ending there kills an action
// the run still needs.

import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
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
  "sandbox",
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
  "status",
  "permissions",
  "screenshot",
  "get",
  "is",
  "version",
  "skills",
  "session",
  "trace",
  "trace_export",
  "cursor_overlay",
  "list_notifications",
  "dismiss_notification",
  "dismiss_all_notifications",
  "notification_action",
  "open_system_surface",
  "batch",
  "mouse_wheel",
  "mouse_move",
] as const;

// Actions that only read; the rest act and are followed by a fresh snapshot.
const READ_ACTIONS = new Set<string>([
  "snapshot",
  "find",
  "list_surfaces",
  "clipboard_get",
  "list_displays",
  "status",
  "permissions",

  "list_apps",
  "list_windows",
  "screenshot",
  "get",
  "is",
  "version",
  "skills",
  "session",
  "trace",
  "list_notifications",
]);

// Tool action -> CLI command, for the two that differ. Everything else is a
// plain dash-for-underscore swap, so it needs no entry.
const COMMANDS: Record<string, string> = {
  list_apps: "list-apps",
  mouse_click: "mouse-click",
  mouse_move: "mouse-move",
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
  trace_export: "trace export",
  cursor_overlay: "cursor-overlay",
  list_notifications: "list-notifications",
  dismiss_notification: "dismiss-notification",
  dismiss_all_notifications: "dismiss-all-notifications",
  notification_action: "notification-action",
  open_system_surface: "open-system-surface",
  mouse_wheel: "mouse-wheel",
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
    "Call snapshot once before acting, then read each action's own result instead of assuming it worked.",
    "Act by ref (@e3) wherever one exists; without one, use its `at` with mouse-click, which is the only click that takes x/y. mouse-move parks the pointer at a point without clicking; mouse_wheel scrolls at one.",
    "Every result is plain text, so read it directly: get reads one property of a ref and is checks one state. get bounds gives exact points, which beats a pixel estimated from a screenshot.",
    "is answering 'not applicable' means the element has no such state; that is not the same as false.",
    "A menu, sheet or repaint renumbers every ref. Act from the most recent snapshot only, never from a ref in an older one.",
    "Check available_actions before choosing an action: click only what advertises Click. A bare text field advertises TypeText, not Click, so clicking it wastes a call in either mode - type into it, or set_value.",
    "Pass window_id from list_windows to pin one window, for snapshot, screenshot and press only. An app with two windows refuses as AMBIGUOUS_TARGET, and even with one visible window a second instance of the app can make an app-only target resolve to the other one.",
    "Headless is the default and never touches the operator's cursor. Pass headed true when an action needs the real pointer: hover and drag always do, and a click does when the element has no semantic delivery.",
    "Run `agent-desktop skills get desktop` in a shell before a long session; the skills are compiled into the binary, so they always match the installed version.",
    "A node with neither a ref nor an `at` cannot be addressed: snapshot again with include_bounds for x/y, or use its keyboard shortcut.",
    "To find a known word use find, which searches without dumping a tree.",
    "After an async step use wait, not a fixed pause: wait_event blocks on a desktop signal (window-opened, app-terminated) with no id needed up front, which is how a dialog or a new window is waited for.",
    "Prefer the semantic action a node advertises (toggle, check, expand, focus ...) over a click on it. Window placement is maximize/minimize/restore/move_window/resize_window, which take window_id, not a ref, and open_system_surface opens a shell panel such as the Dock.",
    "When nothing works, status names the platform and permissions the missing OS grant; add request to ask for it. A batch has no snapshot between steps, so end it with a snapshot step. A sandbox is another host, so its work never shows in a local snapshot.",
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
      }
    ),
    app: Type.Optional(
      Type.String({
        description:
          "Application name to scope the window. Required for everything except list_apps.",
      })
    ),
    ref: Type.Optional(
      Type.String({
        description:
          "Element ref from the most recent snapshot, e.g. @e3. Preferred over x/y; press targets the focused window and takes none. mouse_click also takes one alongside x/y, only to name the app its point came from.",
      })
    ),
    x: Type.Optional(
      Type.Number({
        description:
          "Pixel x, only when the element has no usable ref. mouse_move and mouse_wheel take it on its own, with y.",
      })
    ),
    y: Type.Optional(Type.Number({ description: "Pixel y, same as x." })),
    property: Type.Optional(
      Type.String({
        description:
          "get: text, value, title, bounds, role, states. is: visible, enabled, checked, focused, expanded, selected.",
      })
    ),
    text: Type.Optional(
      Type.String({
        description: "Text for type, or the text clipboard_set writes.",
      })
    ),
    value: Type.Optional(
      Type.String({ description: "Whole new field text for set_value." })
    ),
    key: Type.Optional(
      Type.String({
        description: 'Key chord for press, e.g. "cmd+s" or "Return".',
      })
    ),
    direction: Type.Optional(
      Type.String({
        description: "Scroll direction: up, down, left, right.",
      })
    ),
    amount: Type.Optional(
      Type.Number({ description: "Scroll amount in units (default 3)." })
    ),
    from_x: Type.Optional(
      Type.Number({
        description:
          "Drag start x, with from_y; negative for a left-hand display.",
      })
    ),
    from_y: Type.Optional(Type.Number({ description: "Drag start y." })),
    to_ref: Type.Optional(
      Type.String({
        description:
          "Destination ref for drag, e.g. @e7. Preferred over to_x/to_y.",
      })
    ),
    to_x: Type.Optional(
      Type.Number({ description: "Drag end x, with to_y; negative allowed." })
    ),
    to_y: Type.Optional(Type.Number({ description: "Drag end y." })),
    timeout_ms: Type.Optional(
      Type.Number({
        description:
          "Ref-resolution/actionability budget in milliseconds. Raise it for slow Chromium settles.",
      })
    ),
    headed: Type.Optional(
      Type.Boolean({
        description:
          "Use the real pointer instead of the accessibility path. Off by default; hover and drag need it.",
      })
    ),
    window_id: Type.Optional(
      Type.String({
        description:
          "Target one window by id from list_windows. Only snapshot, screenshot and press take it.",
      })
    ),
    include_bounds: Type.Optional(
      Type.Boolean({
        description:
          "snapshot only: also report bounds, so a ref-less node stays reachable by x/y. Costs about half the payload again.",
      })
    ),
    skeleton: Type.Optional(
      Type.Boolean({
        description:
          "snapshot only: a shallow overview, with `+n` on the containers it cut. Only cuts a page deeper than the depth limit, so pair it with interactive_only.",
      })
    ),
    compact: Type.Optional(
      Type.Boolean({
        description:
          "snapshot only: collapse single-child unnamed wrappers, which is most of a web tree's depth.",
      })
    ),
    interactive_only: Type.Optional(
      Type.Boolean({
        description:
          "snapshot only: interactive elements only. The lever that always shrinks a tree; leave it off to keep row context.",
      })
    ),
    root: Type.Optional(
      Type.String({
        description:
          "snapshot only: start at this ref instead of the window root, to read one region. Refs outside it stay valid.",
      })
    ),
    query: Type.Optional(
      Type.String({
        description:
          "find only: match by text across name, value, title and description. find is the cheap way to locate an element when you know its words, without dumping a tree.",
      })
    ),
    role: Type.Optional(
      Type.String({ description: "find only: match by accessibility role." })
    ),
    wait_ms: Type.Optional(
      Type.Number({
        description:
          "wait only: pause this many milliseconds. A fixed sleep is a race; prefer wait_text, which returns as soon as the text appears.",
      })
    ),
    wait_text: Type.Optional(
      Type.String({
        description:
          "wait only: block until this text appears in the app's tree, then return. The reliable form after an async step.",
      })
    ),
    width: Type.Optional(
      Type.Number({ description: "resize_window only: new width in points." })
    ),
    height: Type.Optional(
      Type.Number({
        description:
          "resize_window only: new height in points; a display's height is on list_displays.",
      })
    ),
    sub: Type.Optional(
      Type.String({
        description:
          "The subcommand for skills (list, get, path), session (start, end, list, gc), trace (show, export) and cursor_overlay (enable, disable).",
      })
    ),
    name: Type.Optional(
      Type.String({
        description:
          "skills get: the skill name from skills list. session start: an optional label for the manifest.",
      })
    ),
    surface: Type.Optional(
      Type.String({
        description:
          "open_system_surface: the shell panel to open, e.g. dock or menu-bar-extras; status lists the ones this platform supports.",
      })
    ),
    index: Type.Optional(
      Type.Number({
        description:
          "dismiss_notification and notification_action: 1-based index from list_notifications.",
      })
    ),
    option: Type.Optional(
      Type.String({
        description:
          "notification_action: the button to click, e.g. Reply or Open.",
      })
    ),
    expected_title: Type.Optional(
      Type.String({
        description:
          "dismiss_notification and notification_action: the title the caller expects at index, checked before acting. Pass app too when it is known.",
      })
    ),
    steps: Type.Optional(
      Type.Array(
        Type.Object({
          command: Type.String({
            description: 'CLI command, dashed, e.g. "click" or "set-value".',
          }),
          args: Type.Optional(
            Type.Record(Type.String(), Type.Unknown(), {
              description:
                'CLI options by their long name, e.g. {ref: "@e3"}. Omit for a command that takes none.',
            })
          ),
          steps: Type.Optional(
            Type.Array(Type.Unknown(), {
              description:
                'batch only: sub-entries on a subcommand, e.g. sn/ss with command "session".',
            })
          ),
        }),
        {
          description:
            "batch only: commands to run in order with no round trip; a ref goes stale after the first act, so end with a snapshot step.",
        }
      )
    ),
    stop_on_error: Type.Optional(
      Type.Boolean({
        description:
          "batch only: halt at the first failed command instead of running the rest.",
      })
    ),
    limit: Type.Optional(
      Type.Number({
        description:
          "list_notifications, trace and trace_export: how many to return.",
      })
    ),
    path: Type.Optional(
      Type.String({
        description: "trace_export: the HTML file to write.",
      })
    ),
    dy: Type.Optional(
      Type.Number({
        description:
          "mouse_wheel: wheel lines; positive scrolls up, negative down (default -3 when dx is absent).",
      })
    ),
    dx: Type.Optional(
      Type.Number({
        description:
          "mouse_wheel: horizontal wheel lines; positive scrolls right.",
      })
    ),
    launch_args: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "launch only: command-line arguments for the app, in order. Repeatable; a leading hyphen is sent in the --arg= form.",
      })
    ),
    launch_env: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "launch only: KEY=VALUE environment variables for the app.",
      })
    ),
    cwd: Type.Optional(
      Type.String({
        description: "launch only: working directory for the app.",
      })
    ),
    no_attach: Type.Optional(
      Type.Boolean({
        description:
          "launch only: start a fresh instance instead of attaching to one already running. Windows fails if the app is up.",
      })
    ),
    cdp: Type.Optional(
      Type.Number({
        description:
          "launch only: expose the app's DevTools protocol endpoint on this port; omit the number for a free one.",
      })
    ),
    force: Type.Optional(
      Type.Boolean({
        description:
          "close_app only: terminate the processes instead of asking the app to quit, for one that will not.",
      })
    ),
    request: Type.Optional(
      Type.Boolean({
        description:
          "permissions only: ask the OS for the missing grants rather than only reporting them.",
      })
    ),
    guide: Type.Optional(
      Type.Boolean({
        description:
          "permissions only: open System Settings on a guide for granting the missing grants (macOS).",
      })
    ),
    format: Type.Optional(
      Type.String({
        description:
          "clipboard_get: text (default), auto, image or file-urls. auto picks whatever the clipboard holds; image writes a file.",
      })
    ),
    screen: Type.Optional(
      Type.Number({
        description:
          "screenshot only: capture a whole display by index from list_displays (0 is the primary) instead of a window.",
      })
    ),
    image: Type.Optional(
      Type.String({
        description:
          "clipboard_set: path to a PNG file to put on the clipboard.",
      })
    ),
    file_url: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "clipboard_set: file paths to put on the clipboard as file references, which is what a Finder paste takes.",
      })
    ),
    stdin_text: Type.Optional(
      Type.String({
        description:
          "clipboard_set: write this text through a pipe instead of as an argv word, so it may be long or begin with a hyphen. Conflicts with text, image and file_url.",
      })
    ),
    wait_event: Type.Optional(
      Type.String({
        description:
          "wait only: a desktop signal (window-opened, app-terminated, surface-appeared ...), detected by a baseline diff so no id is needed up front.",
      })
    ),
    wait_window: Type.Optional(
      Type.String({
        description:
          "wait only: block until a window with this title appears; with wait_event it narrows the event instead of selecting a mode.",
      })
    ),
    wait_element: Type.Optional(
      Type.String({
        description:
          "wait only: block until this ref appears in the tree. Pair with predicate for anything beyond existence.",
      })
    ),
    predicate: Type.Optional(
      Type.String({
        description:
          "wait only, with wait_element: what to require of it - exists, enabled, visible, actionable, or value (then also pass value).",
      })
    ),
    wait_action: Type.Optional(
      Type.String({
        description:
          "wait only, with predicate actionable: what it must accept - click (default), type, set-value or clear.",
      })
    ),
    count: Type.Optional(
      Type.Number({
        description:
          "wait only: expected match count for a text wait, when one is expected rather than merely the first.",
      })
    ),
    menu: Type.Optional(
      Type.Boolean({
        description: "wait only: block until a menu surface opens.",
      })
    ),
    menu_closed: Type.Optional(
      Type.Boolean({
        description: "wait only: block until the menu surface is dismissed.",
      })
    ),
    notification: Type.Optional(
      Type.Boolean({
        description:
          "wait only: block until a new notification arrives; wait_text filters its text.",
      })
    ),
    drop_delay_ms: Type.Optional(
      Type.Number({
        description:
          "drag only: hold over the destination this many ms before releasing, so the drop target activates. Default 500.",
      })
    ),
    duration_ms: Type.Optional(
      Type.Number({ description: "drag only: the drag's duration in ms." })
    ),
    wait_for: Type.Optional(
      Type.String({
        description:
          "drag only: the confirmation to wait for at the drop, when the drag changes what is on screen.",
      })
    ),
    wait_for_gone: Type.Optional(
      Type.String({
        description:
          "drag only: what to wait until it disappears after the drop.",
      })
    ),
    wait_for_scope: Type.Optional(
      Type.String({
        description:
          "drag only: which window the wait polls, `to` (the drop target, default) or `from`. Needed when only the destination confirms a cross-window drag.",
      })
    ),
    provider: Type.Optional(
      Type.String({
        description:
          "sandbox only: the provider for install and create. install without one reports every provider's state.",
      })
    ),
    set: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "sandbox only: KEY=VALUE provider option for create and start, such as title=<text>.",
      })
    ),
    exec_args: Type.Optional(
      Type.Array(Type.String(), {
        description:
          'sandbox exec only: the agent-desktop arguments to run inside the sandbox, e.g. ["snapshot", "--app", "Finder"].',
      })
    ),
    window: Type.Optional(
      Type.Boolean({
        description:
          "sandbox start only: show the sandbox's desktop in a window here instead of running it headless.",
      })
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
        "agent-desktop is not on PATH. Install it with: npm install -g agent-desktop"
      );

    // A nested start mints a new session id, so it runs under the old one and
    // replaces it afterwards; every other call, including a start, takes
    // buildArgs' session-scoped form.
    const start = p.action === "session" && p.sub === "start";
    const [runBin, runArgs] = start
      ? [bin, startArgs(p)]
      : withSession(bin, buildArgs(p));
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
    // Any of the four wait forms will do: text, a duration, a lifecycle signal
    // or an element with its predicate. A menu and a notification are signals too.
    if (
      p.action === "wait" &&
      !p.wait_text &&
      typeof p.wait_ms !== "number" &&
      !p.wait_event &&
      !p.wait_element &&
      !p.menu &&
      !p.menu_closed &&
      !p.notification
    )
      throw new Error(
        "wait needs one of wait_text, wait_ms, wait_event, wait_element, menu, menu_closed or notification"
      );
    // Whichever way it is carried, the clipboard write has to bring a payload.
    if (
      p.action === "clipboard_set" &&
      p.text === undefined &&
      p.stdin_text === undefined &&
      !p.image &&
      !list(p.file_url).length
    )
      throw new Error(
        "clipboard_set needs text, stdin_text, image or file_url to put on the clipboard"
      );
    if (p.action === "mouse_click" && !coords(p.x, p.y))
      throw new Error(
        "mouse_click needs x and y; take them from an `at` line, the center being x+width/2, y+height/2"
      );
    if ((p.action === "get" || p.action === "is") && !p.ref)
      throw new Error(`${p.action} needs a ref from the snapshot, e.g. @e3`);
    if (p.action === "type" && p.text === undefined)
      throw new Error(
        "type needs text; pass an empty string to insert nothing"
      );
    // The nested groups are one CLI subcommand each; naming it is the whole call.
    if (NESTED.has(String(p.action)) && !p.sub)
      throw new Error(`${p.action} needs sub: ${NESTED.get(String(p.action))}`);
    if (p.action === "skills" && p.sub === "get" && !p.name)
      throw new Error("skills get needs name, from skills list");
    // Both name a sandbox positionally, and both are useless without one.
    if (p.action === "sandbox" && p.sub && p.sub !== "list" && !p.name)
      throw new Error(`sandbox ${p.sub} needs name`);
    // create both names a provider and writes its options into the sandbox, so
    // neither can be defaulted.
    if (p.action === "sandbox" && p.sub === "create" && !p.provider)
      throw new Error("sandbox create needs provider");
    // exec's argv is the whole call inside the sandbox; empty runs nothing.
    if (p.action === "sandbox" && p.sub === "exec" && !list(p.exec_args).length)
      throw new Error(
        "sandbox exec needs exec_args, the agent-desktop arguments to run inside it"
      );
    // A `cdp` with no number still asks for a free port, so a bare true is fine.
    if (p.action === "wait" && p.predicate === "value" && p.value === undefined)
      throw new Error("predicate value needs value, the one expected");
    if (p.action === "open_system_surface" && !p.surface)
      throw new Error(
        "open_system_surface needs surface, e.g. dock or menu-bar-extras"
      );
    if (
      (p.action === "dismiss_notification" ||
        p.action === "notification_action") &&
      (typeof p.index !== "number" || !Number.isInteger(p.index))
    )
      throw new Error(
        `${p.action} needs index, a 1-based position from list_notifications`
      );
    // The index alone is a race: the queue shifts under an arriving or expiring
    // notification, so the CLI will not act on one without a field to check.
    if (
      (p.action === "dismiss_notification" ||
        p.action === "notification_action") &&
      !p.app &&
      !p.expected_title
    )
      throw new Error(
        `${p.action} needs app or expected_title to guard the index against a queue that shifted`
      );
    if (p.action === "notification_action" && !p.option)
      throw new Error("notification_action needs option, the button to click");
    if (p.action === "mouse_move" && !coords(p.x, p.y))
      throw new Error(
        "mouse_move needs x and y; take them from an `at` line, the center being x+width/2, y+height/2"
      );
    if (p.action === "mouse_wheel" && !coords(p.x, p.y))
      throw new Error(
        "mouse_wheel needs x and y; take them from an `at` line, the center being x+width/2, y+height/2"
      );
    if (p.action === "batch" && !Array.isArray(p.steps))
      throw new Error("batch needs steps, an array of {command, args}");
    // Both take VALUE as a required positional, so an omission would otherwise
    // reach clap and come back as an INVALID_ARGS envelope.
    if (
      (p.action === "set_value" || p.action === "select") &&
      p.value === undefined
    )
      throw new Error(
        p.action === "select"
          ? "select needs the option value to pick"
          : "set_value needs a value; pass an empty string to clear it"
      );
    // maximize/minimize/restore each end in an AX read that times out while the
    // window settles, so they report failure for an action that landed. Note the
    // window first, then confirm the change instead of believing the error.
    const before = WINDOW_VISIBILITY.has(String(p.action))
      ? await windowState(bin, p.window_id, signal)
      : undefined;
    const r = await api.exec(runBin, runArgs, {
      signal,
      timeout: 120_000,
      ...sessionEnv(),
    });
    const out = `${r.stdout}${r.stderr}`.trim();
    // A start has to hand its id on, or the next call is back in the old
    // namespace and the refs this one seeded are unreachable.
    if (start && r.code === 0) adopt(r.stdout);
    // A start or end run by the agent moves the run's session, so the settle
    // hook must not end what is closed already or skip what it opened.
    markSessionArgs([p.action, p.sub ?? ""], r.code === 0);
    if (r.code !== 0 && before) {
      const landed = windowLanded(
        p.action,
        before,
        await windowState(bin, p.window_id, signal)
      );
      if (landed)
        return {
          content: [
            {
              type: "text" as const,
              text: `Ran ${p.action}. The window ${
                p.action === "minimize"
                  ? "is now minimized"
                  : "moved or resized"
              }; the CLI's own verification read timed out, and this was confirmed with list_windows.\n\nCall snapshot before the next action.`,
            },
          ],
          details: { action: p.action, app: p.app },
        };
    }
    // A command this build cannot do at all is an answer, not a failure: it
    // changed nothing, so it neither throws nor takes a snapshot.
    if (r.code !== 0 && !RENDER_FAILURE.some((s) => out.includes(s)))
      throw new Error(cliError(out, p.action, r.code));
    // A read is the answer by itself.
    if (READ_ACTIONS.has(String(p.action)))
      return {
        content:
          p.action === "screenshot"
            ? shotContent(out)
            : [
                {
                  type: "text" as const,
                  text:
                    // The CLI records into a session's own id only once that
                    // id has a trace directory, which `session start` makes but
                    // a placeholder id does not. A read right after a start can
                    // therefore land on nothing while older events exist.
                    (p.action === "trace" && out.includes("no trace directory")
                      ? await lastTraced(bin, signal, runArgs)
                      : undefined) ?? noted(out),
                },
              ],
        details: { action: p.action },
      };

    // An error envelope has no `data`, so `render` would say "Nothing on
    // screen." over the one sentence that explains the refusal.
    if (RENDER_FAILURE.some((s) => out.includes(s)))
      return {
        content: [
          {
            type: "text" as const,
            text: cliError(out, p.action, r.code, true),
          },
        ],
        details: { action: p.action },
      };

    // The clipboard, the version and the whole session/trace/bookkeeping group
    // answer from this machine alone, so a snapshot after them would only repeat
    // the last one. A command it cannot do is the same: it did nothing.
    if (SELFLESS.has(String(p.action)))
      return {
        content: [{ type: "text" as const, text: render(out) }],
        details: { action: p.action },
      };

    // An action's own output is just "Done", which says nothing about what it did.
    // Snapshot again rather than trust it, and let a failed read not hide success.
    const [afterBin, afterArgs] = withSession(bin, afterSnapshot(p));
    const after = await api
      .exec(afterBin, afterArgs, { timeout: 60_000, ...sessionEnv() })
      .catch(() => null);
    if (after?.code === 0) {
      // A call with no app (a ref names its own window) reads the frontmost
      // window instead, so the answer can be another app's tree entirely, and a
      // tree off the wrong app is worse than none. Named where the intended app
      // is known from either side: the call, or the last snapshot it acted from.
      const readApp = renderedApp(after.stdout);
      // The ref names its own snapshot, so the app the ref belongs to is known
      // even when a later snapshot (a launch, a focus) happened in between.
      const fromRef = /^@([^:]+):/.exec(String(p.ref ?? ""))?.[1];
      const want =
        (typeof p.app === "string" && p.app) ||
        (fromRef ? snapshotApps.get(fromRef) : undefined);
      const elsewhere = !!readApp && !!want && readApp !== want;
      return {
        content: [
          {
            type: "text" as const,
            text: elsewhere
              ? `Ran ${p.action}. New state, but of ${readApp} - it came forward, so this is not ${want}:`
              : `Ran ${p.action}. New state:`,
          },
          {
            type: "text" as const,
            text: noted(`${after.stdout}${after.stderr}`.trim()),
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
              : // Why it failed, so a repeat failure is diagnosable rather
                // than a sentence the caller can only retry blindly.
                `\n\nThe snapshot after it failed; call snapshot before the next action.${
                  after
                    ? `\n${cliError(`${after.stdout}${after.stderr}`.trim(), "snapshot", after.code)}`
                    : ""
                }`
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
  new URL("../upstream/npm/bin/agent-desktop", import.meta.url)
);

// Filled on session_start so a missing binary never breaks factory load.
let cmd: string | undefined;
/**
 * Whether this call can reach the CLI natively. Windows has no `sh` to wrap an
 * env into, so there the env rides on `pi.exec` instead of the command line.
 */
let NATIVE = false;

// One id per pi session, so two sessions (a subagent, a second window) do not
// count as one agent: without it the CLI falls back to the parent process, and
// one session's end would release apps the other is still driving.
let session: string | undefined;
// Whether a session start still sits unanswered by an end. A tool start or end
// moves it too, so the settle hook does not end what is already closed.
let inRun = false;

/** pi.exec carries no env, so the id is prefixed onto the command instead. */
/** The env that gives a call this run's session, where `sh` cannot. */
function sessionEnv(): { env: Record<string, string> } | undefined {
  return NATIVE && session
    ? { env: { AGENT_DESKTOP_SESSION: session } }
    : undefined;
}

/** Whether the CLI's state lives elsewhere than `~/.agent-desktop`. */
const stateEnv = () => process.env.AGENT_DESKTOP_HOME?.trim() || undefined;

/**
 * The home directory, read from the environment rather than `os.homedir()`.
 *
 * Node re-reads `$HOME` per call on POSIX but Bun caches the value at startup,
 * so a test that relocates `process.env.HOME` would otherwise keep reading the
 * real store and quietly assert against fixtures nobody wrote.
 */
const homeDir = () => process.env.HOME || homedir();

/** The sessions store, honouring a relocated state directory. */
const storeDir = () =>
  join(stateEnv() ?? homeDir(), ".agent-desktop", "sessions");

/**
 * The snapshot taken after an action, to show what the action did.
 *
 * It repeats the window the action was pinned to: without that it is the app
 * only, which an app with two windows refuses, so a window-scoped action would
 * report success and then look like it broke.
 */
/** What `list-windows` reports for a window, for spotting a change. */
export interface WindowState {
  visible?: boolean;
  bounds?: Record<string, number>;
}

/** The `data` of a successful CLI answer, or undefined when it was not one. */
async function json(
  bin: string,
  args: string[],
  signal: AbortSignal | undefined
): Promise<unknown> {
  const [runBin, runArgs] = withSession(bin, args);
  try {
    const r = await api?.exec(runBin, runArgs, {
      signal,
      timeout: 30_000,
      ...sessionEnv(),
    });
    if (r?.code !== 0) return undefined;
    const e = JSON.parse(r.stdout) as { data?: unknown };
    return e.data;
  } catch {
    return undefined;
  }
}

/**
 * The newest ended session that recorded a trace, as the head of its own trace
 * read. The refs in it point at ids of its own, so it is not a substitute for a
 * snapshot, only for reading what happened.
 */
async function lastTraced(
  bin: string,
  signal: AbortSignal | undefined,
  fallback: string[]
): Promise<string | undefined> {
  const data = (await json(bin, ["session", "list"], signal)) as
    | { sessions?: { session_id?: unknown; ended_at?: unknown }[] }
    | undefined;
  const ended = (data?.sessions ?? [])
    .filter((s) => typeof s.ended_at === "number")
    .map((s) => s.session_id)
    .findLast((id): id is string => typeof id === "string" && !!id);
  if (!ended) return undefined;
  const events = await json(bin, [...fallback, `--session=${ended}`], signal);
  if (events === undefined) return undefined;
  return `No trace under this session, which has not run a traced command yet. The newest session that has ended is ${ended}:\n\n${render(
    JSON.stringify({ data: events })
  )}`;
}

/** The named window's state, or undefined when it is gone or the read fails. */
async function windowState(
  bin: string,
  windowId: unknown,
  signal: AbortSignal | undefined
): Promise<WindowState | undefined> {
  const [listBin, listArgs] = withSession(bin, ["list-windows"]);
  try {
    const r = await api?.exec(listBin, listArgs, {
      signal,
      timeout: 10_000,
      ...sessionEnv(),
    });
    if (r?.code !== 0) return undefined;
    const windows =
      (
        JSON.parse(r.stdout) as {
          data?: {
            id?: string;
            visible?: boolean;
            bounds?: Record<string, number>;
          }[];
        }
      ).data ?? [];
    return windows.find((w) => w.id === windowId);
  } catch {
    return undefined;
  }
}

/**
 * Whether the action took effect, judged by the window itself.
 *
 * The listing has no `minimized` field; a minimized window is `visible: false`
 * instead. A maximize shows up only as new bounds, so the two are checked
 * separately rather than by one boolean.
 */
export function windowLanded(
  action: unknown,
  before: WindowState,
  after: WindowState | undefined
): boolean {
  if (action === "minimize") return after?.visible === false;
  if (action === "restore") return after?.visible === true;
  if (!after?.bounds || !before.bounds) return false;
  return (
    after.bounds.width !== before.bounds.width ||
    after.bounds.height !== before.bounds.height
  );
}

export function afterSnapshot(p: Record<string, unknown>): string[] {
  const { window_id: window, app } = p;
  return [
    "snapshot",
    // A ref names its own window, so a ref-only call carries no `app`; a bare
    // `String(undefined)` would be sent and match nothing.
    ...(typeof app === "string" && app ? ["--app", app] : []),
    ...(typeof window === "string" && window ? ["--window-id", window] : []),
    // The action has just repainted the window, so the default 3s observation
    // deadline is often short of it: the read then fails on a tree that is
    // still moving and the caller is told to re-snapshot for nothing.
    "--timeout-ms",
    AFTER_TIMEOUT_MS,
  ];
}

/** Observation budget for the verification read; the plain default is 3000. */
const AFTER_TIMEOUT_MS = "10000";

function withSession(bin: string, args: string[]): [string, string[]] {
  // Windows has no `sh`, so there the id rides on `pi.exec` instead (sessionEnv).
  if (!session || NATIVE) return [bin, args];
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
interface Envelope {
  data?: Shot;
}
interface Shot {
  data?: unknown;
  format?: unknown;
  width?: unknown;
  height?: unknown;
  scale_factor?: unknown;
}

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

/**
 * The app each recent snapshot answered for, by snapshot id.
 *
 * A ref is qualified with the id it came from, so this says which app the ref
 * actually belongs to. The newest snapshot is not enough: a `launch` taken in
 * between rebinds that, while the ref in hand still points at the older window.
 */
const snapshotApps = new Map<string, string>();
// Enough for a few snapshots of a drill; one ref in hand is from the newest.
const SNAPSHOT_APPS_MAX = 16;

/** Render an answer, remembering which app a snapshot answered for. */
function noted(out: string): string {
  rememberSnapshotApp(out);
  return render(out);
}

/** Record a snapshot's app under its id, for the drift check to look up. */
function rememberSnapshotApp(out: string): void {
  const parsed = parseSnapshot(out);
  if (!parsed?.app || !parsed.id) return;
  snapshotApps.set(parsed.id, parsed.app);
  if (snapshotApps.size > SNAPSHOT_APPS_MAX)
    snapshotApps.delete(snapshotApps.keys().next().value as string);
}

/** A snapshot answer's own id and app, when the payload carried both. */
function parseSnapshot(out: string): { id?: string; app?: string } | undefined {
  try {
    const { data } = JSON.parse(out) as { data?: Record<string, unknown> };
    if (!data) return undefined;
    const pick = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    const { snapshot_id: id, app } = data;
    return { id: pick(id), app: pick(app) };
  } catch {
    return undefined;
  }
}

/** The app a snapshot answered for, or undefined when the answer is not one. */
function renderedApp(out: string): string | undefined {
  try {
    const app = (JSON.parse(out) as { data?: { app?: unknown } }).data?.app;
    return typeof app === "string" && app ? app : undefined;
  } catch {
    return undefined;
  }
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
export function cliError(
  out: string,
  action: unknown,
  code: number,
  keep = false
): string {
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
  const lines = [
    e.message,
    typeof e.suggestion === "string" ? e.suggestion : "",
    ids.length ? `Candidates: ${ids.join(", ")}` : "",
  ];
  // `keep` is for a refusal the caller is told about rather than thrown: the
  // text it returns is the whole result, and a failure with no message of its
  // own would render as "Nothing on screen."
  return (
    keep
      ? [
          ...lines,
          `(${String(action)} failed with exit ${code}.)`,
          out === fallback ? "" : out,
        ]
      : lines
  )
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
    ({ data } = JSON.parse(out) as { data?: unknown });
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
  // `lines[0]` is known to exist here, and its inner indentation is already on
  // the marker's first line, so it is spliced onto the label rather than kept.
  const [first = "", ...rest] = lines;
  return [`${indent}${label}${first.slice(inner.length)}`, ...rest];
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

  // A sentence, not a key dump: these four have no tree to show.
  if (Array.isArray(o.notifications)) return inbox(o, indent);
  if (typeof o.index === "number" && "ok" in o) return perEntry(o, indent);
  if (Array.isArray(o.sessions)) return manifest(o.sessions, indent);
  if (Array.isArray(o.results)) return batch(o, indent);
  if (typeof o.os === "string")
    return [
      `${indent}agent-desktop ${scalar(o.version)} on ${o.os} (${scalar(
        o.target
      )})`,
    ];

  // A raw pointer gesture has one fact worth keeping: where it happened and
  // whether the OS confirmed it. Its steps and target framing say nothing else.
  const point = (o.target as { point?: unknown } | undefined)?.point;
  if (
    typeof o.action === "string" &&
    (o.target as { kind?: unknown } | undefined)?.kind === "pointer"
  ) {
    const d = o.disposition as { delivery?: unknown } | undefined;
    const at = coord(point);
    // A wheel is a scroll of some distance; a move is only the place.
    const wheel = typeof o.dy === "number" || typeof o.dx === "number";
    const head = wheel
      ? `${indent}${o.action} ${Number(o.dx ?? 0)}x${Number(o.dy ?? 0)} lines`
      : at
        ? `${indent}${o.action} at ${at}`
        : `${indent}${o.action}`;
    return [
      head,
      ...(wheel && at ? [`${indent}${at}`] : []),
      ...(d?.delivery === "delivered_verified"
        ? [`${indent}(the OS confirmed the pointer arrived)`]
        : []),
    ];
  }

  if (isNode(o)) return node(o, indent);
  // Generic object: its own keys, one per line.
  return Object.entries(o).flatMap(([k, v]) =>
    typeof v === "object" && v !== null
      ? [`${indent}${k}:`, ...describeBody(v, `${indent}${STEP}`)]
      : v === null || v === undefined
        ? []
        : [`${indent}${k}: ${scalar(v)}`]
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
 * Notification Center, where the index is told to the caller because it is the
 * positional the dismiss and action calls take.
 */
function inbox(o: Record<string, unknown>, indent: string): string[] {
  const list = o.notifications as Record<string, unknown>[];
  // An empty queue is also what a platform whose center never exposes its rows
  // looks like, so the two are worth telling apart here rather than at the
  // dismiss, which would only call it "expired".
  if (!list.length)
    return [
      `${indent}No notifications.`,
      `${indent}${STEP}If one is expected, the center's rows are not in the accessibility tree; see the macOS note in the README.`,
    ];
  return list.flatMap((n, i) => {
    const acts = n.actions as unknown[] | undefined;
    return [
      `${indent}#${Number(n.index ?? i + 1)} ${[n.app_name, n.title]
        .filter((v) => typeof v === "string" && v !== "")
        .join(" — ")}`,
      ...(typeof n.body === "string" && n.body
        ? [`${indent}${STEP}${clamp(n.body, 160)}`]
        : []),
      ...(acts?.length ? [`${indent}${STEP}actions: ${acts.join(", ")}`] : []),
    ];
  });
}

/** One batch result: its index, what it ran, and its own verdict. */
function perEntry(o: Record<string, unknown>, indent: string): string[] {
  const body = describeBody(o.data, `${indent}${STEP}`);
  const err = o.error as { message?: unknown } | undefined;
  const lines = [
    `${indent}#${Number(o.index) + 1} ${String(o.command)} ${
      o.ok
        ? "ok"
        : `failed: ${scalar(err?.message ?? o.error ?? "unknown error")}`
    }`,
  ];
  return body.length ? [...lines, ...body] : lines;
}

/** A session manifest: id, label, and whether it is still open. */
function manifest(list: unknown[], indent: string): string[] {
  if (!list.length) return [`${indent}No sessions.`];
  return list.map((s) => {
    const o = s as Record<string, unknown>;
    const open = typeof o.ended_at !== "number";
    return `${indent}${String(o.session_id)}${open ? " open" : " ended"}${
      o.name ? ` — ${scalar(o.name)}` : ""
    }`;
  });
}

/** A batch: how much of it ran, then one line each. */
function batch(o: Record<string, unknown>, indent: string): string[] {
  const results = o.results as unknown[];
  const done = Number(o.completed_entries ?? results.length);
  const total = Number(o.total_entries ?? results.length);
  const pending = Number(o.not_started_entries ?? 0);
  return [
    `${indent}${done} of ${total} ran, ${Number(o.elapsed_ms ?? 0)} ms, sequential and not atomic${
      pending ? `, ${pending} not started` : ""
    }`,
    ...results.flatMap((r) => describe(r, indent)),
  ];
}

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
  indent: string
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
        : scalar(o.value).replaceAll(/\s+/g, " "));
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

/** A bare point, as "x,y" — what a pointer gesture reports. */
function coord(v: unknown): string | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const { x, y } = v as { x?: unknown; y?: unknown };
  return typeof x === "number" && typeof y === "number"
    ? `${scalar(x)},${scalar(y)}`
    : undefined;
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
    (v): v is string => typeof v === "string" && v !== ""
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
  const { children } = n;
  if (Array.isArray(children))
    for (const [i, c] of children.entries())
      lines.push(...describe(c, `${indent}${STEP}`, `#${i + 1} `));
  return lines;
}

// One long value is one long token bill; the head is what identifies it.
function clamp(s: string, max = 120): string {
  const flat = s.replaceAll(/\s+/g, " ").trim();
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
const WINDOW_VISIBILITY = new Set(["maximize", "minimize", "restore"]);

// The pointer moves that leave the window alone, plus the actions that touch no
// window at all: in both cases a snapshot would only repeat the last one.
const SELFLESS_ACTIONS = new Set<string>([
  "clipboard_set",
  "clipboard_clear",
  "version",
  "skills",
  "session",
  "trace",
  "trace_export",
  "cursor_overlay",
  "dismiss_all_notifications",
  "batch",
  // A pointer move and a wheel event land on whatever is under the point; the
  // window is not re-read for either.
  "mouse_move",
  "mouse_wheel",
  // A sandbox is a whole other machine, so nothing here is on screen.
  "sandbox",
]);
// Sessions and traces name themselves; the reading half is in READ_ACTIONS and
// answers without a snapshot either.
const SELFLESS = new Set([...SELFLESS_ACTIONS, ...READ_ACTIONS]);

// The actions that are one CLI subcommand group: sub names the child, and the
// refusal lists the children rather than sending the caller to --help.
const NESTED = new Map([
  ["skills", "list, get, path"],
  ["session", "start, end, list, gc"],
  ["trace", "show, export"],
  ["cursor_overlay", "enable, disable"],
  ["sandbox", "install, create, start, stop, status, list, rm, exec"],
]);

// The refusals that are an answer rather than a failure: the command does not
// exist on this platform or build, and nothing was attempted.
const RENDER_FAILURE = ["PLATFORM_NOT_SUPPORTED"];

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
  const name = action === "trace_export" ? "trace" : action;
  const command = (COMMANDS[name] ?? name).replaceAll("_", "-");
  const args = [command];
  const ref = p.ref as string | undefined;
  const text = p.text as string | undefined;
  const key = p.key as string | undefined;
  const value = p.value as string | undefined;
  const app = p.app as string | undefined;
  const sub = p.sub as string | undefined;
  const subject = p.name as string | undefined;
  const option = p.option as string | undefined;

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
  // Actions that cannot work without the real pointer add the flag themselves,
  // but the caller may have asked for it too: clap refuses a flag given twice.
  const forceHeaded = (): void => {
    if (!p.headed) args.push("--headed");
  };

  // Only snapshot, screenshot and press take this flag; the ref commands name their
  // own window through the ref and clap rejects it there. Two windows of one app
  // are indistinguishable by name, so it is what pins the rest.
  if (WINDOW_SCOPED.has(action)) put(args, "--window-id", p.window_id);
  // The only click that takes coordinates: `click` is ref-only, so this is how a
  // node the platform gave no ref reaches (`at` from an include_bounds snapshot).
  // It is always a real pointer event, so it is headed whatever the call says.
  // A point carries no app, so a `ref` given alongside is not sent: it stays
  // for the drift check, which is the only thing that can read an app off it.
  if (action === "mouse_click") {
    const xy = coords(p.x, p.y);
    if (xy) putEq(args, "--xy", xy);
    forceHeaded();
    return args;
  }
  // A physical gesture, so it always needs the real pointer.
  if (action === "double_click" || action === "triple_click") {
    if (ref) args.push(ref);
    forceHeaded();
    return args;
  }
  // App lifecycle: the app is positional, and launching waits for a window so
  // the next snapshot has something to read.
  if (action === "launch") {
    // The launch's own bound, sent as --timeout; it is a plain number and the
    // CLI defaults it, so the call can make a slow app's launch survivable.
    put(args, "--timeout", p.timeout_ms);
    // A launched argument may begin with a hyphen, and --arg is the one option
    // with allow_hyphen_values, so the `=` form keeps clap from eating it.
    for (const a of list(p.launch_args)) putEq(args, "--arg", a);
    for (const e of list(p.launch_env)) putEq(args, "--env", e);
    putEq(args, "--cwd", p.cwd);
    if (p.no_attach) args.push("--no-attach");
    args.push("--activate");
    // `cdp` without a number still asks for one: clap wants `--cdp` alone then,
    // and only takes the count form when there is a count.
    if (typeof p.cdp === "number") args.push(`--cdp=${p.cdp}`);
    else if (p.cdp !== undefined && p.cdp !== null) args.push("--cdp");
    if (app) args.push("--", app);
    return args;
  }
  if (action === "close_app") {
    if (p.force) args.push("--force");
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
    put(args, "--duration", p.duration_ms);
    put(args, "--drop-delay", p.drop_delay_ms);
    putEq(args, "--wait-for", p.wait_for);
    putEq(args, "--wait-for-gone", p.wait_for_gone);
    putEq(args, "--wait-for-scope", p.wait_for_scope);
    put(args, "--timeout-ms", p.timeout_ms);
    return args;
  }

  // Moving the pointer lands on no element and presses nothing, so there is
  // nothing to snapshot; hover is the element-shaped form of the same move.
  if (action === "mouse_move") {
    const xy = coords(p.x, p.y);
    if (xy) putEq(args, "--xy", xy);
    forceHeaded();
    return args;
  }

  // A wheel event at a point, never at a ref: the pointing is the caller's. It
  // is a real pointer gesture, so it is headed whatever the call says.
  if (action === "mouse_wheel") {
    put(args, "--x", p.x);
    put(args, "--y", p.y);
    put(args, "--dx", p.dx);
    put(args, "--dy", p.dy);
    forceHeaded();
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
    // A lifecycle signal is answered by a baseline diff, so it needs no id or
    // title up front; --window/--window-id only narrow it.
    putEq(args, "--event", p.wait_event);
    putEq(args, "--window", p.wait_window);
    // Element waits carry their own predicate, so the two travel together.
    putEq(args, "--element", p.wait_element);
    putEq(args, "--predicate", p.predicate);
    putEq(args, "--value", p.value);
    putEq(args, "--action", p.wait_action);
    put(args, "--count", p.count);
    // The surface booleans select a mode outright, so they are bare flags.
    if (p.menu) args.push("--menu");
    if (p.menu_closed) args.push("--menu-closed");
    if (p.notification) args.push("--notification");
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

  // Sandbox is a group whose children all name a sandbox first; only install
  // and list do not. A name is lowercase letters, digits and hyphens, so it
  // never needs the `--` escape the way an arbitrary app name can - and a `--`
  // here would end flag parsing before the options that follow it. exec passes
  // a whole agent-desktop argv after `--`.
  if (action === "sandbox") {
    if (sub) args.push(sub);
    if (sub === "install") {
      if (p.provider) args.push("--", p.provider as string);
      return args;
    }
    if (sub === "list") return args;
    if (subject) args.push(subject);
    putEq(args, "--provider", p.provider as string | undefined);
    for (const s of list(p.set)) putEq(args, "--set", s);
    if (sub === "start" && p.window) args.push("--window");
    // exec's argv is the remainder, after every option.
    if (sub === "exec") args.push("--", ...list(p.exec_args));
    return args;
  }

  // The groups that need nothing beyond `sub`.
  // A subcommand group: `sub` is the child, and whatever it takes follows.
  // `trace_export` is the one child promoted to an action of its own.
  if (NESTED.has(action) || action === "trace_export") {
    if (action === "trace_export") args.push("export");
    else if (sub) args.push(sub);
    if (action === "skills" && sub === "get") put(args, "--", p.name);
    if (action === "session" && sub === "start") putEq(args, "--name", p.name);
    // `trace export` is the one child with its own action, so `sub` is optional
    // there and defaults to it; `show` answers in the result, `export` writes.
    if (action === "trace" || action === "trace_export") {
      put(args, "--limit", p.limit);
      if (action === "trace_export") {
        putEq(args, "--out", p.path);
        return args;
      }
    }
    return args;
  }

  if (action === "version") return args;

  // Notifications are an OS queue, not a window: the index is positional, so a
  // `--` would only turn it into a flag value.
  if (action === "list_notifications") {
    putEq(args, "--app", p.app);
    put(args, "--limit", p.limit);
    return args;
  }
  if (action === "dismiss_all_notifications") {
    putEq(args, "--app", p.app);
    // The OS notification surface is not accessibility-backed, so the CLI
    // refuses every mutation without the physical path.
    forceHeaded();
    return args;
  }
  if (action === "dismiss_notification") {
    if (typeof p.index === "number") args.push(String(p.index));
    // --app is a filter here, not the identity guard: a call with it and no
    // expected field is rejected as an index the caller cannot vouch for.
    putEq(args, "--expected-app", p.app);
    putEq(args, "--expected-title", p.expected_title);
    forceHeaded();
    return args;
  }
  if (action === "notification_action") {
    if (typeof p.index === "number") args.push(String(p.index));
    putEq(args, "--expected-app", p.app);
    putEq(args, "--expected-title", p.expected_title);
    // Every flag goes before `--`, which ends flag parsing.
    forceHeaded();
    if (option) args.push("--", option);
    return args;
  }

  if (action === "open_system_surface") {
    putEq(args, "--surface", p.surface);
    return args;
  }

  // The batch payload is one JSON positional, and a batch never throws on a
  // partial failure: the results carry their own ok, so a per-entry verdict is
  // worth more than an error about the whole call.
  if (action === "batch") {
    if (p.stop_on_error) args.push("--stop-on-error");
    args.push("--", JSON.stringify(batchEntries(p.steps)));
    return args;
  }
  if (action === "clipboard_get") {
    putEq(args, "--format", p.format);
    if (typeof p.path === "string" && p.path) putEq(args, "--out", p.path);
    return args;
  }
  if (action === "clipboard_clear") return args;
  // Text is positional and may begin with a hyphen, so `--` ends flag parsing.
  if (action === "clipboard_set") {
    // A file and a file list are options; only the plain text is positional.
    putEq(args, "--image", p.image);
    for (const f of list(p.file_url)) putEq(args, "--file-url", f);
    // Written through a pipe, so the CLI takes it as stdin rather than argv.
    if (p.stdin_text !== undefined) args.push("--stdin");
    else if (text !== undefined) args.push("--", text);
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
    // A screenshot can name a display instead of a window, and write a file
    // rather than answer base64; the path is positional.
    if (action === "screenshot") {
      put(args, "--screen", p.screen);
      if (typeof p.path === "string" && p.path) args.push("--", p.path);
    }
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
    // Both ask the OS for what is missing rather than only naming it.
    if (action === "permissions") {
      if (p.request) args.push("--request");
      if (p.guide) args.push("--guide");
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

/**
 * `session start` mints its own id and ignores `--session`, so a nested start
 * runs with the session id cleared. It also seeds refs, and a ref whose
 * namespace has a manifest is one the CLI will not fall back from.
 */
export function startArgs(p: Record<string, unknown>): string[] {
  const args = ["session", "start"];
  if (p.sub === "start" && p.name) putEq(args, "--name", p.name);
  return args;
}

/** The id a start answered with, since `session start` mints its own. */
function adopt(stdout: string): string | undefined {
  try {
    const { data } = JSON.parse(stdout) as {
      data?: { session_id?: unknown; id?: unknown };
    };
    const id = data?.session_id ?? data?.id;
    if (typeof id === "string" && id) session = id;
  } catch {
    // An unparseable answer leaves the old id; the text still says what ran.
  }
  return session;
}

/** The CLI takes a whole point as one "x,y" argument, not two. */ function coords(
  x: unknown,
  y: unknown
): string | undefined {
  return typeof x === "number" && typeof y === "number"
    ? `${x},${y}`
    : undefined;
}

/**
 * A batch entry, in the shape the CLI validates: options go under `args` by
 * their long name, without the dashes, and a command that takes none omits the
 * key rather than sending an empty array (which is rejected as a wrong type).
 */
function batchEntries(steps: unknown): { command: unknown; args?: unknown }[] {
  if (!Array.isArray(steps)) return [];
  return steps.map((s: { command?: unknown; args?: unknown }) => ({
    command: s.command,
    ...(s.args ? { args: s.args } : {}),
  }));
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

/** The entries of a repeatable option; anything that is not a list is empty. */
function list(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((e): e is string => typeof e === "string" && e !== "")
    : [];
}

/**
 * A tool `session start` (or `session end`) run by the agent itself: it moves the
 * id the *run* is in, so the hook must not end a session that is already closed.
 */
function markSessionArgs(args: unknown[], ok: boolean): void {
  if (args[0] !== "session" || !ok) return;
  if (args[1] === "start") inRun = true;
  if (args[1] === "end") inRun = false;
}

/**
 * The pid in a `run-<µs>-<pid>-<n>` id, which is also the directory name.
 *
 * The field order matters: index 1 is the microsecond timestamp and only index
 * 2 is the pid. Reading index 1 yields a 13-digit number that is never a live
 * pid, so every session looks dead the moment it is checked.
 */
export function pidOf(dir: string): number | undefined {
  const pid = Number(dir.split("-")[2]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/** The manifest path of a session id. */
const manifestOf = (dir: string) => join(storeDir(), dir, "session.json");

/** Whether a session id still has a manifest: `session list` shows only those. */
function hasManifest(dir: string): boolean {
  return existsSync(manifestOf(dir));
}

/** When a `run-<µs>-<pid>-<n>` record was made, per its own name. */
function born(dir: string): number {
  return Number(/^run-(\d+)-/.exec(dir)?.[1]) || 0;
}

/** Whether the session has ended, per its manifest. */
function ended(dir: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(manifestOf(dir), "utf-8")) as {
      ended_at?: unknown;
    };
    return manifest.ended_at !== undefined;
  } catch {
    return false; // no manifest yet, or unreadable
  }
}

/** Agent-desktop covers Windows too, where the POSIX helpers below differ. */
const WINDOWS = process.platform === "win32";

/**
 * The command that fails when `file` is locked elsewhere. Windows has no
 * `lockf`, macOS ships no command for one, so the two reach it differently.
 */
function lockProbe(file: string): [string, string[]] {
  if (WINDOWS)
    return [
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `$f=[IO.File]::Open('${file.replaceAll(
          "'",
          "''"
        )}','Open','ReadWrite','None'); $f.close()`,
      ],
    ];
  const probe = [
    "-c",
    "import fcntl,sys",
    'f=open(sys.argv[1],"a+")',
    "fcntl.lockf(f,fcntl.LOCK_EX|fcntl.LOCK_NB)",
  ].join("\n");
  return ["python3", [probe, file]];
}

/**
 * Global installs of the CLI, from whichever package manager put it there.
 * `which` is a POSIX tool; Windows has `where.exe`. Both are tried so a
 * shim-managed shell that fakes one still finds the other.
 */
async function onPath(exec: ExtensionAPI["exec"]): Promise<string[]> {
  const [lookup, ...rest] = WINDOWS
    ? (["where.exe", "where"] as const)
    : (["which"] as const);
  const bins = [lookup, ...rest];
  for (const bin of bins) {
    const r = await exec(bin, ["agent-desktop"], {
      timeout: 3000,
      ...sessionEnv(),
    }).catch(() => undefined);
    if (r?.code !== 0) continue;
    // `where` can answer several; the .cmd shim npm and bun write comes first.
    const found = r.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (found.length) return found;
  }
  return [];
}

/** Whether a pid still exists; `0` only probes, it sends nothing. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const ORPHAN = /^run-\d+-\d+-\d+$/;

/**
 * How long a dead-but-new record is spared. Long enough that a session still
 * settling is kept, short enough that the record a turn leaves is collected by
 * the next one.
 *
 * This, not the pid, is what actually protects a record. `session start` names
 * its id after its own short-lived child, which has already exited by the time
 * the start returns, so a live run's session always looks dead on the pid test.
 * The check still earns its place: a record whose pid was reused by something
 * else is skipped rather than collected under a running process.
 */
const GRACE = { ms: 30_000 };

export default function (pi: ExtensionAPI) {
  api = pi;
  let ready = false; // CLI present and answering
  // pi.exec does not throw on a non-zero exit, so the exit code is the only
  // honest signal.
  // A start mints a new id; it is adopted here so no caller can forget to, and
  // so `session end` later releases the session the start actually made.
  //
  // `release` is the one name in here that is not a CLI command: it drops the
  // lock file the start leaves behind.
  async function call(
    args: string[],
    runBin: string,
    runArgs: string[],
    isStart: boolean
  ): Promise<{ ok: boolean; why?: string }> {
    if (args[0] === "release") {
      await release();
      return { ok: true };
    }
    try {
      const r = await pi.exec(runBin, runArgs, {
        timeout: 5000,
        ...sessionEnv(),
      });
      if (isStart) adopt(r.stdout);
      const ok = r.code === 0;
      markSessionArgs(args, ok);
      // Only a failure needs saying; the success path stays a boolean.
      return ok
        ? { ok }
        : { ok, why: `${r.stdout}${r.stderr}`.trim().slice(0, 200) };
    } catch (error) {
      return {
        ok: false,
        why: (error instanceof Error ? error.message : String(error)).slice(
          0,
          200
        ),
      };
    }
  }

  async function tell(ctx: ExtensionContext, ...args: string[]) {
    if (!ready || !cmd) return false;
    // Three calls run unprefixed: a start, because the id it would inherit
    // belongs to the run that just settled and a sealed session refuses to start
    // under itself; `session gc`, which is store-wide and refuses a scope at
    // all; and `release`, which is not a CLI command at all.
    const bare =
      args[0] === "session" && (args[1] === "gc" || args[1] === "start");
    const [runBin, runArgs] = bare ? [cmd, args] : withSession(cmd, args);
    const isStart = args[0] === "session" && args[1] === "start";
    const { ok, why } = await call(args, runBin, runArgs, isStart);
    if (!ok && ctx.hasUI)
      ctx.ui.notify(
        `agent-desktop ${args[0]} ${args[1]} failed${why ? `: ${why}` : ""}`,
        "warning"
      );
    return ok;
  }

  // A candidate must answer, not merely exist: the checkout's bin is a Node
  // launcher that is always executable and dies on the native binary missing
  // beside it, so accepting it on mode alone never reaches the PATH fallback.
  async function probe(bin: string): Promise<boolean> {
    // The tool list is the real question, not just that the binary loads. Bare:
    // on Windows there would be no `sh` to prefix it with.
    const [runBin, runArgs] = NATIVE
      ? [bin, ["list-apps"]]
      : withSession(bin, ["list-apps"]);
    try {
      const r = await pi.exec(runBin, runArgs, {
        timeout: 5000,
        ...sessionEnv(),
      });
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
    const installed = await onPath((b, a, o) => pi.exec(b, a, o));
    for (const candidate of [SOURCE_BIN, ...installed]) {
      // `which` answers with an empty line, so only a real path counts.
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
    NATIVE = WINDOWS;
    const found = await discover();
    // A reload is exactly what strands these, so the next startup is the right
    // moment; `cmd` is also how pruneOrphans knows the layout it is reading.
    if (found) await pruneOrphans(ctx);
    if (ctx.hasUI && ctx.mode === "tui" && event.reason === "startup") {
      // A missing CLI is otherwise invisible until the first call fails, and
      // the pill would claim ready either way.
      ctx.ui.setStatus(
        "agent-desktop",
        found ? "🖥 ready" : "🖥 no agent-desktop on PATH"
      );
    }
  });

  pi.on("agent_start", async (_e, ctx) => {
    // --cursor turns on the visual cursor overlay: it draws where actions land
    // and never replaces the pointer. A platform without a renderer answers
    // rendered:false instead of failing, so it is asked for unconditionally.
    //
    // The start mints its own id and ignores `--session`, and the id set at
    // session_start is a local placeholder with no manifest behind it. Adopting
    // the minted one is what gives this run a manifest, a trace directory and
    // the namespace its refs belong to; without it every later call stays on
    // the placeholder, where `session list` shows no manifest and `trace` no
    // trace directory.
    inRun = (await tell(ctx, "session", "start", "--cursor")) || inRun;
    // A start names its id after its own short-lived child, so the "is this pid
    // alive" test says nothing about the pid a session's own lock is held by.
    // While another session holds a store lock, `session gc` keeps everything,
    // so this turn gives that lock up first — after the start, so the run lands
    // in its session.
    if (inRun) await tell(ctx, "release");
  });

  pi.on("agent_settled", async (_e, ctx) => {
    // The CLI keeps a directory without a manifest out of its own list, and
    // answers "has no manifest" if that id is handed back to it. A start can
    // land that way, and a placeholder always is, so only the two together make
    // an end worth sending.
    // An errored start may still have opened a session, so the disk decides.
    const endable = session !== undefined && hasManifest(session);
    inRun = endable && !(await tell(ctx, "session", "end"));
    // A killed reload ends nothing, so the pile grows turn by turn. Pruning runs
    // here, after the end above, so this run's own session is not still alive
    // when the check counts it.
    await pruneOrphans(ctx);
  });

  // A session directory is dead once its process is gone and its manifest shows
  // no end: a reload kills pi and leaves exactly that, so they pile up and a day
  // of gc never reaches one from today. An unreadable manifest counts as dead
  // too — it is what warns "has no manifest" whenever the CLI is handed it.
  //
  // It waits for the run to end rather than firing on `agent_end`, which also
  // runs before a retry: a retried run would otherwise have its trace pruned
  // while Pi was still on it.
  async function pruneOrphans(ctx: ExtensionContext) {
    if (!cmd) return;
    const store = storeDir();
    const dirs = await readdir(store).catch(() => [] as string[]);
    const now = Date.now();
    const orphans: string[] = [];
    for (const dir of dirs) {
      const pid = pidOf(dir);
      if (pid === undefined || !ORPHAN.test(dir) || alive(pid)) continue;
      // Age is the deciding test, for the reason GRACE gives: the pid is a
      // child that is always gone, so it cannot tell a live run from a dead
      // one. Past the grace the record is collected whatever its manifest says;
      // within it, an ended record is already done and goes at once.
      if (now - born(dir) >= GRACE.ms || ended(dir)) orphans.push(dir);
    }
    let pruned = 0;
    for (const dir of orphans) pruned += await prune(dir);
    if (pruned && ctx.hasUI)
      ctx.ui.notify(
        `agent-desktop pruned ${pruned} session record(s) a dead run left`,
        "info"
      );
  }

  /**
   * Drop the CLI's store lock on this run's session, keeping its end. The lock
   * file stays behind with a dead holder, and while any one is held `session gc`
   * keeps everything.
   */
  async function release(): Promise<void> {
    if (!cmd || !session?.startsWith("run-")) return;
    const file = join(storeDir(), session, "refstore.lock");
    if (!existsSync(file)) return;
    // An exclusive probe either takes the lock or fails: a fail is left for
    // whoever still holds it. Windows also locks the file against deletion while
    // open, so there the probe itself lifts the lock.
    const [bin, args] = lockProbe(file);
    const free = await pi
      .exec(bin, args, { timeout: 2000, ...sessionEnv() })
      .catch(() => undefined);
    if (free?.code !== 0) return;
    // Windows also locks the file against deletion while it is open, so a
    // failure there is not worth surfacing; POSIX keeps its error.
    await rm(file, { force: true }).catch(
      WINDOWS ? () => undefined : undefined
    );
  }

  async function prune(dir: string): Promise<number> {
    const store = storeDir();
    const manifest = await readFile(join(store, dir, "session.json"), "utf-8")
      .then((raw) => JSON.parse(raw) as { ended_at?: unknown })
      .catch(() => undefined);
    if (manifest?.ended_at !== undefined) return 0;
    await rm(join(store, dir), { recursive: true, force: true });
    return 1;
  }

  pi.on("session_shutdown", async (_e, ctx) => {
    // A reload tears the process tree down mid-run, so no settle ever ends the
    // run's session. Only an id the CLI can find may be ended: the placeholder
    // is not a session at all.
    if (inRun && session && hasManifest(session))
      await tell(ctx, "session", "end");
    // A run starts and ends a session, so one Pi session leaves one directory per
    // turn and they are never collected on their own. A day is old enough that a
    // trace is unlikely to be wanted and young enough to keep the store bounded.
    // --ended also drops the CLI's recent-activity veto, so a just-ended record
    // goes too rather than lingering for its trace window.
    await tell(ctx, "session", "gc", "--ended");
    await pruneOrphans(ctx);
    inRun = false;
    session = undefined;
    if (ctx.hasUI) ctx.ui.setStatus("agent-desktop", undefined);
  });

  pi.registerTool(cli);
}
