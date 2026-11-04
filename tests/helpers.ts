import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalShareService } from "../src/core/service";
export async function makePeer(alias: string) {
  const root = await mkdtemp(join(tmpdir(), "localshare-case-"));
  const service = new LocalShareService({
    alias,
    dataDir: join(root, "data"),
    receiveDir: join(root, "received"),
    port: 0,
    discovery: false,
  });
  await service.start();
  return {
    service,
    root,
    async close() {
      await service.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}
