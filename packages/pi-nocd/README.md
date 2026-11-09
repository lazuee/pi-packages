# @lazuee/pi-nocd

[![npm version](https://img.shields.io/npm/v/@lazuee/pi-nocd?style=flat&logo=npm&logoColor=white)](https://www.npmjs.com/package/@lazuee/pi-nocd) [![CI](https://img.shields.io/github/actions/workflow/status/lazuee/pi-packages/ci.yml?style=flat&logo=github&label=CI)](https://github.com/lazuee/pi-packages/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat)](https://opensource.org/licenses/MIT) [![TypeScript](https://img.shields.io/badge/TypeScript-6.x-3178C6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![pnpm](https://img.shields.io/badge/pnpm-%3E%3D11-F69220?style=flat&logo=pnpm&logoColor=white)](https://pnpm.io/) [![Pi Package](https://img.shields.io/badge/Pi-Package-6366F1?style=flat)](https://pi.mariozechner.at/)

Pi extension that adds an instruction to the system prompt forbidding the agent from `cd`-prefixing the current working directory.

Requires Pi 1.0.0 or later.

## Why

Pi already tells the agent the resolved CWD: its system prompt carries a `<cwd>` section naming the path, and that section survives downstream shaping (for example [pi-anthropic-auth](https://github.com/lazuee/pi-anthropic-auth), which only rewrites Pi's own `tools`, `rules`, and `docs` sections).

What Pi ships **nowhere** — default or shaped — is any _instruction_ against `cd`-prefixing the CWD.
The `<cwd>` section is a bare statement of fact, not a rule, so the habit of prefixing commands with `cd $(pwd) &&` survives.

This extension hooks `before_agent_start` and adds a prompt section that supplies the missing prohibition — forbidding both the literal `cd <path> &&` form and the generic `cd $(pwd) &&` form.
It repeats the literal resolved path (from `ctx.cwd`) only to make the forbidden `cd <path> &&` example concrete, not because the path is otherwise unavailable to the agent.

Because the section names a literal path, each session writes its own.
A subagent session runs its own copy of this extension, which writes a section naming the child's directory, so a child given an isolated workspace (for example a git worktree from [@lazuee/pi-subagents-worktrees](https://www.npmjs.com/package/@lazuee/pi-subagents-worktrees)) is told where its own shell commands execute.
[@lazuee/pi-subagents](https://www.npmjs.com/package/@lazuee/pi-subagents) drops everything from the parent's `<cwd>` section onward when it builds a child's prompt, so the parent's section is not carried along.

## Install

```bash
pi install npm:@lazuee/pi-nocd
```

Or add it to your Pi settings (`~/.pi/agent/settings.json`):

```json
{
  "packages": ["npm:@lazuee/pi-nocd"]
}
```

## What it injects

For a session whose working directory resolves to `/Users/you/project`, Pi renders the following section right after its own `<cwd>` section (the instruction is one line in the prompt, split here at its sentences):

```text
<working_directory>
Shell commands already execute in `/Users/you/project`.
Never prefix a command with `cd` into the current working directory — neither `cd /Users/you/project &&` nor `cd $(pwd) &&`.
Just run the command directly.
</working_directory>
```

The extension writes the section through `systemPromptOptions.sections` and never returns a replacement system prompt.
A returned prompt would become Pi's forced prompt, which drops every section a later handler adds, such as the `<mcp_servers>` section Pi's built-in MCP support writes.

The converse also holds: when another extension returns a `systemPrompt` from `before_agent_start` _before_ this one runs, Pi ignores every later section edit, and this section is dropped with them.

## How it works

| Hook                 | Behavior                                                                 |
| -------------------- | ------------------------------------------------------------------------ |
| `before_agent_start` | Writes the `working_directory` prompt section for the resolved `ctx.cwd` |

## Scope and non-goals

**Purpose.**
Pi tells the agent its working directory but never forbids `cd`-prefixing it.
This extension supplies the missing prohibition — and nothing else.

**In scope.**
The wording of the section, and naming the right directory when a child session runs in an isolated workspace.

**Non-goals.**

- _Enforcing the rule._
  This extension instructs; it does not gate a command at execution time.
- _Editing prompt text it did not write._
  The extension reads no prompt text, so another source's working-directory guidance is neither rewritten nor deduplicated.
- _Telling the agent what its working directory is._
  Pi's own `<cwd>` section already does that; the literal path appears here only to make the forbidden example concrete.
- _Registering tools or commands._
  The entire surface is one `before_agent_start` hook, with no configuration.

## License

MIT
