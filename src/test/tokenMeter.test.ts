import * as assert from "node:assert/strict";
import { test } from "node:test";
import { formatDuration, formatTokens, TokenMeter } from "../tokenMeter";

test("formats tokens and durations", () => {
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(2700), "2.7k");
  assert.equal(formatTokens(3000), "3k");
  assert.equal(formatDuration(6000), "6s");
  assert.equal(formatDuration(940000), "15m 40s");
});

test("shows the live count, then replaces it with the exact count", () => {
  let now = 0;
  const meter = new TokenMeter(1000, () => now);
  meter.beginRound(100, false);
  now = 6000;
  assert.equal(meter.status(), "Loading model… · 6s");

  meter.chunk("thinking");
  for (let i = 0; i < 2699; i += 1) {
    meter.chunk("thinking");
  }
  now = 6000 + 794118;
  assert.equal(meter.status(), "Thinking… · 2.7k tokens · 3.4 t/s");

  meter.chunk("responding");
  assert.match(meter.status(), /^Responding… · 2\.7k tokens/);

  meter.endRound({ promptTokens: 120, outputTokens: 3000, evalDurationNs: 1e12 });
  assert.equal(meter.outputTokens, 3000);
  assert.equal(meter.summary(), "↑120 ↓3k · 3.0 t/s · 13m 20s · context 100%");
});

test("adds up output across tool rounds", () => {
  const meter = new TokenMeter(10000, () => 0);
  meter.beginRound(10, true);
  assert.match(meter.status(), /^Processing prompt/);
  meter.chunk("responding");
  meter.endRound({ outputTokens: 5 });
  meter.tool("read_file");
  assert.equal(meter.status(), "Running read_file… · 5 tokens");
  meter.beginRound(50, true);
  meter.chunk("responding");
  assert.equal(meter.outputTokens, 6);
});

test("falls back to counted chunks if the server sends no totals", () => {
  const meter = new TokenMeter(0, () => 0);
  meter.beginRound(10, true);
  meter.chunk("responding");
  meter.chunk("responding");
  meter.endRound({});
  assert.equal(meter.summary(), "↑10 ↓2 · 0s");
});
