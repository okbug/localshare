import { spawnSync } from "node:child_process";
import { join } from "node:path";

function checked(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 30000 });
  if (result.error || result.status !== 0) {
    throw new Error(
      `macOS package verification failed: ${command}\n${result.error?.message ?? ""}${result.stderr}${result.stdout}`,
    );
  }
  return `${result.stdout}${result.stderr}`;
}

export function verifyMacBundle(appPath: string) {
  if (process.platform !== "darwin")
    throw new Error("Mac package verification requires macOS");
  checked("codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    appPath,
  ]);
  const identifier = checked("plutil", [
    "-extract",
    "CFBundleIdentifier",
    "raw",
    "-o",
    "-",
    join(appPath, "Contents/Info.plist"),
  ]).trim();
  const signature = checked("codesign", ["--display", "--verbose=4", appPath]);
  if (
    identifier !== "org.localshare.desktop" ||
    !signature.includes(`Identifier=${identifier}\n`)
  ) {
    throw new Error("Application signing identifier does not match LocalShare");
  }
  if (!/flags=.*runtime/.test(signature))
    throw new Error("The application must retain Hardened Runtime");
  checked("codesign", [
    "--verify",
    "--strict",
    "--verbose=2",
    join(appPath, "Contents/Resources/native/localshare-input"),
  ]);
  return {
    identifier,
    signature: signature.includes("Signature=adhoc") ? "ad-hoc" : "certificate",
  };
}
