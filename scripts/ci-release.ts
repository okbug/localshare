import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename } from "node:path";

const version = JSON.parse(readFileSync("package.json", "utf8"))
  .version as string;
const tag = process.env.RELEASE_TAG ?? "";
if (!/^v\d+\.\d+\.\d+$/.test(tag) || tag !== `v${version}`)
  throw new Error("Release tag must match package.json exactly");
const repo = process.env.GITHUB_REPOSITORY ?? "okbug/localshare";
if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Invalid repository");
function gh(args: string[], output = false): string {
  const result = execFileSync("gh", args, {
    encoding: "utf8",
    stdio: output ? "inherit" : "pipe",
    timeout: 240000,
  });
  return result ?? "";
}
interface Asset {
  id: number;
  name: string;
  state: string;
  size: number;
}
interface Release {
  id: number;
  tag_name: string;
  draft: boolean;
  assets: Asset[];
}
function release(): Release {
  const releases = JSON.parse(
    gh(["api", `repos/${repo}/releases?per_page=30`]),
  ) as Release[];
  const item = releases.find((r) => r.tag_name === tag);
  if (!item) throw new Error("Preview draft not found");
  return item;
}
const debugNames = new Set([
  "network-check.bin",
  "origin-network-check.bin",
  "fragment-check.bin",
  "localshare-upload-check.bin",
  "SHA256SUMS.txt",
]);
function cleanup(item: Release) {
  for (const asset of item.assets)
    if (debugNames.has(asset.name))
      gh([
        "api",
        "--method",
        "DELETE",
        `repos/${repo}/releases/assets/${asset.id}`,
      ]);
}
const phase = process.argv[2];
if (phase === "prepare") {
  const releases = JSON.parse(
    gh(["api", `repos/${repo}/releases?per_page=30`]),
  ) as Release[];
  const existing = releases.find((r) => r.tag_name === tag);
  if (existing && !existing.draft)
    throw new Error("Published releases are not overwritten by this workflow");
  if (!existing)
    gh(
      [
        "release",
        "create",
        tag,
        "--repo",
        repo,
        "--target",
        process.env.GITHUB_SHA ?? "main",
        "--title",
        `LocalShare ${tag} 预览版`,
        "--notes-file",
        `.github/release-notes/${tag}.md`,
        "--draft",
        "--prerelease",
      ],
      true,
    );
  cleanup(release());
  gh(
    [
      "release",
      "edit",
      tag,
      "--repo",
      repo,
      "--notes-file",
      `.github/release-notes/${tag}.md`,
    ],
    true,
  );
  if (process.env.GITHUB_SHA)
    gh([
      "api",
      "--method",
      "PATCH",
      `repos/${repo}/releases/${release().id}`,
      "-f",
      `target_commitish=${process.env.GITHUB_SHA}`,
    ]);
} else if (phase === "upload") {
  const item = release();
  if (!item.draft) throw new Error("Upload requires a draft release");
  const target = process.env.RELEASE_TARGET;
  const files =
    target === "mac"
      ? [`release/LocalShare-${version}-arm64-mac.zip`]
      : target === "win"
        ? [
            `release/LocalShare Setup ${version}.exe`,
            `release/LocalShare ${version}.exe`,
          ]
        : [];
  if (!files.length || files.some((file) => !existsSync(file)))
    throw new Error("Expected platform artifacts were not built");
  const checksum = `release/SHA256SUMS-${target}.txt`;
  writeFileSync(
    checksum,
    files
      .map(
        (file) =>
          createHash("sha256").update(readFileSync(file)).digest("hex") +
          "  " +
          basename(file).replaceAll(" ", "."),
      )
      .join("\n") + "\n",
  );
  for (const file of [...files, checksum])
    gh(["release", "upload", tag, file, "--repo", repo, "--clobber"], true);
} else if (phase === "publish") {
  const item = release();
  if (!item.draft) throw new Error("Release is already published");
  for (const name of [
    `LocalShare-${version}-arm64-mac.zip`,
    `LocalShare.Setup.${version}.exe`,
    `LocalShare.${version}.exe`,
  ]) {
    if (
      !item.assets.some(
        (a) =>
          a.name === name && a.state === "uploaded" && a.size > 1024 * 1024,
      )
    )
      throw new Error(`Missing verified build artifact: ${name}`);
  }
  cleanup(item);
  gh(
    ["release", "edit", tag, "--repo", repo, "--draft=false", "--prerelease"],
    true,
  );
} else throw new Error("Expected prepare, upload or publish phase");
