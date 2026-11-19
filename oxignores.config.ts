/**
 * Paths neither oxlint nor oxfmt touches, on top of whatever the shared config
 * already. Both tools read this one list, so a new exclusion is added once and
 * cannot drift between lint and format.
 */
export const ignores = [
  // The vendored agent-desktop checkout: a submodule with its own tooling and a
  // different house style, so the root config only ever reported churn in it.
  "**/upstream",
  // Its committed release copy, vendored the same way: the launcher, lib and
  // binaries in pi-agent-desktop/prebuilt are upstream files too. A directory
  // cannot be re-included, so the patterns go a level deeper and name the two
  // files worth checking; the binaries stay excluded.
  "**/prebuilt/**",
  "!**/pi-agent-desktop/prebuilt/lib/*.js",
  "!**/pi-agent-desktop/prebuilt/bin/agent-desktop",
];
