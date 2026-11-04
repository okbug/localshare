import { mkdtemp, readdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { verifyMacBundle } from "./mac-signature";

const target = resolve(
  process.argv[2] ??
    (process.arch === "arm64"
      ? "release/mac-arm64/LocalShare.app"
      : "release/mac/LocalShare.app"),
);
let temporary: string | undefined;
try {
  let appPath = target;
  if (target.endsWith(".zip")) {
    temporary = await mkdtemp(join(tmpdir(), "localshare-package-"));
    const extraction = spawnSync("ditto", ["-x", "-k", target, temporary], {
      encoding: "utf8",
      timeout: 120000,
    });
    if (extraction.status !== 0)
      throw new Error(extraction.error?.message ?? extraction.stderr);
    const bundles = (await readdir(temporary)).filter((name) =>
      name.endsWith(".app"),
    );
    if (bundles.length !== 1)
      throw new Error("The release ZIP must contain exactly one app bundle");
    appPath = join(temporary, bundles[0]);
  }
  const result = verifyMacBundle(appPath);
  console.log(
    JSON.stringify(
      {
        target,
        ...result,
        resources: "valid",
        nativeHelper: "valid",
        appleNotarization: "not verified by this check",
      },
      null,
      2,
    ),
  );
} finally {
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
