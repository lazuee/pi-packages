import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { sessionPath } from "./core/agents.js";
import type { AgentFleet } from "./fleet/index.js";
import type { PaneInfo } from "./types.js";

/**
 * Tells a killed worker's owning parent that it is gone, so its bookkeeping does
 * not keep waiting. Silent when the caller is that parent, when the worker was
 * never spawned by an agent, or when the parent no longer holds a live pane.
 *
 * Returns `"sent"`, `"skipped"` for an answer that is not owed, and `"failed"`
 * when one was due but the parent could not be read or reached — the kill
 * itself stands either way, so the caller reports the difference instead of
 * claiming a worker was told.
 *
 * The ancestry entry is a shepherdr one, not a notes entry, so the shared saved
 * session reader filters it out; the client reads it directly, on whichever
 * machine holds the file. An unreadable file skips the notice, never the kill.
 *
 * The caller passes the snapshot it already loaded, because a killed worker is
 * out of the agent list while its file still names the parent; the file is read
 * only when the snapshot has already lost the pane.
 */
export async function notifyKilledParent(
  fleet: AgentFleet,
  ctx: ExtensionContext,
  panel: PaneInfo,
  options: {
    machine: string;
    childName?: string | null;
    panes?: readonly PaneInfo[];
  }
): Promise<NoticeOutcome> {
  const file = sessionPath(panel);
  if (!file) return "skipped";
  const self = ctx.sessionManager.getSessionFile();
  if (self === file) return "skipped";
  const parentFile =
    options.panes?.find((pane) => sessionPath(pane) === file)?.ancestry ??
    (await fleet
      .connected(options.machine)
      .client.sessionAncestry(file)
      .catch(() => undefined));
  if (!parentFile || parentFile === self) return "skipped";
  const label = options.childName ?? panel.name ?? panel.pane_id;
  const live = await fleet.snapshots(options.machine).catch(() => undefined);
  if (!live) return "failed";
  for (const { id, snapshot } of live) {
    const parent = snapshot?.agents.find(
      (candidate) => sessionPath(candidate) === parentFile
    );
    if (!parent) continue;
    return (await send(fleet, id, parent, panel, label, options.machine))
      ? "sent"
      : "failed";
  }
  return "failed";
}

export type NoticeOutcome = "sent" | "skipped" | "failed";

async function send(
  fleet: AgentFleet,
  machine: string,
  parent: PaneInfo,
  panel: PaneInfo,
  label: string,
  target: string
): Promise<boolean> {
  try {
    await fleet.connected(machine).client.sendMessage(parent, {
      text: `<herdr_sender kind="killed" machine="${target}" terminal="${panel.pane_id}" />\n${label} was killed by another session and its terminal is gone. Stop waiting on it, and do not resend unless the work is still needed.`,
      sender: `<herdr_sender kind="killed" terminal="${panel.pane_id}" />`,
    });
    return true;
  } catch {
    return false;
  }
}
