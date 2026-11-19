import core from "@lazuee/config/oxlint/core";
import jsPlugins from "@lazuee/config/oxlint/js-plugins";
import { defineConfig } from "oxlint";

import { ignores } from "./oxignores.config.ts";

/**
 * No React here, so `core` + `js-plugins` only.
 *
 * The rules turned off below split into three piles: shapes this repo settled
 * on long ago (tabs of JSDoc prose, `!` over `?.`, nested ternaries), rules the
 * codebase's shape defeats (an extension API that returns promises, browser
 * modules with mutable exports, JSONL sanitizers that match `\u0000`), and the
 * handful that would be churn rather than signal. Everything else is enforced.
 */
export default defineConfig({
  extends: [core, jsPlugins],
  ignorePatterns: [...core.ignorePatterns, ...ignores],
  jsPlugins: jsPlugins.jsPlugins,
  env: { node: true },
  overrides: [
    {
      // Bitwise is real work: file mode masks and packed option flags.
      files: ["**/*.ts", "**/*.mjs"],
      rules: {
        "no-bitwise": [
          "error",
          { allow: ["~", "|", "&", "^", "<<", ">>", ">>>", "|=", "&=", "^="] },
        ],
        // `Identity` is deliberately both a schema value and its static type.
        "no-redeclare": "off",
        // `== null` is the idiomatic nullish check.
        eqeqeq: ["error", "smart"],
        "no-eq-null": "off",
        // `catch {}` is deliberate.
        "no-empty": ["error", { allowEmptyCatch: true }],
      },
    },
    {
      // Served from the viewer's HTTP root, so imports are absolute there.
      files: ["packages/pi-agent-comms/src/board/viewer/web/**"],
      rules: { "import/no-absolute-path": "off" },
    },
    {
      // The lib under prebuilt/ is vendored upstream CommonJS, run verbatim by
      // the launcher, so these rules would ask for `node:fs`, ESM and
      // `replaceAll` in code that has to keep working as the release shipped it.
      // The launcher beside it is hand-written Node and does conform, so it is
      // left in scope.
      files: ["packages/pi-agent-desktop/prebuilt/lib/**"],
      rules: {
        "no-empty": "off",
        "no-implicit-globals": "off",
        "unicorn/prefer-module": "off",
        "unicorn/prefer-node-protocol": "off",
        "unicorn/prefer-string-replace-all": "off",
        "unicorn/text-encoding-identifier-case": "off",
      },
    },
  ],
  rules: {
    /** ── host API shape ─────────────────────────────────────────────────── */
    // Methods satisfy promise-returning interfaces without wrapping results.
    "require-await": "off",
    // Sequential awaits are deliberate in session and stream handling.
    "no-await-in-loop": "off",
    // `new Promise` is the only bridge to callback-only APIs, and node's
    // worker_threads `postMessage` takes no target origin.
    "promise/avoid-new": "off",
    "promise/prefer-await-to-callbacks": "off",
    "promise/prefer-await-to-then": "off",
    "promise/no-nesting": "off",
    "promise/no-promise-in-callback": "off",
    "unicorn/require-post-message-target-origin": "off",
    // `void` in a union reads as "returns nothing" for callback contracts.
    "typescript/no-invalid-void-type": "off",
    // Handler types are `readonly` properties; method syntax would fight them.
    "typescript/method-signature-style": "off",
    // `?.`-guarding every local invariant is noisier than `!`.
    "typescript/no-non-null-assertion": "off",
    // `any` is the escape hatch for pi's untyped event payloads.
    "typescript/no-explicit-any": "off",

    /** ── data & module shape ────────────────────────────────────────────── */
    // The browser modules export mutable module state written by siblings.
    "import/no-mutable-exports": "off",
    // `delete args[key]` on tool-argument bags beats converting them to Maps.
    "typescript/no-dynamic-delete": "off",
    // `registry.find(provider, id)` takes two args, read as `thisArg`.
    "unicorn/no-array-method-this-argument": "off",
    // Identity/mode sanitizers match control characters on purpose.
    "no-control-regex": "off",
    // Long-lived `closed`/`ended` flags are read from inside loop closures.
    "no-loop-func": "off",
    "no-unmodified-loop-condition": "off",

    /** ── settled style ──────────────────────────────────────────────────── */
    // Type-ahead declarations are idiomatic; the rule cannot see types.
    "no-use-before-define": "off",
    // Short-lived locals shadow outer names on purpose.
    "no-shadow": "off",
    // Params widen in place in these parsers.
    "no-param-reassign": "off",
    "no-useless-return": "off",
    "unicorn/no-useless-undefined": "off",
    "class-methods-use-this": "off",
    // `obj?.` chains read fine nested once formatted.
    "no-nested-ternary": "off",
    // Arrow handlers are fine unnamed.
    "func-names": "off",
    "unicorn/no-anonymous-default-export": "off",
    "unicorn/prefer-optional-catch-binding": "off",
    // `import { join } from "node:path"`; a default import forces `default`.
    "unicorn/import-style": "off",
    // `postMessage` aside, these are the call shapes the codebase chose.
    "unicorn/prefer-default-parameters": "off",
    "unicorn/prefer-add-event-listener": "off",

    /** ── noise ──────────────────────────────────────────────────────────── */
    // Renderers are branchy and index-driven.
    complexity: "off",
    "max-nested-callbacks": "off",
    "no-plusplus": "off",
    "unicorn/no-array-reduce": "off",
    "unicorn/no-await-expression-member": "off",
    "unicorn/consistent-function-scoping": "off",
    // Paired error/contract classes stay in one file.
    "max-classes-per-file": "off",
    // Forced-executor returns have been fine since ES2019.
    "no-promise-executor-return": "off",
    // `.catch(handler)` reads better than `then(_, handler)`.
    "promise/prefer-catch": "off",
    "promise/param-names": "off",
    // Numeric capture groups beat named ones in one-off parse regexes.
    "prefer-named-capture-group": "off",
    // `u` on every already-working regex is not worth the churn.
    "require-unicode-regexp": "off",
    // A JSDoc description per param is more prose than the code deserves.
    "jsdoc/require-param-description": "off",
    "jsdoc/require-returns-description": "off",
    // JSDoc type casts and `/* empty */` bodies sit inline by necessity.
    "no-inline-comments": "off",
  },
});
