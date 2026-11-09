/* eslint-disable @typescript-eslint/require-await -- Pi's tool `execute` must return a promise; the work here is synchronous. */
/**
 * The agent-facing arm tool.
 *
 * The operator asks for a long unattended run ("iterate until the tests pass"),
 * and the agent arms its own recovery around it rather than the operator
 * remembering a command beforehand. A run's branch survives a restart, so a
 * resume picks the arming back up.
 */

import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";

/** The arm state the tool reads and writes. */
export interface ArmState {
  armed: boolean;
  goal?: string;
  armedAt?: number;
}

/**
 * Registration deps. `persist` writes the state to the session so a resume can
 * restore it; `render` feeds the status line.
 */
export interface ArmToolDeps {
  state: () => ArmState;
  arm: (goal: string | undefined) => void;
  disarm: () => void;
  persist: () => void;
}

export const ARM_TOOL_NAME = "continue_arm";

/** The two shapes this tool reports, so one generic accepts both. */
export type ArmDetails = { kind: "arm" } | { kind: "disarm" };

export function createArmTool(deps: ArmToolDeps) {
  return defineTool({
    name: ARM_TOOL_NAME,
    label: "Continue Arm",
    description:
      "Arm or disarm automatic recovery for this session. Armed, a run that stalls is nudged back into motion at the settle boundary. Arm it when the operator asked for unattended work and you are about to start; disarm when the task is done.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("arm"), Type.Literal("disarm")]),
      goal: Type.Optional(
        Type.String({
          description: "One line naming the work a recovery should resume.",
        }),
      ),
    }),
    async execute(_id, params) {
      if (params.action === "disarm") {
        deps.disarm();
        deps.persist();
        return {
          content: [{ type: "text" as const, text: "Auto-continue disarmed." }],
          details: { kind: "disarm" } as ArmDetails,
        };
      }
      deps.arm(params.goal?.trim() || undefined);
      deps.persist();
      const goal = deps.state().goal;
      return {
        content: [
          {
            type: "text" as const,
            text: goal
              ? `Auto-continue armed for: ${goal}`
              : "Auto-continue armed without a goal. Call it again with a goal to name the work.",
          },
        ],
        details: { kind: "arm" } as ArmDetails,
      };
    },
  });
}
