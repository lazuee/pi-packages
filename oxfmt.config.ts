import base from "@lazuee/config/oxfmt";
import { defineConfig } from "oxfmt";

import { ignores } from "./oxignores.config.ts";

export default defineConfig({
  ...base,
  ignorePatterns: [...base.ignorePatterns, ...ignores],
});
