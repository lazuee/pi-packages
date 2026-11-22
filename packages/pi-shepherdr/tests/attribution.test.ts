import { describe, expect, test } from "bun:test";

import {
  agentSource,
  sourceAttributes,
  xml,
} from "../src/messages/attribution.js";

describe("xml escaping", () => {
  test("the five entities escape", () => {
    expect(xml(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&apos;");
  });

  test("plain text is unchanged", () => {
    expect(xml("a b")).toBe("a b");
  });
});

describe("source attributes", () => {
  test("empty values are dropped, not emitted bare", () => {
    expect(sourceAttributes({ a: "1", b: undefined, c: "" })).toBe(
      'a="1" c=""'
    );
  });

  test("quotes and newlines in a value are escaped", () => {
    expect(sourceAttributes({ name: 'a"b\nc' })).toBe('name="a&quot;b&#10;c"');
  });

  test("agent identity carries the terminal and optional labels only", () => {
    expect(
      agentSource(
        {
          pane_id: "p",
          terminal_id: "t",
          workspace_id: "w",
          name: "n",
        } as never,
        { tab: "tb", workspace: "ws" }
      )
    ).toEqual({
      terminal: "t",
      workspace: "w",
      name: "n",
      tab_name: "tb",
      workspace_name: "ws",
    });
  });

  test("a labelled pane falls back to its title", () => {
    expect(
      agentSource({ pane_id: "p", terminal_id: "t", title: "ti" } as never, {})
    ).toEqual({ terminal: "t", pane_name: "ti" });
  });
});
