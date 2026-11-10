import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function toolSurfaceDriver(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "inspect_ask_surface",
    label: "Inspect ask surface",
    description: "Read the real registered ask commands and tools.",
    parameters: Type.Object({}),
    execute() {
      const tools = pi.getAllTools();
      const details = {
        commands: (() => {
          try {
            return pi.getCommands().map((command) => command.name);
          } catch (error) {
            return [`ERR ${String(error)}`];
          }
        })(),
        tools: tools.map((tool) => tool.name),
        toolGuidelines: Object.fromEntries(
          tools.map((tool) => [tool.name, tool.promptGuidelines ?? []]),
        ),
      };
      return Promise.resolve({
        content: [{ type: "text", text: JSON.stringify(details) }],
        details,
      });
    },
  });

  // The first run's tool snapshot predates ask_user's session_start registration.
  pi.registerTool({
    name: "ask_a_question",
    label: "Ask a question",
    description: "Run a real ask_user call from an extension tool.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) {
      const drive = (keys: string) => {
        for (const key of keys) process.stdin.emit("data", key);
      };
      drive("\r");
      const call = (): Promise<unknown> =>
        ctx.executeTool("ask_user", {
          title: "surface",
          questions: [
            {
              id: "color",
              prompt: "Choose a color",
              options: [
                { value: "red", label: "Red" },
                { value: "blue", label: "Blue" },
              ],
            },
          ],
        });
      globalThis.setTimeout(() => drive("\r"), 200);
      const results: Record<string, string> = {};
      try {
        const answer = Promise.race([
          call(),
          new Promise((resolve) =>
            globalThis.setTimeout(() => resolve("form still open"), 2000),
          ),
        ]);
        results.answer = JSON.stringify(await answer).slice(0, 60);
      } catch (error) {
        results.answer = String(error);
      }
      // The first-turn snapshot predates the session_start registration of ask_user.
      return {
        content: [{ type: "text" as const, text: JSON.stringify(results) }],
        details: results,
      };
    },
  });
}
