import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyMacBundle } from "../scripts/mac-signature";

test(
  "Mac release has a valid sealed bundle, the application identifier and a signed input helper",
  {
    skip: process.platform !== "darwin" || !process.env.LOCALSHARE_TEST_MAC_APP,
  },
  () => {
    assert.doesNotThrow(() =>
      verifyMacBundle(process.env.LOCALSHARE_TEST_MAC_APP!),
    );
  },
);
