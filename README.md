# pi-packages

Personal pi extensions, one package per directory under `packages/`.

## Toolchain

Tool versions are pinned in `mise.toml`; mise also exposes the task runner.

```bash
mise install          # provision bun + node
mise run install      # bun install
mise run check        # check package parity + type-check all packages
mise run fmt          # prettier
```

## Adding a package

```bash
cp -r packages/example-extension packages/my-extension
```

Then edit `packages/my-extension/package.json`: change `name`, `description`, and
`pi.extensions`. Keep an `exports` entry pointing at the entry module.

Also add the package to `packages/pi-extensions/index.ts` (import it and `await` its
factory in the bundle) plus root `dependencies`/`devDependencies`, then reload pi with
`/reload` — `bun run parity` fails while any of those is missing. Skills-only packages
with no `index.ts` are imported by nobody; exempt them in the script if intentional.

## Installing into pi

```bash
# local, hot-reloadable via /reload
pi install ./packages/my-extension

# from git, tracking main
pi install git:github.com/lazuee/pi-packages
```

The aggregate is installed from git only. There are no release tags and nothing is
published to npm: `main` is the released state, so an install picks up whatever is
there. The import resolves every package in the repo, so one install brings the whole
set — keep `main` coherent rather than tagging. Individual packages are still
`npm publish`-ready if one is ever distributed alone.

`pi-agent-comms` replaces the standalone `@howaboua/pi-notes-compaction` and
`@howaboua/pi-agent-board` packages. Prefer it for shared notes and boards, and never
load it beside either standalone package.

## Conventions

- Host-provided modules (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`,
  `@earendil-works/pi-agent-core`, `@earendil-works/pi-tui`, `typebox`) go in
  `peerDependencies` with a floor range (`>=1.5.0`) and an `^1.5.2` devDependency for
  local types. Never put them in `dependencies` — a duplicate copy splits pi's registries.
- Runtime dependencies belong in `dependencies`; they ship with the package.
- Optional integrations another package links against go in `peerDependencies` with
  `peerDependenciesMeta.<name>.optional: true`.
- Workspace siblings are `workspace:*` devDependencies. `@lazuee/pi-extensions` pins
  its siblings in `dependencies`; its `prepack` hook rewrites those to exact versions.
- Entry module is `index.ts` at the package root (chart-free packages may use
  `src/index.ts`), exporting a default factory that receives `ExtensionAPI`.
- Import TypeBox as `typebox`; import tools helpers from `@earendil-works/pi-coding-agent`.
- Every package ships `LICENSE` and `CHANGELOG.md`.
