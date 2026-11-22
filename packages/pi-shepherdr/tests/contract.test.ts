import { describe, expect, test } from "bun:test";

import {
  isBlockingAgentsCall,
  parseAgentsRequest,
  shouldBlockAgentSpawn,
} from "../src/agents-contract.js";

describe("request parsing", () => {
  test("an absent request is help", () => {
    expect(parseAgentsRequest(undefined)).toEqual({ action: "help" });
  });

  test("an empty object and a bare help string are help", () => {
    expect(parseAgentsRequest({})).toEqual({ action: "help" });
    expect(parseAgentsRequest("  help ")).toEqual({ action: "help" });
  });

  test("a JSON object string parses", () => {
    expect(parseAgentsRequest('{"action":"find","query":"x"}')).toEqual({
      action: "find",
      query: "x",
    });
  });

  test("an empty string and broken JSON are refused", () => {
    expect(() => parseAgentsRequest("   ")).toThrow("must be");
    expect(() => parseAgentsRequest("{")).toThrow("valid JSON");
  });

  test("an array, a number and an unknown action are refused", () => {
    for (const value of [[], 3, { action: "nope" }] as const)
      expect(() => parseAgentsRequest(value)).toThrow();
  });

  test("commands alone implies help", () => {
    expect(parseAgentsRequest({ commands: true })).toEqual({
      action: "help",
      commands: true,
    });
  });

  test("commands outside help, and help with a bare target, are refused", () => {
    expect(() =>
      parseAgentsRequest({ action: "list", commands: true })
    ).toThrow("requires action=help");
    expect(() => parseAgentsRequest({ action: "help", target: "p" })).toThrow(
      "commands:true"
    );
    expect(() => parseAgentsRequest({ action: "help", machine: "m" })).toThrow(
      "target and machine require commands:true"
    );
  });
});

describe("action fields", () => {
  test("send rejects blocking", () => {
    expect(() =>
      parseAgentsRequest({
        action: "send",
        target: "p",
        message: "m",
        blocking: true,
      })
    ).toThrow("message-only");
  });

  test("an unknown field is named", () => {
    expect(() =>
      parseAgentsRequest({ action: "find", query: "x", lines: 2 })
    ).toThrow("unknown find field(s): lines");
  });

  test("attach and detach need at least one choice and default both", () => {
    expect(() => parseAgentsRequest({ action: "attach", target: "p" })).toThrow(
      "context:true or board:true"
    );
    expect(
      parseAgentsRequest({ action: "detach", target: "p", board: true })
    ).toEqual({ action: "detach", target: "p", board: true, context: false });
    expect(() =>
      parseAgentsRequest({ action: "detach", target: "p", context: "yes" })
    ).toThrow("context must be a boolean");
  });

  test("reply needs extension, id and a message", () => {
    expect(() =>
      parseAgentsRequest({
        action: "reply",
        target: "p",
        id: "i",
        message: "m",
      })
    ).toThrow("extension is required for reply");
    expect(() =>
      parseAgentsRequest({
        action: "reply",
        target: "p",
        extension: "e",
        id: "i",
        message: "m",
      })
    ).not.toThrow();
  });

  test("a read source outside the list is refused", () => {
    expect(() =>
      parseAgentsRequest({ action: "read", target: "p", source: "all" })
    ).toThrow("read source must be one of");
  });

  test("spawn reports every missing launch field, not the first", () => {
    expect(() => parseAgentsRequest({ action: "spawn" })).toThrow(
      "agent_type is required for spawn"
    );
  });

  test("a blank board thread id is refused before launch", () => {
    expect(() =>
      parseAgentsRequest({
        action: "spawn",
        agent_type: "a",
        label: "l",
        message: "m",
        board_thread_id: " ",
      })
    ).toThrow("non-empty");
  });
});

describe("blocking classification", () => {
  test("only a blocking assign waits", () => {
    expect(
      isBlockingAgentsCall({
        action: "assign",
        target: "p",
        message: "m",
        blocking: true,
      })
    ).toBe(true);
    expect(
      isBlockingAgentsCall({ action: "assign", target: "p", message: "m" })
    ).toBe(false);
    expect(
      isBlockingAgentsCall({ action: "send", target: "p", message: "m" })
    ).toBe(false);
  });

  test("an unparseable request is not a wait", () => {
    expect(isBlockingAgentsCall({ action: "nope" })).toBe(false);
  });

  test("profile policy overrides the call, and the call covers a missing policy", () => {
    expect(shouldBlockAgentSpawn(true, false)).toBe(true);
    expect(shouldBlockAgentSpawn(false, true)).toBe(false);
    expect(shouldBlockAgentSpawn(undefined, true)).toBe(true);
    expect(shouldBlockAgentSpawn(undefined, undefined)).toBe(false);
  });
});
