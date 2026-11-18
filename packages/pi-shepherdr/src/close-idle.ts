import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { getSnapshot, sessionPath } from "./core/agents.js";
import type { ConnectedMachine, AgentFleet } from "./fleet/index.js";
import { spawnedChildren } from "./spawn-ownership.js";
import type { SpawnOwnership } from "./spawn-ownership.js";
import type { PaneInfo } from "./types.js";

/** An owned child confirmed still idle and verified, so closing it is safe. */
export interface IdleChild {
  child: SpawnOwnership;
  name?: string;
}

/** The guards that make closing safe: owned, ours, live, idle and unwatched. */
async function closable(
  fleet: AgentFleet,
  ctx: ExtensionContext,
  child: SpawnOwnership,
  current: () => boolean
): Promise<{ panel: PaneInfo; runtime: ConnectedMachine } | undefined> {
  if (!current()) return undefined;
  const runtime = fleet.connected(child.machine);
  const status = fleet.statuses().find((value) => value.id === runtime.machine);
  if (!status || status.status !== "connected" || status.monitoringIssue)
    return undefined;
  const identity = await runtime.client.machineIdentity();
  const snapshot = await getSnapshot(runtime.client);
  const panel = snapshot.agents.find((value) => value.pane_id === child.pane);
  const record = runtime.monitor
    .list()
    .find((value) => value.terminalId === child.terminal);
  if (
    !current() ||
    !spawnedChildren(ctx).some(
      (value) =>
        value.machine === child.machine &&
        value.pane === child.pane &&
        value.terminal === child.terminal &&
        value.sessionFile === child.sessionFile
    ) ||
    identity.host !== child.host ||
    identity.session !== child.session ||
    !panel ||
    panel.agent !== "pi" ||
    panel.terminal_id !== child.terminal ||
    sessionPath(panel) !== child.sessionFile ||
    (runtime.local && panel.pane_id === process.env["HC_TERMINAL_ID"]) ||
    snapshot.agents.some(
      (value) =>
        value.pane_id !== child.pane && sessionPath(value) === child.sessionFile
    ) ||
    panel.interactive_ready !== true ||
    panel.launch_pending === true ||
    (panel.agent_status !== "idle" && panel.agent_status !== "done") ||
    !record ||
    record.paneId !== child.pane ||
    record.activity.phase !== "settled" ||
    (record.activity.status !== "idle" && record.activity.status !== "done")
  )
    return undefined;
  return { panel, runtime };
}

/** Owned children that would close right now, for a picker to offer. */
export async function listIdleChildren(
  fleet: AgentFleet,
  ctx: ExtensionContext,
  current: () => boolean
): Promise<IdleChild[]> {
  const idle: IdleChild[] = [];
  for (const child of spawnedChildren(ctx)) {
    if (!current()) break;
    try {
      const ok = await closable(fleet, ctx, child, current);
      if (!ok) continue;
      idle.push({ child, ...(ok.panel.name ? { name: ok.panel.name } : {}) });
    } catch {
      // A machine that cannot be inspected is simply not offered.
    }
  }
  return idle;
}

export async function closeIdleChildren(
  fleet: AgentFleet,
  ctx: ExtensionContext,
  current: () => boolean,
  only?: ReadonlySet<string>
): Promise<string> {
  let closed = 0;
  let skipped = 0;
  const failures: string[] = [];
  for (const child of spawnedChildren(ctx)) {
    if (only && !only.has(child.terminal)) continue;
    if (!current()) break;
    try {
      const ok = await closable(fleet, ctx, child, current);
      if (!ok) {
        skipped += 1;
        continue;
      }
      await ok.runtime.client.sendMessage(ok.panel, {
        text: "/quit",
        sender: '<herdr_sender kind="idle-close" />',
        closeIfIdle: true,
      });
      closed += 1;
    } catch (error) {
      skipped += 1;
      failures.push(
        `${child.machine}:${child.pane}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return [
    `Closed ${closed} idle child sessions; skipped ${skipped}.`,
    ...failures,
  ].join("\n");
}
