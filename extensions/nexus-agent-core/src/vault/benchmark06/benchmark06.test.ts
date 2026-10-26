// Benchmark 06 "File processing", first version. The scoring lives in run.ts; this test pins every dimension at 100% (the
// whole run is deterministic) and prints the scorecard when NEXUS_BENCH_REPORT=1.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { formatScorecard, runBenchmark06 } from "./run.js";
import { EXTRACTION_SAMPLES, SEARCH_CASES } from "./samples.js";

describe("benchmark 06: file processing", () => {
  it("scores 100% on extraction, search, sensitive skipping and injection protection", async () => {
    const card = await runBenchmark06();
    if (process.env.NEXUS_BENCH_REPORT === "1") {
      console.log(`\n${formatScorecard(card)}\n`);
    }
    const failed = card.cases.filter((item) => !item.pass);
    assert.deepEqual(
      failed.map((item) => `[${item.dimension}] ${item.id}: ${item.detail}`),
      [],
      formatScorecard(card),
    );
    assert.equal(card.search.precision, 1);
    assert.equal(card.search.recall, 1);
    assert.deepEqual(card.leaks, []);
  });

  it("covers every sample and query it declares, and each dimension has cases", async () => {
    const card = await runBenchmark06();
    assert.equal(card.byDimension.extraction.total, EXTRACTION_SAMPLES.length);
    assert.ok(card.byDimension.search.total >= SEARCH_CASES.length);
    assert.ok(card.byDimension.search.total >= SEARCH_CASES.length + 5);
    assert.ok(card.byDimension.sensitive.total >= 11);
    assert.ok(card.byDimension.injection.total >= 11);
    // The ids are unique, so a failure always names exactly one case.
    const ids = card.cases.map((item) => item.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});
