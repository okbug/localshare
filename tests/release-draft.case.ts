import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, delimiter } from "node:path";
import { execFileSync } from "node:child_process";

test(
  "release preparation uses the created draft ID even while the release list remains stale",
  { skip: process.platform === "win32" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "localshare-draft-"));
    const version = JSON.parse(readFileSync("package.json", "utf8")).version;
    const tag = `v${version}`,
      log = join(root, "patched.json");
    try {
      mkdirSync(join(root, "bin"));
      writeFileSync(
        join(root, "bin", "gh"),
        `#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2);
if(args[0]==='release'&&args[1]==='create'){console.log('https://github.com/okbug/localshare/releases/tag/untagged-test');process.exit(0)}
if(args[0]==='api'&&args[1]==='repos/okbug/localshare/releases?per_page=30'){console.log('[]');process.exit(0)}
if(args[0]==='api'&&args.includes('POST')){const body=JSON.parse(fs.readFileSync(0,'utf8'));console.log(JSON.stringify({id:42,name:body.name,tag_name:'untagged-test',draft:true,assets:[]}));process.exit(0)}
if(args[0]==='api'&&args.includes('PATCH')){const body=JSON.parse(fs.readFileSync(0,'utf8'));fs.writeFileSync(process.env.DRAFT_TEST_LOG,JSON.stringify({path:args.find(a=>a.startsWith('repos/')),body}));console.log('{}');process.exit(0)}
throw new Error('Unexpected gh invocation: '+JSON.stringify(args));
`,
        { mode: 0o700 },
      );
      execFileSync("bun", [resolve("scripts/ci-release.ts"), "prepare"], {
        encoding: "utf8",
        timeout: 15000,
        env: {
          ...process.env,
          PATH: join(root, "bin") + delimiter + process.env.PATH,
          RELEASE_TAG: tag,
          GITHUB_REPOSITORY: "okbug/localshare",
          GITHUB_SHA: "test-sha",
          DRAFT_TEST_LOG: log,
        },
      });
      const patched = JSON.parse(readFileSync(log, "utf8"));
      assert.equal(patched.path, "repos/okbug/localshare/releases/42");
      assert.equal(patched.body.tag_name, tag);
      assert.equal(patched.body.draft, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
