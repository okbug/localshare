import { test, expect } from "bun:test";
import { readdir, mkdir } from "node:fs/promises";
import { build } from "esbuild";
test("Node integration suite (same networking runtime as Electron)", async () => {
  await mkdir("test-results", { recursive: true });
  const specs = (await readdir("tests")).filter((p) => p.endsWith(".case.ts"));
  await build({
    entryPoints: specs.map((p) => `tests/${p}`),
    outdir: "test-results/specs",
    outExtension: { ".js": ".cjs" },
    bundle: true,
    platform: "node",
    format: "cjs",
  });
  const proc = Bun.spawn(
    [
      "node",
      "--test",
      ...specs.map((p) => `test-results/specs/${p.replace(".ts", ".cjs")}`),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  console.log(stdout);
  if (stderr) console.error(stderr);
  expect(code).toBe(0);
}, 120000);
