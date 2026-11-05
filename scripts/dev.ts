import { createServer } from "vite";
import { build } from "esbuild";
await Promise.all([
  build({
    entryPoints: ["src/main/index.ts"],
    outfile: "dist/main/index.cjs",
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    sourcemap: true,
  }),
  build({
    entryPoints: ["src/preload/control-panel.ts"],
    outfile: "dist/preload/control-panel.cjs",
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
  }),
  build({
    entryPoints: ["src/preload/index.ts"],
    outfile: "dist/preload/index.cjs",
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
  }),
]);
const server = await createServer();
await server.listen();
const env: NodeJS.ProcessEnv = {
  ...process.env,
  LOCALSHARE_DEV_URL: "http://127.0.0.1:5173",
};
delete env.ELECTRON_RUN_AS_NODE;
const child = Bun.spawn(["bun", "x", "electron", "."], {
  env,
  stdout: "inherit",
  stderr: "inherit",
});
const stop = async () => {
  child.kill();
  await server.close();
  process.exit();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await child.exited;
await server.close();
