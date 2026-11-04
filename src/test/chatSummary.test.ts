import * as assert from "node:assert/strict";
import { test } from "node:test";
import { messagesToSummarise, needsSummary, summarySection } from "../chatSummary";
import type { ChatMessage } from "../ollamaClient";

const turns = (count: number, size: number): ChatMessage[] => Array.from({ length: count }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: "x".repeat(size) }));

test("summarises only when history fills half the context", () => {
  assert.equal(needsSummary(turns(6, 100), 8192), false);
  assert.equal(needsSummary(turns(6, 4000), 8192), true);
  assert.equal(needsSummary(turns(4, 20000), 8192), false, "the latest messages are always kept whole");
});

test("keeps the most recent messages out of the summary", () => {
  assert.equal(messagesToSummarise(turns(10, 1)), 6);
  assert.equal(messagesToSummarise(turns(2, 1)), 0);
});

test("labels the summary for the system prompt", () => {
  assert.match(summarySection("- built libadd.a"), /earlier conversation:\n- built libadd\.a/);
});
