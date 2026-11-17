// Invariant: the aggregate bundle, the root manifest and `packages/*` stay in sync.
//
// `packages/pi-extensions/index.ts` is the only entry point pi loads from this repo.
// A package directory that is not imported by it is dead weight that still ships and
// installs; an import without a manifest entry (or a manifest entry without an import)
// breaks install resolution for everyone. On top of that, some siblings depend on
// registration order: the bundle awaits the default factory of every extension, so
// `pi-agent-comms` must strictly precede `pi-shepherdr` (comms registers first, the
// shepherdr factory calls into it).
//
// Skipped on purpose: `pi-skill-agent-harness` is skills-only (no `index.ts`), wired
// through root `pi.skills` instead of the bundle.
//
// Scanning: `stripLiterals` returns a copy of the bundle with comments and string or
// template literals blanked out, but offsets are preserved. Matches are found on that
// copy and their text is sliced out of the untouched source, so commented-out imports
// and awaits never count, while specifiers keep their real characters.
//
// Violations are printed one per line with a fix hint; any violation exits 1.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const SCOPE = "@lazuee/";
const BUNDLE = join("packages", "pi-extensions", "index.ts");
const ORDER = ["pi-agent-comms", "pi-shepherdr"];
// Packages that exist outside packages/ by design: tooling-only, or not bundled.
const EXEMPT = new Set(["pi-skill-agent-harness", "config"]);
// Host-provided modules a bundle may import without owning a package.
const HOST = /^(@earendil-works\/|typebox$|node:)/u;
// Identifiers that are syntax, not bindings.
const KEYWORDS = new Set(["default", "as", "from", "import", "type"]);

const root = resolve(import.meta.dirname, "..");
const violations = [];
const fail = (message, hint) => violations.push(`${message}\n    fix: ${hint}`);

function fatal(step, path, error) {
  console.error(
    `✗ package parity: could not ${step} ${path}: ${error.message}`
  );
  process.exit(1);
}

/** `@lazuee/<dir>` for every package dir, minus the bundle itself and the exempt ones. */
function siblingNames() {
  let entries;
  try {
    entries = readdirSync(join(root, "packages"), { withFileTypes: true });
  } catch (error) {
    fatal("read directory", "packages/", error);
  }
  entries = entries.filter((entry) => entry.isDirectory());
  return entries
    .map((entry) => entry.name)
    .filter((name) => name !== "pi-extensions" && !EXEMPT.has(name))
    .map((name) => `${SCOPE}${name}`)
    .toSorted();
}

/** Blank out comments and string/template literals, keeping every offset in place. */
function stripLiterals(source) {
  const blank = (text) => text.replaceAll(/[^\n]/gu, " ");
  let out = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && (next === "/" || next === "*")) {
      const close =
        next === "/"
          ? source.indexOf("\n", index)
          : source.indexOf("*/", index + 2);
      const stop =
        close === -1 ? source.length : next === "/" ? close : close + 2;
      out += blank(source.slice(index, stop));
      index = stop;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      let stop = index + 1;
      while (stop < source.length && source[stop] !== char) {
        if (source[stop] === "\\") stop += 1;
        stop += 1;
      }
      stop = Math.min(stop + 1, source.length);
      out += blank(source.slice(index, stop));
      index = stop;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/**
 * Binding for the default (or `default as X`) import of one clause, or null.
 * Handles `import X from`, `import { default as X }`, `import { a as X, default as Y }`.
 * The clause holds no literal text, so it is taken from the stripped view.
 */
function defaultBinding(clause) {
  const named = clause.match(/\bdefault\s+as\s+([A-Za-z_$][\w$]*)/u);
  if (named) return named[1];
  const plain = clause
    .replaceAll(/\{[^}]*\}/gu, " ")
    .match(/^\s*([A-Za-z_$][\w$]*)/u);
  if (plain && !KEYWORDS.has(plain[1]) && !plain[1].startsWith("*"))
    return plain[1];
  const rebound = clause.match(/\bas\s+([A-Za-z_$][\w$]*)/u);
  return rebound && rebound[1] !== "default" && !KEYWORDS.has(rebound[1])
    ? rebound[1]
    : null;
}

/**
 * Every live `import ... from "<specifier>"`. The clause is matched on `stripped`
 * (no literal text in it), the specifier is sliced out of `raw` at the same offsets:
 * `from` and the opening quote are located in the raw line, and the closing quote
 * bounds the specifier.
 */
