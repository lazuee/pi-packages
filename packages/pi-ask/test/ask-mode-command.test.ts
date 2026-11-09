import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { onTestFinished, test } from "vitest";
import { AskModeController, getProjectAskConfigPath } from "#src/ask-mode";
import { registerAskModeCommand } from "#src/ask-mode-command";
import { AskConfigStore } from "#src/config/store";

const HAS_UI = "hasUI";
async function setup() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-ask-mode-command-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const choices: Array<string | undefined> = [];
  const notices: string[] = [];
  const confirmations: string[] = [];
  const mode = new AskModeController(
    new AskConfigStore(join(cwd, "global.json")),
    () => {
      // The controller's resulting mode is asserted below.
    },
  );
  const ctx = {
    cwd,
    mode: "tui",
    [HAS_UI]: true,
    isProjectTrusted: () => true,
    ui: {
      select() {
        return Promise.resolve(choices.shift());
      },
      confirm(_title: string, message: string) {
        confirmations.push(message);
        return Promise.resolve(true);
      },
      notify(message: string) {
        notices.push(message);
      },
    },
  } as unknown as ExtensionCommandContext;
  await mode.initialize(ctx);
  let handler: (
    args: string,
    context: ExtensionCommandContext,
  ) => Promise<void> | void = () => {
    throw new Error("Command not registered");
  };
  registerAskModeCommand(
    {
      registerCommand(name, command) {
        assert.equal(name, "ask-mode");
        handler = command.handler;
      },
    } as Pick<ExtensionAPI, "registerCommand"> as ExtensionAPI,
    mode,
  );
  return {
    ctx,
    mode,
    choices,
    notices,
    confirmations,
    run: (args: string) => handler(args, ctx),
  };
}

test("/ask-mode selects a project override and asks before changing used-session tools", async (_t) => {
  const state = await setup();
  state.mode.markModelRequest();
  state.choices.push("Project override", "Background-only");
  await state.run("");
  assert.equal(state.mode.backgroundOnly, true);
  assert.equal(state.confirmations.length, 1);
  assert.equal(
    JSON.parse(await readFile(getProjectAskConfigPath(state.ctx.cwd), "utf8"))
      .behaviour.backgroundOnly,
    true,
  );
  await state.run("project inherit");
  assert.equal(state.mode.backgroundOnly, false);
  assert.equal(state.confirmations.length, 2);
});

test("/ask-mode cancellation and invalid input leave the policy unchanged", async (_t) => {
  const state = await setup();
  state.choices.push(undefined);
  await state.run("");
  for (const input of [
    "global",
    "global inherit",
    "project surprise",
    "global normal extra",
  ]) {
    await state.run(input);
  }
  assert.equal(state.mode.backgroundOnly, false);
  assert.equal(state.notices.length, 4);
  assert.deepEqual(state.confirmations, []);
});

test("/ask-mode reports unsupported non-TUI use without changing the mode", async (_t) => {
  const state = await setup();
  state.ctx.mode = "print";
  await state.run("global background-only");
  assert.equal(state.mode.backgroundOnly, false);
  assert.equal(state.notices.length, 1);
  assert.deepEqual(state.confirmations, []);
});
