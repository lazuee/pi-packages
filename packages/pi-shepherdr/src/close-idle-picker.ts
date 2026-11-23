import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  Key,
  matchesKey,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";

import type { MachineStatus } from "./types.js";

export interface IdlePick {
  label: string;
  machine: string;
  terminal: string;
  /** Its program already exited; the row is reaped, not quit. */
  dead?: true;
}

/**
 * Multi-select over idle child sessions. `dialog` is "list" while choosing and
 * "closing" once the selection is submitted, so the panel stays open for the
 * result instead of closing first.
 */
export class IdlePicker {
  private readonly entries: IdlePick[];
  private readonly theme: Theme;
  private readonly tui: TUI;
  private readonly selected = new Set<string>();
  private index = 0;
  private offset = 0;
  private readonly rows: number;
  private readonly close: (result: string[] | undefined) => void;
  private readonly describe: (machine: string) => string;
  dialog: "closing" | "list" = "list";
  message = "";

  constructor(
    entries: IdlePick[],
    theme: Theme,
    tui: TUI,
    close: (result: string[] | undefined) => void,
    describe: (machine: string) => string
  ) {
    this.entries = entries;
    this.theme = theme;
    this.tui = tui;
    this.close = close;
    this.describe = describe;
    this.rows = Math.max(1, Math.min(10, entries.length));
    for (const entry of entries) this.selected.add(entry.terminal);
  }

  private window() {
    if (this.index < this.offset) this.offset = this.index;
    if (this.index >= this.offset + this.rows)
      this.offset = this.index - this.rows + 1;
    return this.entries.slice(this.offset, this.offset + this.rows);
  }

  render(width: number) {
    const mark = (terminal: string) =>
      this.selected.has(terminal) ? this.theme.fg("success", "[x]") : "[ ]";
    const lines = [
      this.theme.fg("accent", "─".repeat(Math.max(0, width))),
      truncateToWidth(
        `  ${this.theme.bold("Quit idle subagents")} ${this.theme.fg("dim", `${this.selected.size}/${this.entries.length} selected`)}`,
        width,
        ""
      ),
      "",
      ...this.window().map((entry, position) => {
        const row = this.offset + position;
        const line = `  ${mark(entry.terminal)} ${entry.label} ${this.theme.fg("dim", `· ${this.describe(entry.machine)}${entry.dead ? " · exited" : ""}`)}`;
        return truncateToWidth(
          row === this.index
            ? this.theme.bg("selectedBg", line.padEnd(width))
            : line,
          width,
          ""
        );
      }),
      "",
    ];
    if (this.dialog === "closing") {
      lines.push(
        truncateToWidth(
          `  ${this.theme.fg("dim", this.message || "Closing…")}`,
          width,
          ""
        )
      );
      return [...lines, this.theme.fg("accent", "─".repeat(width))];
    }
    lines.push(
      truncateToWidth(
        `  ${this.theme.fg("dim", "↑/↓ move · Space toggle · a all · Enter quit checked · Esc cancel")}`,
        width,
        ""
      )
    );
    return [...lines, this.theme.fg("accent", "─".repeat(width))];
  }

  invalidate() {
    // Rendered from state each frame.
  }

  handleInput(data: string) {
    if (this.dialog === "closing") return;
    const kb = getKeybindings();
    if (matchesKey(data, Key.escape)) {
      this.close(undefined);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.dialog = "closing";
      this.tui.requestRender();
      this.close([...this.selected]);
      return;
    }
    if (kb.matches(data, "tui.select.up") || matchesKey(data, Key.up)) {
      this.index = Math.max(0, this.index - 1);
    } else if (
      kb.matches(data, "tui.select.down") ||
      matchesKey(data, Key.down)
    ) {
      this.index = Math.min(this.entries.length - 1, this.index + 1);
    } else if (data === " " || matchesKey(data, Key.space)) {
      const entry = this.entries[this.index];
      if (!entry) return;
      if (this.selected.has(entry.terminal))
        this.selected.delete(entry.terminal);
      else this.selected.add(entry.terminal);
    } else if (data === "a") {
      if (this.selected.size === this.entries.length) this.selected.clear();
      else for (const entry of this.entries) this.selected.add(entry.terminal);
    } else {
      return;
    }
    this.tui.requestRender();
  }
}

export function machineLabel(machines: MachineStatus[], id: string): string {
  const match = machines.find((machine) => machine.id === id);
  return match?.label ?? (match?.local ? "local" : id);
}
