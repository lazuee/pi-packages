/**
 * Whether this Pi runs inside the Herdr app, which sets its bundle id for every
 * process it hosts.
 *
 * This stands in for two separate questions: has this session a sidebar to show
 * a space in (so it needs no peers widget), and may its workers take a space.
 * Started from another terminal there is no sidebar, so workers stay bare and
 * the widget lists them. A detached or windowless session still reads as inside,
 * so the bundle id is a proxy, not proof of a window.
 *
 * macOS bundle ids only, so a Linux controller always reads as outside the app.
 */
export const HERDR_REQUIRED =
  "Shepherdr only runs inside the Herdr app; the legacy Herdr TUI is unsupported. Start Pi from an app terminal. Delegation, spaces and focus stay off here; only /herdr settings and help work.";

export function insideHerdr(): boolean {
  return process.env["__CFBundleIdentifier"] === "dev.herdr.app";
}
