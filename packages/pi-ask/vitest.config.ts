import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "#src": path.resolve(import.meta.dirname, "src"),
      "#test": path.resolve(import.meta.dirname, "test"),
      // The integration harness imports PTY support as the bare specifier
      // `node-pty`. `@lydell/node-pty` publishes every platform's binary as a
      // prebuilt optional dependency, so nothing has to compile here — unlike
      // `node-pty`, whose macOS `spawn-helper` lands non-executable and makes
      // every PTY spawn fail with `posix_spawnp failed`. The alias keeps the
      // harness' own bare imports working without have to build anything.
      "node-pty": path.resolve(
        import.meta.dirname,
        "node_modules/@lydell/node-pty",
      ),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    // Many files here spawn a real herdr server and drive a real Pi through it.
    // Run in parallel they contend for the machine and fail on timing rather than
    // on behaviour, so files run one at a time.
    fileParallelism: false,
  },
});
