import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { CoreConnection } from "../core/backend.js";
import { AgentMonitor } from "../monitor.js";
import { setChildSupervision } from "../spawn-ownership.js";
import { errorMessage, LOCAL_MACHINE } from "./machine.js";
import type { MachineRuntime } from "./machine.js";

interface FleetMonitorEvents {
  isAttached(): boolean;
  context(): ExtensionContext | undefined;
  changed(): void;
  refresh(): void;
  disconnected(reason: string): void;
}

/** Owns the local/remote monitoring adapter and its warning/recovery policy. */
export function createMachineMonitor(
  machine: string,
  runtime: MachineRuntime,
  client: CoreConnection,
  pi: ExtensionAPI,
  events: FleetMonitorEvents
): AgentMonitor {
  const selfPaneId = runtime.local ? process.env["HC_TERMINAL_ID"] : undefined;
  return new AgentMonitor(pi, {
    client,
    machine,
    machineLabel: () => runtime.coreMachine?.name ?? LOCAL_MACHINE,
    onChange: () => events.changed(),
    onRefresh: () => events.refresh(),
    operatorPrefix: "hc",
    onWarning: (issue) => {
      if (!events.isAttached()) return;
      if (!runtime.local && issue.state === "unavailable") {
        events.disconnected(issue.message);
        return;
      }
      runtime.monitoringIssue = {
        ...issue,
        message: errorMessage(issue.message),
      };
      events.refresh();
      events
        .context()
        ?.ui.notify(
          `${machine}: ${issue.message}${runtime.local ? "" : "\nOpen /herdr → Status to reconnect"}`,
          "warning"
        );
    },
    onRecovered: () => {
      if (!events.isAttached() || !runtime.monitoringIssue) return;
      delete runtime.monitoringIssue;
      events.refresh();
      if (runtime.monitor?.list().length)
        events
          .context()
          ?.ui.notify(`Core monitoring restored: ${machine}`, "info");
    },
    reconnect: runtime.local,
    // The record is gone by now, so supervision no longer restores the worker.
    onRemoval: (record) => {
      if (!events.isAttached()) return;
      const context = events.context();
      if (!context) return;
      try {
        setChildSupervision(
          pi,
          context,
          runtime.local ? LOCAL_MACHINE : machine,
          { pane_id: record.paneId },
          false
        );
      } catch {
        /* empty */
      }
      context.ui.notify(
        `${machine} / ${record.name ?? record.paneId} exited before its work settled`,
        "warning"
      );
    },
    ...(client.reader ? { reader: client.reader } : {}),
    ...(selfPaneId ? { selfPaneId } : {}),
  });
}
