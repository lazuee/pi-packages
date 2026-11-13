/**
 * herdr-panes.ts — Give an opted-in subagent its own herdr pane.
 *
 * A child runs in-process, so a pane cannot be its process. What a pane can be is
 * a place to watch it: `openPane()` splits a sibling pane, and the caller tails the
 * child's transcript into it. The child keeps every in-process feature (steering,
 * ask-back, turn budgets) because nothing about how it executes changes.
 *
 * Active only when the parent itself runs inside a herdr pane (`HERDR_ENV=1` plus a
 * socket and pane id). Every failure is best-effort: a pane that cannot be opened
 * logs and the child runs on, because visibility is never worth failing a run for.
 */

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const HERDR_BIN = process.env.HERDR_BIN_PATH ?? "herdr";

/**
 * Prefix on the pane's first line. A pane is plain terminal output, so this is the
 * only durable way to tell a child pane from one the user opened — `pane rename`
 * loses to the shell's own title, and content survives a pi crash.
 */
const MARKER = "== subagent: ";

/** How long a child pane may go without a follow pass before it counts as orphaned. */
const ORPHAN_SECONDS = 30;

const STAMP_PREFIX = "pi-herdr-pane-";

/**
 * Stamp file holding the mtime of the last follow pass for a pane.
 *
 * Lives under the agent directory rather than the temp dir: that directory is not
 * swept, and a `/tmp` clean mid-run would make every live child pane look
 * orphaned at the next session start.
 */
export function stampPath(paneId: string): string {
  return path.join(
    getAgentDir(),
    `${STAMP_PREFIX}${paneId.replace(/[^\w]/g, "-")}.stamp`,
  );
}

/** Recover the pane id from a stamp name: `w1:p2` became `w1-p2`. */
export function paneFromStamp(file: string): string | undefined {
  const name = file.slice(STAMP_PREFIX.length, -".stamp".length);
  const at = name.indexOf("-p");
  if (at < 1) return undefined;
  return `${name.slice(0, at)}:${name.slice(at + 1)}`;
}

/** Remove the stamp. Best-effort — a leftover stamp only outlives one reap window. */
function dropStamp(paneId: string): void {
  try {
    fs.unlinkSync(stampPath(paneId));
  } catch {
    // Already gone.
  }
}

/** Create or age the stamp. Best-effort: a missing stamp is treated as unknown. */
function touchStamp(paneId: string): void {
  try {
    fs.closeSync(fs.openSync(stampPath(paneId), "a"));
  } catch {
    // Left to the age check; no stamp means "leave the pane alone".
  }
}

/** True when this process is itself running inside a herdr pane. */
export function herdrAvailable(): boolean {
  return (
    process.env.HERDR_ENV === "1" &&
    !!process.env.HERDR_SOCKET_PATH &&
    !!process.env.HERDR_PANE_ID
  );
}

/** The sliver of a herdr JSON reply this module reads. */
interface HerdrReply {
  result?: {
    pane?: { pane_id?: string };
    panes?: { pane_id?: string }[];
  };
}

/** Run a herdr subcommand and parse its JSON result. Rejects on non-zero exit. */
function herdr(args: string[]): Promise<HerdrReply> {
  return new Promise((resolve, reject) => {
    execFile(HERDR_BIN, args, { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr.trim() || err.message));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as HerdrReply);
      } catch {
        reject(new Error(`unparseable herdr output: ${stdout.slice(0, 200)}`));
      }
    });
  });
}

/** A pane watching one child, plus the follower writing into it. */
export interface ChildPane {
  paneId: string;
  /** The child's session directory — its transcript appears here once written. */
  follow(sessionDir: string): void;
  /**
   * Write a note and stop tailing. Leaves the pane open for reading.
   *
   * `stillRunning` keeps the follower alive: a background child's call returns
   * before the child does, so ending the follow there would freeze the pane
   * mid-run.
   */
  finish(note: string, stillRunning?: boolean): void;
}

/**
 * Open a sibling pane for a child and return a handle to write into it.
 *
 * Resolves to undefined when herdr is unavailable or the split fails, so callers
 * can carry on unobserved.
 */
