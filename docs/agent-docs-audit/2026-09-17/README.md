# Agent-doc audit snapshot — 2026-09-17

Measurements taken while filing [#934](https://github.com/lazuee/pi-packages/issues/934).
Each audit commits its own dated directory; the CSVs here are the record, not a cache to refresh in place.

## Files

| File                      | What it is                                                                     |
| ------------------------- | ------------------------------------------------------------------------------ |
| `doc-growth.csv`          | Weekly word counts of agent-facing docs per snapshot of `HEAD`, split by class |
| `model-usage.csv`         | Assistant-message aggregates by week × model × thinking level × workflow stage |
| `growth-vs-model-mix.png` | The two series plotted together                                                |
| `plot.py`                 | Regenerates the figure from the two CSVs                                       |

## Regenerating

```bash
node scripts/agent-docs/doc-growth.mjs > docs/agent-docs-audit/<date>/doc-growth.csv
node scripts/agent-docs/model-usage.mjs > docs/agent-docs-audit/<date>/model-usage.csv
node scripts/agent-docs/always-loaded.mjs
cd docs/agent-docs-audit/<date> && uv run plot.py
```

`doc-growth.mjs` reads git history, so it reproduces exactly at any later date.
`plot.py` needs [`uv`](https://docs.astral.sh/uv/) because matplotlib is not a repo dependency.

## Why `model-usage.csv` is committed rather than re-derived

`model-usage.mjs` reads Pi's local session transcripts under `~/.pi/agent/sessions/`.
That store is machine-local, unversioned, prunable, and begins only when Pi first ran in this checkout — 2026-05-15, three weeks after the repo opened.
A pruned week is gone, and a different machine sees a different history.
Committing the aggregate is what makes the series durable.

Only counts are recorded — week, model, thinking level, stage, session count, message count, tokens, cost.
No message content, no file contents, no session IDs.

## Reading the numbers

Word counts are matched repo-wide, so the pre-consolidation layout (a per-package `AGENTS.md` and `.pi/` directory, before mid-May 2026) is included.
Snapshots landing mid-migration read low for a week.

The `agents_md` column also counts the nine `packages/*/AGENTS.md` files that survive today as ~45-word sentinels, which fire only when Pi is launched from a package subdirectory.
That is right for the history and about 400 words high as an always-loaded figure, which is why `always-loaded.mjs` reads the root file alone.
On the 2026-09-17 tree it reports `agentsMd=8760 descriptions=454 total=9214`.

Stage attribution walks entries in order, assigning each message to the session name in effect at that moment.
Taking the last name in a transcript instead credits a renamed or resumed session's whole history to whatever stage it ended as, which inflates `Retrospective` roughly fivefold.

`(unnamed)` covers sessions predating the `set_session_name` convention, plus any session started outside a workflow template.
