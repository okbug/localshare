import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

await mkdir("test-results", { recursive: true });
await mkdir("docs/images", { recursive: true });
const root = await mkdtemp(resolve("test-results/smoke-"));
const env: NodeJS.ProcessEnv = {
  ...process.env,
  LOCALSHARE_PORT: "0",
  LOCALSHARE_NO_DISCOVERY: "1",
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.LOCALSHARE_DEV_URL;
const apps: Awaited<ReturnType<typeof electron.launch>>[] = [];
try {
  for (const alias of ["Mac Studio", "Windows PC"]) {
    const app = await electron.launch({
      args: process.env.LOCALSHARE_EXECUTABLE_PATH ? [] : ["."],
      executablePath: process.env.LOCALSHARE_EXECUTABLE_PATH,
      timeout: 20000,
      env: {
        ...env,
        LOCALSHARE_DATA_DIR: join(root, alias, "profile"),
        LOCALSHARE_RECEIVE_DIR: join(root, alias, "received"),
        LOCALSHARE_ALIAS: alias,
      },
    });
    apps.push(app);
  }
  const [a, b] = await Promise.all(apps.map((a) => a.firstWindow()));
  const errors: string[] = [];
  for (const p of [a, b]) p.on("pageerror", (e) => errors.push(e.message));
  await a.getByRole("heading", { name: "分享，从这里开始。" }).waitFor();
  await b.getByRole("heading", { name: "分享，从这里开始。" }).waitFor();
  const bInfo = await b.evaluate(() => window.localshare.snapshot());
  await a.getByRole("button", { name: "手动添加", exact: true }).click();
  await a.getByPlaceholder("192.168.1.100").fill("127.0.0.1");
  await a.getByRole("spinbutton").fill(String(bInfo.info.port));
  await a.getByRole("button", { name: "连接设备", exact: true }).click();
  await a.getByRole("button", { name: /Windows PC.*发送到此设备/ }).waitFor();
  const file = join(root, "项目说明.txt");
  const content = "LocalShare Mac ↔ Windows\n文件与目录传输冒烟检查。\n";
  await writeFile(file, content);
  await a.evaluate((paths) => window.localshare.addDropped(paths), [file]);
  await a.getByText("1 个文件 ·").waitFor();
  await a
    .getByRole("button", { name: "关闭提示", exact: true })
    .click()
    .catch(() => {});
  await a.screenshot({ path: "docs/images/localshare.png", fullPage: true });
  await a.getByRole("button", { name: /Windows PC.*发送到此设备/ }).click();
  await b.getByRole("button", { name: "接收", exact: true }).click();
  await b.getByRole("button", { name: "接收文件", exact: true }).click();
  await b.getByText("已完成", { exact: true }).waitFor();
  const received = (
    await b.evaluate(() => window.localshare.snapshot())
  ).transfers.find((t) => t.direction === "receive")!;
  assert.equal(received.status, "completed");
  assert.equal(await readFile(received.files[0].savedPath!, "utf8"), content);
  console.log(
    "PASS: Two real Electron windows, manual IP connect, file selection, approval, exact saved content.",
  );
  for (const p of [a, b])
    await p.getByRole("button", { name: "设备协同", exact: false }).click();
  await a.getByRole("button", { name: "配对", exact: true }).click();
  await a.getByRole("button", { name: "校验码相同", exact: true }).waitFor();
  await b.getByRole("button", { name: "校验码相同", exact: true }).waitFor();
  const codeA = await a.locator(".pair-code").textContent(),
    codeB = await b.locator(".pair-code").textContent();
  assert.equal(codeA, codeB);
  await a.getByRole("button", { name: "校验码相同", exact: true }).click();
  await b.getByRole("button", { name: "校验码相同", exact: true }).click();
  await a.locator(".trusted-card").waitFor();
  await b.locator(".trusted-card").waitFor();
  await a.getByRole("switch", { name: "文本剪贴板共享", exact: true }).click();
  await b.getByRole("switch", { name: "文本剪贴板共享", exact: true }).click();
  assert.equal(
    (await a.evaluate(() => window.localshare.snapshot())).extensions
      .clipboardEnabled,
    true,
  );
  await a.waitForFunction(
    () =>
      document
        .querySelector('[role="switch"][aria-label="文本剪贴板共享"]')
        ?.getAttribute("aria-checked") === "true",
  );
  await a.evaluate(() => window.scrollTo(0, 0));
  await a.screenshot({ path: "docs/images/connect.png" });
  console.log(
    "PASS: Matching pairing codes, both-side confirmation, trusted device UI and clipboard switches.",
  );
  await a.getByRole("button", { name: "设置", exact: true }).click();
  await a.getByLabel("设备名称", { exact: true }).fill("我的 Mac");
  await a.getByRole("button", { name: "保存名称", exact: true }).click();
  await a.waitForFunction(
    async () => (await window.localshare.snapshot()).info.alias === "我的 Mac",
  );
  assert.deepEqual(errors, []);
  console.log("PASS: Settings IPC and no renderer errors.");
} finally {
  await Promise.all(apps.map((a) => a.close().catch(() => {})));
  await rm(root, { recursive: true, force: true });
}
