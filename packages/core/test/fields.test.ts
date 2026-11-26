import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FIELD_SPECS } from "../src/fields.js";
import { computeProgress, effectiveValue } from "../src/review.js";

describe("FIELD_SPECS", () => {
  it("matches fixtures/expected-fields.json exactly", () => {
    const path = fileURLToPath(new URL("../../../fixtures/expected-fields.json", import.meta.url));
    expect(FIELD_SPECS).toEqual(JSON.parse(readFileSync(path, "utf8")));
  });
});

describe("review helpers", () => {
  it("progress buckets", () => {
    const p = computeProgress([
      null,
      { action: "approved", source: "human", correctedValue: null },
      { action: "corrected", source: "human", correctedValue: "x" },
      { action: "corrected", source: "carried_over", correctedValue: "x" },
    ]);
    expect(p).toEqual({ total: 4, pending: 1, approved: 1, corrected: 1, carriedOver: 1 });
  });

  it("effective value prefers a correction", () => {
    expect(effectiveValue("a", null)).toBe("a");
    expect(effectiveValue("a", { action: "corrected", source: "human", correctedValue: "b" })).toBe("b");
    expect(effectiveValue(null, { action: "approved", source: "human", correctedValue: null })).toBeNull();
  });
});
