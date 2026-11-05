import { test } from "node:test";
import assert from "node:assert/strict";
import { boundedShutdown } from "../src/main/shutdown-deadline";
test("a stalled persistence stage cannot prevent final application exit after the deadline", async () => {
  const steps: string[] = [];
  let finish = 0;
  await boundedShutdown(
    async () => {
      steps.push("native released");
      await new Promise<void>(() => {});
      steps.push("saved");
    },
    () => {
      finish++;
    },
    20,
  );
  assert.deepEqual(steps, ["native released"]);
  assert.equal(finish, 1);
});
test("completed or failed cleanup exits once without waiting out the deadline", async () => {
  let finish = 0;
  await boundedShutdown(
    async () => {},
    () => {
      finish++;
    },
    1000,
  );
  await boundedShutdown(
    async () => {
      throw new Error("persistence failed");
    },
    () => {
      finish++;
    },
    1000,
  );
  assert.equal(finish, 2);
});
