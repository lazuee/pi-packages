/**
 * Remove the scratch dirs a test file leaves behind.
 *
 * Files run in parallel against one shared tmpdir, so a file must not sweep
 * everything with its prefix: dirs already present when it loaded belong to a
 * sibling and are skipped. What this file creates is collected by a scan after
 * each test (by then the test has made them) and swept once at the end.
 *
 * The scan runs here rather than in the test, so a file needs no bookkeeping of
 * its own, and anything a straggling write re-creates after a test is caught by
 * the next scan. This suite is short enough that a dir is never still being
 * written at the end, so the sweep needs no recency margin.
 */
import { readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach } from "vitest";

const PREFIX = "pi-autoformat-";

/** Dirs present before this file ran: another file's, never touched. */
const preexisting = new Set(list());
/** Dirs this file created, collected as it goes. */
const mine = new Set<string>();

function list(): string[] {
  try {
    return readdirSync(tmpdir())
      .filter((name) => name.startsWith(PREFIX))
      .map((name) => join(tmpdir(), name));
  } catch {
    return [];
  }
}

afterEach(() => {
  for (const path of list()) {
    if (!preexisting.has(path)) mine.add(path);
  }
});

afterAll(() => {
  for (const path of mine) {
    rmSync(path, { recursive: true, force: true });
  }
  mine.clear();
});
