import { describe, expect, it, vi } from "vitest";
import type { ArmState } from "#src/arm-tool";
import { createArmTool } from "#src/arm-tool";

function harness() {
  let state: ArmState = { armed: false };
  const persist = vi.fn();
  const tool = createArmTool({
    state: () => state,
    arm: (goal) => {
      state = { armed: true, goal };
    },
    disarm: () => {
      state = { armed: false };
    },
    persist,
  });
  return { tool, state: () => state, persist };
}

const run = (
  tool: ReturnType<typeof harness>["tool"],
  action: "arm" | "disarm",
  goal?: string,
) => tool.execute("id", { action, goal }, undefined, undefined, {} as never);

describe("continue_arm tool", () => {
  it("arms with a goal and persists", async () => {
    const h = harness();
    const result = await run(h.tool, "arm", "get the suite green");
    expect(h.state()).toEqual({ armed: true, goal: "get the suite green" });
    expect(h.persist).toHaveBeenCalledOnce();
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("get the suite green"),
    });
  });

  it("arms without a goal", async () => {
    const h = harness();
    const result = await run(h.tool, "arm", "   ");
    expect(h.state().armed).toBe(true);
    expect(h.state().goal).toBeUndefined();
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("without"),
    });
  });

  it("disarms and persists", async () => {
    const h = harness();
    await run(h.tool, "arm");
    await run(h.tool, "disarm");
    expect(h.state().armed).toBe(false);
    expect(h.persist).toHaveBeenCalledTimes(2);
  });
});
