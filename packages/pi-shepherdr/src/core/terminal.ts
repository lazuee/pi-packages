import type { AgentStatus, PaneInfo, SessionSnapshot } from "../types.js";
import { object } from "./protocol.js";
import { CORE_SESSION_LABEL, CORE_WORKER_LABEL } from "./registration.js";
import { livePiSession } from "./terminal-peer.mjs";

export function terminalPane(value: unknown): PaneInfo {
  const terminal = object(value);
  const { address } = terminal;
  if (typeof address !== "string" || !address || address.includes("/"))
    throw new Error("Expected a local Core terminal address");
  const labels = object(terminal["labels"]);
  const status = terminal["status"] == null ? {} : object(terminal["status"]);
  const { state } = status;
  const agentStatus: AgentStatus =
    state === "error"
      ? "done"
      : state === "idle" ||
          state === "working" ||
          state === "blocked" ||
          state === "done"
        ? state
        : "unknown";
  const session = livePiSession(terminal);
  const live = terminal["state"] === "live";
  return {
    // The shared legacy key is an address, not a fabricated app pane ID.
    pane_id: address,
    terminal_id: address,
    agent: typeof session === "string" && session ? "pi" : null,
    agent_status: agentStatus,
    ...(typeof terminal["cols"] === "number" ? { cols: terminal["cols"] } : {}),
    ...(typeof terminal["rows"] === "number" ? { rows: terminal["rows"] } : {}),
    ...(session && labels[CORE_WORKER_LABEL] === session
      ? { worker: true as const }
      : {}),
    interactive_ready: live && typeof session === "string" && !!session,
    launch_pending: live && !session,
    ...(typeof terminal["cwd"] === "string" ? { cwd: terminal["cwd"] } : {}),
    ...(typeof terminal["title"] === "string"
      ? { title: terminal["title"] }
      : {}),
    ...(typeof labels["pi.shepherdr.name"] === "string"
      ? { name: labels["pi.shepherdr.name"] }
      : typeof terminal["name"] === "string"
        ? { name: terminal["name"] }
        : {}),
    ...(typeof labels["herdr.space"] === "string" && labels["herdr.space"]
      ? { workspace_id: labels["herdr.space"] }
      : {}),
    ...(typeof labels["herdr.tab"] === "string" && labels["herdr.tab"]
      ? { tab_id: labels["herdr.tab"] }
      : {}),
    ...(typeof session === "string" && session
      ? {
          agent_session: {
            agent: "pi",
            kind: "path",
            source: CORE_SESSION_LABEL,
            value: session,
          },
        }
      : {}),
  };
}

/**
 * Whether a program is still running in this pane.
 *
 * The session label is the only proof: Core keeps a terminal's diff, name and
 * status after the program exits, and clears the label with it. Because `agent`,
 * `interactive_ready` and `launch_pending` all derive from that one label they
 * agree, and the status is only a second opinion — a live program can report a
 * status no one recognises, which must not read as gone.
 */
export function paneAlive(panel: PaneInfo): boolean {
  return (
    panel.agent === "pi" &&
    panel.interactive_ready === true &&
    panel.launch_pending !== true
  );
}

export function terminalSnapshot(value: unknown): SessionSnapshot {
  const { terminals } = object(value);
  if (!Array.isArray(terminals))
    throw new TypeError("Core returned no terminals");
  const panes = terminals
    .filter((value) => {
      const terminal = object(value);
      return (
        terminal["state"] === "live" &&
        typeof terminal["address"] === "string" &&
        !terminal["address"].includes("/")
      );
    })
    .map(terminalPane);
  const workspaces = [
    ...new Set(
      panes.flatMap((pane) => (pane.workspace_id ? [pane.workspace_id] : []))
    ),
  ].map((id) => ({ workspace_id: id, label: id }));
  const tabs = [
    ...new Map(
      panes.flatMap((pane) =>
        pane.tab_id && pane.workspace_id
          ? [
              [
                pane.tab_id,
                {
                  tab_id: pane.tab_id,
                  workspace_id: pane.workspace_id,
                  label: pane.tab_id,
                },
              ] as const,
            ]
          : []
      )
    ).values(),
  ];
  return {
    panes,
    agents: panes.filter((pane) => pane.agent === "pi"),
    tabs,
    workspaces,
  };
}