export async function openPane(
  label: string,
  cwd: string,
): Promise<ChildPane | undefined> {
  if (!herdrAvailable()) return undefined;

  let paneId: string;
  try {
    const split = await herdr([
      "pane",
      "split",
      "--current",
      "--direction",
      "right",
      "--cwd",
      cwd,
      "--no-focus",
    ]);
    const created = split.result?.pane?.pane_id;
    if (!created) return undefined;
    paneId = created;
  } catch {
    return undefined;
  }

  let follower: fs.FSWatcher | undefined;
  let stopped = false;

  // Type into the pane rather than `pane run`, so the pane stays a plain terminal
  // and successive writes land in order.
  const write = (text: string) => {
    spawn(HERDR_BIN, ["pane", "run", paneId, text], { stdio: "ignore" }).on(
      "error",
      () => {},
    );
  };

  return {
    paneId,
    follow(sessionDir: string) {
      // The transcript file is created lazily, on the child's first assistant
      // message, so the first path that shows up is the one to tail.
      const watch = fs.watch(sessionDir, (_event, filename) => {
        if (stopped || follower || !filename?.endsWith(".jsonl")) return;
        watch.close();
        const file = path.join(sessionDir, filename);
        const stamp = stampPath(paneId);
        follower = fs.watch(file, () => {});
        // Follow in bounded passes rather than `tail -f`, which macOS cannot end
        // on a pid: each pass returns, so the loop exits once the file stops
        // growing. That self-cleans a tail whose pi died, instead of leaving one
        // running in a leaked pane forever.
        write(`clear; echo '${MARKER}${label} =='`);
        touchStamp(paneId);
        write(
          `m=1; q=1; while [ -f '${stamp}' ] && [ $q -lt 600 ]; do c=$(wc -l < '${file}'); if [ "$c" -gt "$((m-1))" ]; then q=1; else q=$((q+1)); fi; tail -n +$m '${file}' | sed '/^$/d'; m=$((c+1)); sleep 1; touch '${stamp}'; done &`,
        );
      });
      setTimeout(() => watch.close(), 60000).unref();
    },
    finish(note: string, stillRunning = false) {
      if (stopped) return;
      write(`echo; echo '${note.replace(/'/g, `'\\''`)}'`);
      if (stillRunning) return;
      stopped = true;
      follower?.close();
      // The loop exits on its own once the stamp is gone, so dropping it is the
      // signal; `kill %1` only makes that immediate. No stamp also means "leave
      // alone", which is exactly right for a pane left for reading.
      dropStamp(paneId);
      write("kill %1 2>/dev/null; true");
    },
  };
}

/**
 * Close child panes whose pi died, leaving a finished child behind.
 *
 * A run reclaims its own pane through `finish`; only a hard kill of pi skips
 * that. Such a pane still shows the marker but no longer has the follower loop
 * running (that loop self-terminates once its file stops growing), so a marker
 * without a heartbeat on screen is the signature of a leak.
 *
 * Best-effort throughout: a pane that cannot be read is left alone rather than
 * risk closing one the user is using.
 */
export async function reapOrphanedPanes(ownPaneId: string): Promise<string[]> {
  if (!herdrAvailable()) return [];

  let panes: string[];
  try {
    const list = await herdr([
      "pane",
      "list",
      "--workspace",
      process.env.HERDR_WORKSPACE_ID ?? "",
    ]);
    panes = (list.result?.panes ?? [])
      .map((p) => p.pane_id)
      .filter((id): id is string => !!id && id !== ownPaneId);
  } catch {
    return [];
  }

  // A stamp names its pane, so it is the only observation needed: a live pane is
  // touched every pass, and a finished one drops its stamp. Reading scrollback for
  // a marker is unreliable here — the raw transcript floods it out of any
  // window small enough to read cheaply.
  let stamps: string[];
  try {
    stamps = fs
      .readdirSync(getAgentDir())
      .filter((f) => f.startsWith(STAMP_PREFIX) && f.endsWith(".stamp"));
  } catch {
    return [];
  }

  const closed: string[] = [];
  for (const stamp of stamps) {
    const paneId = paneFromStamp(stamp);
    if (!paneId || paneId === ownPaneId || !panes.includes(paneId)) continue;

    let age: number;
    try {
      age =
        (Date.now() - fs.statSync(path.join(getAgentDir(), stamp)).mtimeMs) /
        1000;
    } catch {
      continue;
    }
    if (age < ORPHAN_SECONDS) continue;

    try {
      await herdr(["pane", "close", paneId]);
      dropStamp(paneId);
      closed.push(paneId);
    } catch {
      // Left open on failure; the next session tries again.
    }
  }
  return closed;
}
