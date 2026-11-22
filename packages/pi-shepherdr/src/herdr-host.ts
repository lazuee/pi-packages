/**
 * Whether this Pi runs inside the Herdr app, which sets its bundle id for every
 * process it hosts.
 *
 * It gates whether the package works at all: a session started outside the app
 * has no sidebar to show a space in and stays inactive. A detached or windowless
 * session still reads as inside, so the bundle id is a proxy, not proof.
 *
 * macOS bundle ids only, so a Linux controller always reads as outside the app.
 */
export const HERDR_REQUIRED =
  "Shepherdr only runs inside the Herdr app; the legacy Herdr TUI is unsupported. Start Pi from an app terminal. Delegation, spaces and focus stay off here; only /herdr settings and help work.";

export function insideHerdr(): boolean {
  return process.env["__CFBundleIdentifier"] === "dev.herdr.app";
}
