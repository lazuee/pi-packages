import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { sessionPath } from "./core/agents.js";
import type { AgentFleet } from "./fleet/index.js";
import type { PaneInfo } from "./types.js";

/**
 * Tells a killed worker's owning parent that it is gone, so its bookkeeping does
 * not keep waiting. Silent when the caller is that parent, when the worker was
 * never spawned by an agent, or when the parent no longer holds a live pane.
 *
 * The ancestry entry is a shepherdr one, not a notes entry, so the shared saved
 * session reader filters it out; the client reads it directly, on whichever
 * machine holds the file. An unreadable file skips the notice, never the kill.
 */
export async function notifyKilledParent(
  fleet: AgentFleet,
  ctx: ExtensionContext,
  panel: PaneInfo,
  options: { machine: string; childName?: string | null }
): Promise<boolean> {
  const file = sessionPath(panel);
  if (!file) return false;
  const self = ctx.sessionManager.getSessionFile();
  if (self === file) return false;
  let parentFile: string | undefined;
  try {
    parentFile = await fleet
      .connected(options.machine)
      .client.sessionAncestry(file);
  } catch {
    return false;
  }
  if (!parentFile || parentFile === self) return false;
  const label = options.childName ?? panel.name ?? panel.pane_id;
  let snapshots;
  try {
    snapshots = await fleet.snapshots(options.machine);
  } catch {
    return false;
  }
  for (const { id, snapshot } of snapshots) {
    const parent = snapshot?.agents.find(
      (candidate) => sessionPath(candidate) === parentFile
    );
    if (!parent) continue;
    try {
      await fleet.connected(id).client.sendMessage(parent, {
        text: `<herdr_sender kind="killed" machine="${options.machine}" terminal="${panel.pane_id}" />\n${label} was killed by another session and its terminal is gone. Stop waiting on it, and do not resend unless the work is still needed.`,
        sender: `<herdr_sender kind="killed" terminal="${panel.pane_id}" />`,
      });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}
