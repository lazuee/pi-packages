/**
 * Local entry point for the `pi-coding-agent-test` harness.
 *
 * The integration tests were ported from a repository where the harness sat at
 * the repo root, so `from "pi-coding-agent-test"` resolved there. Here the
 * harness is a package dev dependency, and `#test/fixtures/…` is the alias this
 * package's tsconfig and vitest config both resolve, which keeps the ported
 * imports working from the package's own root.
 */
export * from "pi-coding-agent-test";
