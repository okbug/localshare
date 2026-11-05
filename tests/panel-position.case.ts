import { test } from "node:test";
import assert from "node:assert/strict";
import { controlPanelBounds } from "../src/shared/panel-position";

test("control panel stays at the work area's top right on negative-origin screens", () => {
  assert.deepEqual(
    controlPanelBounds({ x: -1920, y: -200, width: 1920, height: 1040 }),
    { x: -456, y: -184, width: 440, height: 130 },
  );
  assert.deepEqual(
    controlPanelBounds({ x: 120, y: 80, width: 800, height: 600 }),
    { x: 464, y: 96, width: 440, height: 130 },
  );
});

test("control panel fits tiny work areas without escaping their origin", () => {
  assert.deepEqual(
    controlPanelBounds({ x: -80, y: -30, width: 70, height: 40 }),
    { x: -80, y: -30, width: 70, height: 40 },
  );
});
