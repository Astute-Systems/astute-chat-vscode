import * as assert from "node:assert/strict";
import { test } from "node:test";
import { autoThreadCount, countPhysicalCores } from "../threads";

test("counts physical cores, not hyper-threads", () => {
  const cpu = (id: number) => `processor : ${id}\nphysical id : 0\ncore id : ${id % 2}\n\n`;
  assert.equal(countPhysicalCores([0, 1, 2, 3].map(cpu).join("")), 2);
  assert.equal(countPhysicalCores(""), 0);
});

test("limits threads only on large CPUs", () => {
  assert.equal(autoThreadCount(24), 16);
  assert.equal(autoThreadCount(12), 8);
  assert.equal(autoThreadCount(8), undefined);
  assert.equal(autoThreadCount(0), undefined);
});
