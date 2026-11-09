---
status: accepted
date: 2026-06-24
---

# 0001 — Replace commitlint with committed for commit-message linting

## Status

Accepted.
Implemented in this issue ([#468]): the `commit-msg` gate swaps from `commitlint` to [`committed`](https://github.com/crate-ci/committed).

## Context

The `commit-msg` gate ran `commitlint`, which delegates parsing to `conventional-commits-parser`.
That parser misreads any commit-body line containing a `#N` reference as the start of the footer, so `footer-leading-blank` rejected valid messages whenever a body cited an issue mid-sentence — which this repo does routinely.
The stopgap disabled only that one rule (`footer-leading-blank: [0]`), but it left the gate on a parser the operator does not trust.

The gate's load-bearing requirement ([#452], [#457]) is to reject the malformed `type!(scope):` form — the `!`-before-scope placement that `release-please` silently drops, skipping the major bump — while accepting the correct `type(scope)!:` and bare `type!:` forms.

Three single-binary, real-grammar conventional-commit checkers were evaluated against an empirical acceptance bar: `convco`, `cocogitto` (`cog`), and `committed` (all installed via `brew`).

### Acceptance bar

Four fixtures, each run as a single pending message through every candidate:

| Fixture       | First line                                                         | Required |
| ------------- | ------------------------------------------------------------------ | -------- |
| case1         | `refactor(pi-subagents): …` with a body citing `#441` mid-sentence | pass     |
| case2-before  | `feat!(pi-subagents): add a thing`                                 | fail     |
| case3-after   | `feat(pi-subagents)!: add a thing`                                 | pass     |
| case4-noscope | `feat!: add a thing`                                               | pass     |

### Results

All three candidates produce the required exit code on every fixture (exit 0 = pass, non-zero = fail):

| Tool                                      | case1 | case2-before | case3-after | case4-noscope | All pass? |
| ----------------------------------------- | ----- | ------------ | ----------- | ------------- | --------- |
| `convco check --from-stdin`               | 0     | 1            | 0           | 0             | yes       |
| `cog verify --file -`                     | 0     | 1            | 0           | 0             | yes       |
| `committed --commit-file -` (with config) | 0     | 1            | 0           | 0             | yes       |

`committed` only enforces conventional format when its config sets `style = "conventional"`; its defaults (`style = "none"`, `subject_capitalized = true`, `subject_length = 50`) otherwise reject the repo's lowercase conventional subjects.

### Recording criteria

| Criterion                              | `convco`                                                         | `cog` (cocogitto)                                      | `committed`                                                                                   |
| -------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Single-message `commit-msg` op         | `--from-stdin` (stdin only; needs `pass_filenames=false`)        | `verify --file <path>` (clean file arg)                | `--commit-file <path>` (clean file arg)                                                       |
| First-party pre-commit/prek repo       | none (404)                                                       | none (404)                                             | yes — `crate-ci/committed`, `stages: [commit-msg]`                                            |
| Config: types / scopes / header length | `.versionrc`; grammar-only, no allowed-types or length rule      | `cog.toml`; commit types, no header-length rule        | `committed.toml`; `allowed_types`, `allowed_scopes`, `subject_length`, `line_length`, `style` |
| Error clarity                          | `first line doesn't match <type>[optional scope]: <description>` | `Missing commit type separator ':'` + line:col pointer | `Commit is not in Conventional format: Missing type …, expected 'type: description'`          |
| Maintenance (as of eval)               | 0.6.4                                                            | 7.0.0                                                  | v1.1.11 (2026-02-25)                                                                          |

All three error messages are a clear improvement over `commitlint`'s misleading blank-line output.

## Decision

Adopt **`committed`** as the `commit-msg` gate.

Because all three candidates clear the acceptance bar, the choice is decided on the recording criteria, where `committed` wins on the two that matter most for this repo:

- **Provisioning** — `committed` is the only candidate that ships a first-party pre-commit/prek repo with a `commit-msg` hook (`crate-ci/committed`).
  It uses the same `language: python` prebuilt-wheel mechanism as the repo's existing `rumdl` remote hook (`rvben/rumdl-pre-commit`), so it self-provisions through `prek install` with no PATH dependency and works in fresh worktrees.
  `convco` and `cocogitto` ship no pre-commit repo, so each would need `brew`/`mise` PATH provisioning plus a `local` `system` hook — more friction and a new managed-tool requirement.
- **Config expressiveness** — `committed.toml` is purpose-built for linting (`allowed_types`, `allowed_scopes`, `subject_length`, `line_length`, `style`), where `convco`'s `.versionrc` validates grammar only and `cog` is a broader toolbox with no header-length rule.

The gate is wired as a `prek` remote-repo hook pinned to `crate-ci/committed` `v1.1.11`, with a repo-root `committed.toml`:

```toml
style = "conventional"
subject_capitalized = false
imperative_subject = false
subject_length = 120
line_length = 0
allowed_types = ["feat", "fix", "perf", "revert", "docs", "style", "chore", "refactor", "test", "build", "ci"]
```

`allowed_types` matches `release-please`'s recognized type set, so the gate is never stricter than the release tooling.
`subject_length = 120` matches the prior `commitlint` `header-max-length`; `line_length = 0` disables body-line-length checks (the repo wraps bodies freely); `subject_capitalized`/`imperative_subject` are disabled because conventional subjects are lowercase after the type.
The config validated cleanly against the last 80 commits of real history.

`.commitlintrc.json` and the `@commitlint/cli` / `@commitlint/config-conventional` devDependencies are removed.

## Consequences

- The `#N`-in-body false positive that motivated this issue is gone — `committed` parses the conventional grammar correctly, so the `footer-leading-blank` workaround is no longer needed.
- The load-bearing `!`-placement rejection ([#452], [#457]) is preserved and pinned by the case2-before fixture.
- `committed` enforces `allowed_types`, so a typo'd commit type (e.g. `feet:`) is now rejected — slightly stricter than the prior config, but aligned with `release-please`.
- Scope stays free-form (`allowed_scopes = []`), matching the [#457] decision.
- The gate gains a config file (`committed.toml`) at the repo root, where `commitlint` needed `.commitlintrc.json`; net file count is unchanged.
- If `committed`'s prek hook ever fails to provision (e.g. no prebuilt wheel for a platform), the fallback is a `local` `system` hook invoking a `brew`/`mise`-provisioned `committed` binary, or — last resort — reverting to `commitlint` with `footer-leading-blank` disabled.

## Reproduction

```bash
brew install convco cocogitto committed

# Fixtures
printf 'refactor(pi-subagents): extract MenuUI\n\nDeleted in #441 keep compiling.\n' > case1.txt
printf 'feat!(pi-subagents): add a thing\n' > case2-before.txt
printf 'feat(pi-subagents)!: add a thing\n' > case3-after.txt
printf 'feat!: add a thing\n' > case4-noscope.txt

# committed config (style=conventional)
cat > committed.toml <<'TOML'
style = "conventional"
subject_capitalized = false
imperative_subject = false
subject_length = 120
line_length = 0
allowed_types = ["feat", "fix", "perf", "revert", "docs", "style", "chore", "refactor", "test", "build", "ci"]
TOML

for f in case1 case2-before case3-after case4-noscope; do
  convco check --from-stdin < "$f.txt";        echo "convco    $f -> $?"
  cog verify --file - < "$f.txt";              echo "cog       $f -> $?"
  committed --config committed.toml --commit-file - < "$f.txt"; echo "committed $f -> $?"
done
```

[#452]: https://github.com/lazuee/pi-packages/issues/452
[#457]: https://github.com/lazuee/pi-packages/issues/457
[#468]: https://github.com/lazuee/pi-packages/issues/468
