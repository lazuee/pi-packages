/**
 * Paths neither oxlint nor oxfmt touches, on top of whatever the shared config
 * already. Both tools read this one list, so a new exclusion is added once and
 * cannot drift between lint and format.
 */
export const ignores = [
  // The vendored agent-desktop checkout: a submodule with its own tooling and a
  // different house style, so the root config only ever reported churn in it.
  "**/upstream",
];
