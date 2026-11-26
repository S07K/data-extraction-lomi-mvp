import { describe, expect, it } from "vitest";
import { canonicalizeDocumentText, locateQuote } from "../src/text.js";
import { LEASE } from "./texts.js";

describe("locateQuote", () => {
  it("finds an exact substring and returns its span", () => {
    const span = locateQuote(LEASE, "monthly rent of $2,350.00");
    expect(span).not.toBeNull();
    expect(LEASE.slice(span!.start, span!.end)).toBe("monthly rent of $2,350.00");
  });

  it("tolerates whitespace differences (quote spanning a PDF line break)", () => {
    const span = locateQuote(LEASE, "twenty-four (24) months");
    expect(span).not.toBeNull();
    expect(LEASE.slice(span!.start, span!.end)).toBe("twenty-four (24)\nmonths");
  });

  it("rejects paraphrases, ellipses and changed characters", () => {
    expect(locateQuote(LEASE, "monthly rent is $2,350.00")).toBeNull();
    expect(locateQuote(LEASE, "The initial term ... months")).toBeNull();
    expect(locateQuote(LEASE, "monthly rent of $2,350")).not.toBeNull(); // a true substring is still verbatim
    expect(locateQuote(LEASE, "Monthly rent of $2,350.00")).toBeNull(); // case matters
  });

  it("treats regex metacharacters in quotes literally", () => {
    expect(locateQuote("Sales Tax (8.625%): $415.29", "Tax (8.625%): $415.29")).not.toBeNull();
    expect(locateQuote("Sales Tax (8x625%)", "Tax (8.625%)")).toBeNull();
  });

  it("returns null for empty quotes", () => {
    expect(locateQuote(LEASE, "   ")).toBeNull();
  });
});

describe("canonicalizeDocumentText", () => {
  it("folds ligatures and line endings", () => {
    expect(canonicalizeDocumentText("ﬁle\r\nnext  \r\n")).toBe("file\nnext");
  });
});
