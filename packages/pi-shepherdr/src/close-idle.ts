import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { getSnapshot, sessionPath } from "./core/agents.js";
import { terminalPane } from "./core/terminal.js";
import type { ConnectedMachine, AgentFleet } from "./fleet/index.js";
import { spawnedChildren } from "./spawn-ownership.js";
import type { SpawnOwnership } from "./spawn-ownership.js";
import type { PaneInfo } from "./types.js";

/** An owned child confirmed still idle and verified, so closing it is safe. */
export interface IdleChild {
  child: SpawnOwnership;
  name?: string;
  /** Its program already exited; the terminal is reaped instead of asked to quit. */
  dead?: true;
}

/**
 * A child whose program exited on its own. It has no receiver left to answer
 * `/quit`, and no monitor record either, so it cannot pass `closable`; what it
 * leaves behind is a finished terminal in the sidebar. Absence from the
 * snapshot is not proof, because an unreadable machine looks the same, so the
 * terminal is read directly and must report a finished, exited program.
 */
async function dead(
  fleet: AgentFleet,
  ctx: ExtensionContext,
  child: SpawnOwnership,
  current: () => boolean
): Promise<PaneInfo | undefined> {
  if (!current()) return undefined;
  const runtime = fleet.connected(child.machine);
  const status = fleet.statuses().find((value) => value.id === runtime.machine);
  if (!status || status.status !== "connected" || status.monitoringIssue)
    return undefined;
  if (runtime.monitor.list().some((r) => r.terminalId === child.terminal))
    return undefined;
  let value: Record<string, unknown>;
  try {
    value = (await runtime.client.core.request("terminal.get", {
      terminal: child.terminal,
    })) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && "kind" in error && error.kind === "not_found")
      return undefined;
    throw error;
  }
  const identity = await runtime.client.machineIdentity();
  const { address } = value;
  // A remote Core answers machine-qualified; PaneInfo wants the bare address.
  const bare =
    typeof address === "string"
      ? { ...value, address: address.split("/").at(-1) }
      : value;
  if (
    !current() ||
    identity.host !== child.host ||
    value["state"] !== "finished" ||
    value["reason"] !== "exited" ||
    !spawnedChildren(ctx).some(
      (v) =>
        v.machine === child.machine &&
        v.pane === child.pane &&
        v.terminal === child.terminal &&
        v.sessionFile === child.sessionFile
    )
  )
    return undefined;
  return terminalPane(bare);
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
      if (ok) {
        idle.push({ child, ...(ok.panel.name ? { name: ok.panel.name } : {}) });
        continue;
      }
      const gone = await dead(fleet, ctx, child, current);
      if (gone)
        idle.push({
          child,
          dead: true,
          ...(gone.name ? { name: gone.name } : {}),
        });
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
  let reaped = 0;
  let skipped = 0;
  const failures: string[] = [];
  for (const child of spawnedChildren(ctx)) {
    if (only && !only.has(child.terminal)) continue;
    if (!current()) break;
    try {
      const ok = await closable(fleet, ctx, child, current);
      if (!ok) {
        const gone = await dead(fleet, ctx, child, current);
        if (!gone) {
          skipped += 1;
          continue;
        }
        // Nothing is left to answer /quit, so reap the finished terminal.
        await fleet
          .connected(child.machine)
          .client.core.request("terminal.rm", { terminal: child.terminal });
        reaped += 1;
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
    `Closed ${closed} idle child sessions; removed ${reaped} already exited; skipped ${skipped}.`,
    ...failures,
  ].join("\n");
}