function bundleImports(raw, stripped) {
  const found = [];
  const pattern = /^[ \t]*import\s+([^;]*?)\s+from/gmu;
  for (const match of stripped.matchAll(pattern)) {
    const [clause] = match;
    const head = match.index + match[0].length; // just past `from` in both views
    const lineEnd = raw.includes("\n", head)
      ? raw.indexOf("\n", head)
      : raw.length;
    const rest = raw.slice(head, lineEnd);
    const open = rest.search(/["'`]/u);
    if (open === -1) continue;
    const quote = rest[open];
    let close = rest.indexOf(quote, open + 1);
    if (close === -1) close = rest.length;
    found.push({
      local: defaultBinding(clause),
      specifier: rest.slice(open + 1, close),
    });
  }
  return found;
}

/** Offset of the first live `await <local>(` call, or -1. */
function awaitOffset(stripped, local) {
  const match = new RegExp(`\\bawait\\s+${local}\\s*\\(`, "u").exec(stripped);
  return match ? match.index : -1;
}

const expected = new Map();
for (const name of siblingNames())
  expected.set(name, `packages/${name.slice(SCOPE.length)}`);

let rawSource;
try {
  rawSource = readFileSync(join(root, BUNDLE), "utf-8");
} catch (error) {
  fatal("read bundle", BUNDLE, error);
}

let rootManifest;
try {
  rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
} catch (error) {
  fatal("read manifest", "package.json", error);
}

const source = stripLiterals(rawSource);
const imports = bundleImports(rawSource, source);
const imported = imports.filter(({ specifier }) => specifier.startsWith(SCOPE));
const isImported = (name) =>
  imported.some(({ specifier }) => specifier === name);

const sections = ["dependencies", "devDependencies"].map((section) => ({
  section,
  keys: new Set(
    Object.keys(rootManifest[section] ?? {}).filter((key) =>
      key.startsWith(SCOPE)
    )
  ),
}));

for (const { section, keys } of sections) {
  // declared but not imported
  for (const key of keys) {
    if (!expected.has(key) && !EXEMPT.has(key.slice(SCOPE.length))) {
      fail(
        `root package.json ${section} declares ${key}, which is not a package under packages/`,
        `drop ${key} from ${section}, or add packages/${key.slice(SCOPE.length)}, import it and declare it`
      );
    } else if (!isImported(key) && !EXEMPT.has(key.slice(SCOPE.length))) {
      fail(
        `root package.json ${section} declares ${key}, but ${BUNDLE} never imports it`,
        `add \`import ${bindingFor(key)} from "${key}";\` and \`await ${bindingFor(key)}(pi);\` to ${BUNDLE}`
      );
    }
  }

  // imported but not declared
  for (const name of expected.keys()) {
    if (!keys.has(name)) {
      fail(
        `${BUNDLE} imports ${name}, but root package.json ${section} does not declare it`,
        `add "${name}": "<version>" to ${section} in root package.json`
      );
    }
  }
}

// imported package without a directory
for (const { specifier } of imported) {
  if (expected.has(specifier) || EXEMPT.has(specifier.slice(SCOPE.length)))
    continue;
  fail(
    `${BUNDLE} imports ${specifier}, which has no package directory under packages/`,
    `create packages/${specifier.slice(SCOPE.length)}/index.ts, or drop the import`
  );
}

// package with an entry module that the bundle never imports
for (const [name, dir] of expected) {
  if (!statSync(join(root, dir, "index.ts"), { throwIfNoEntry: false }))
    continue;
  if (isImported(name)) continue;
  fail(
    `${dir}/index.ts exists, but ${BUNDLE} does not import ${name}`,
    `add \`import ${bindingFor(name)} from "${name}";\` and \`await ${bindingFor(name)}(pi);\` to ${BUNDLE}, or exempt ${dir} in scripts/check-packages-parity.mjs`
  );
}

// duplicate imports
for (const name of expected.keys()) {
  const hits = imported.filter(({ specifier }) => specifier === name).length;
  if (hits > 1)
    fail(
      `${BUNDLE} imports ${name} ${hits} times`,
      "keep a single import per sibling"
    );
}

// stray imports: neither a sibling, an exempt package nor a host module
for (const { specifier } of imports) {
  if (specifier.startsWith(SCOPE) || HOST.test(specifier)) continue;
  fail(
    `${BUNDLE} imports "${specifier}", which is not a @lazuee/ sibling nor a host module`,
    "import host-provided modules only, or add the name to root package.json and packages/"
  );
}

// activation order: every ORDER member must be awaited, strictly in sequence
const awaited = ORDER.map((dir) => {
  const name = `${SCOPE}${dir}`;
  const hit = imported.find(({ specifier }) => specifier === name);
  if (!hit) return { dir, name, missing: true };
  if (!hit.local) return { dir, name, unbound: true };
  return { dir, name, local: hit.local, call: awaitOffset(source, hit.local) };
});

for (const [index, entry] of awaited.entries()) {
  if (entry.missing) continue; // the missing-import checks above already report it
  if (entry.unbound) {
    fail(
      `activation order: ${entry.name} is imported without a usable default binding`,
      `import it as the default export, e.g. \`import ${bindingFor(entry.name)} from "${entry.name}";\``
    );
    continue;
  }
  if (entry.call === -1) {
    fail(
      `activation order: ${entry.dir} is imported but never awaited`,
      `add \`await ${entry.local}(pi);\` inside the default factory`
    );
    continue;
  }
  const previous = awaited[index - 1];
  if (
    index === 0 ||
    !previous ||
    previous.call === -1 ||
    previous.call === undefined
  )
    continue;
  if (previous.call > entry.call) {
    fail(
      `activation order: ${entry.dir} is awaited before ${previous.dir}`,
      `move the \`await ${entry.local}(pi);\` line below the \`await ${previous.local}(pi);\` line`
    );
  }
}

if (violations.length > 0) {
  for (const violation of violations) console.error(`✗ ${violation}`);
  console.error(
    `\n${violations.length} package-parity violation(s) in ${BUNDLE} / package.json`
  );
  process.exit(1);
}

console.log(
  `✓ package parity: ${expected.size} sibling(s) imported, declared and ordered (exempt: ${[...EXEMPT].join(", ") || "none"})`
);

/** `@lazuee/pi-agent-comms` -> `PiAgentComms`, matching the bundle's binding style. */
function bindingFor(name) {
  const words = name.slice(SCOPE.length).replace(/^pi-/u, "").split("-");
  return `Pi${words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("")}`;
}
