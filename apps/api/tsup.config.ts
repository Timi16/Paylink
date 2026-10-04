import { defineConfig } from "tsup";

// One build, two entry points: the image starts as either the api or the worker.
export default defineConfig({
  entry: { server: "src/server.ts", worker: "src/worker.ts" },
  format: ["cjs"],
  target: "node22",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  splitting: false,
  noExternal: ["@paylink/shared"],
});
