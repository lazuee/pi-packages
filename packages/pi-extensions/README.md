# @lazuee/pi-extensions

The general-purpose extension bundle from this repository.

## Install

```bash
pi install npm:@lazuee/pi-extensions
```

## Included extensions

- `pi-agent-comms` — Notes checkpoints and searchable session history, plus shared agent boards
- `pi-ask` — interactive decisions, review triage, human handoffs, and optional `/fold` and `/grill` prompts
- `pi-better-skills-tool` — progressive skill discovery in normal Pi, Code Mode, and Notebook Mode
- `pi-cache-hit-predictor` — inline prompt-cache hit predictions when switching models or reasoning levels
- `pi-github-watch` — opt-in notifications for GitHub issue and pull request comments
- `pi-shepherdr` — Herdr-native multi-agent orchestration; uses `pi-agent-comms` for shared context and boards
- `pi-suggestions` — editable next-prompt suggestions
- `pi-unicode-charts` — terminal-native Unicode charts for Pi Markdown

Installing this bundle loads every extension above. Install individual packages instead if you only want part of the set.

`pi-agent-comms` replaces the standalone Notes Compaction and Agent Board packages; do not load those alongside this bundle. It also covers Notes-based context compaction in place of the retired `pi-auto-trees`, while separate Pi sessions replace `pi-smart-btw` side questions and Shepherdr's reviewer profile replaces `pi-subagent-review`.
