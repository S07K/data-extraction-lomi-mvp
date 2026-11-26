/**
 * Type-aware value canonicalization.
 *
 * Canonical forms (what we store in extracted_values.value):
 *   string  → whitespace-collapsed text
 *   date    → YYYY-MM-DD
 *   money   → decimal with 2 places ("5230.29"), currency in `unit` ("USD") when known
 *   percent → percentage points as a plain number ("4.2"), unit "%"
 *   number  → plain number ("24")
 *
 * Canonical forms make two things possible: comparing values across versions
 * (carry-over) and checking that a value is actually supported by its quote.
 */
import type { FieldType } from "./fields.js";
import { normalizeForCompare } from "./text.js";

export interface CanonicalValue {
  value: string;
  unit: string | null;
}

export type CanonicalizeResult = { ok: true; value: CanonicalValue } | { ok: false; reason: string };

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_RE =
  "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";

function toIsoDate(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function monthNumber(name: string): number {
  return MONTHS[name.toLowerCase().slice(0, name.toLowerCase().startsWith("sept") ? 4 : 3)] ?? 0;
}

/** Every date found in `text`, as ISO strings, in order of appearance. */
export function findDates(text: string): string[] {
  const found: { index: number; iso: string }[] = [];
  const patterns: { re: RegExp; toIso: (m: RegExpExecArray) => string | null }[] = [
    { re: /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g, toIso: (m) => toIsoDate(+m[1]!, +m[2]!, +m[3]!) },
    {
      re: new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "gi"),
      toIso: (m) => toIsoDate(+m[3]!, monthNumber(m[1]!), +m[2]!),
    },
    {
      re: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE}\\.?,?\\s+(\\d{4})\\b`, "gi"),
      toIso: (m) => toIsoDate(+m[3]!, monthNumber(m[2]!), +m[1]!),
    },
    // US numeric MM/DD/YYYY — the documents we handle are US-centric.
    { re: /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g, toIso: (m) => toIsoDate(+m[3]!, +m[1]!, +m[2]!) },
  ];
  for (const { re, toIso } of patterns) {
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const iso = toIso(m);
      if (iso) found.push({ index: m.index, iso });
    }
  }
  return found.sort((a, b) => a.index - b.index).map((f) => f.iso);
}

const NUMBER_TOKEN_RE = /-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?/g;

/** Every number appearing in `text` (thousands separators removed). */
export function findNumbers(text: string): number[] {
  return [...text.matchAll(NUMBER_TOKEN_RE)].map((m) => Number(m[0].replace(/,/g, "")));
}

function detectCurrency(s: string): string | null {
  if (/\$|\bUSD\b/i.test(s)) return "USD";
  if (/€|\bEUR\b/i.test(s)) return "EUR";
  if (/£|\bGBP\b/i.test(s)) return "GBP";
  return null;
}

function parsePlainNumber(raw: string, strip: RegExp): number | null {
  const cleaned = raw.replace(strip, "").replace(/,/g, "").replace(/\s+/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Canonicalize a raw LLM value for a field type. `evidence` is only used to infer
 * a currency when the value itself carries none.
 */
export function canonicalizeValue(type: FieldType, raw: string, evidence?: string | null): CanonicalizeResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: "empty value" };

  switch (type) {
    case "string":
      return { ok: true, value: { value: normalizeForCompare(trimmed), unit: null } };

    case "date": {
      const dates = findDates(trimmed);
      if (dates.length !== 1) return { ok: false, reason: `"${trimmed}" is not a single recognizable date` };
      return { ok: true, value: { value: dates[0]!, unit: null } };
    }

    case "money": {
      const n = parsePlainNumber(trimmed, /\$|€|£|\b(USD|EUR|GBP)\b/gi);
      if (n === null) return { ok: false, reason: `"${trimmed}" is not a monetary amount` };
      const unit = detectCurrency(trimmed) ?? (evidence ? detectCurrency(evidence) : null);
      return { ok: true, value: { value: n.toFixed(2), unit } };
    }

    case "percent": {
      const n = parsePlainNumber(trimmed, /%|\bpercent\b/gi);
      if (n === null) return { ok: false, reason: `"${trimmed}" is not a percentage` };
      return { ok: true, value: { value: String(n), unit: "%" } };
    }

    case "number": {
      const n = parsePlainNumber(trimmed, /(?!)/g);
      if (n === null) return { ok: false, reason: `"${trimmed}" is not a number` };
      return { ok: true, value: { value: String(n), unit: null } };
    }
  }
}

/**
 * Second hallucination check: the canonical value must be literally supported by
 * its own evidence quote (a real quote paired with the wrong value is still wrong).
 */
export function isValueSupportedByEvidence(type: FieldType, value: CanonicalValue, evidence: string): boolean {
  switch (type) {
    case "string":
      return normalizeForCompare(evidence).toLowerCase().includes(value.value.toLowerCase());
    case "date":
      return findDates(evidence).includes(value.value);
    case "money":
    case "percent":
    case "number": {
      const target = Number(value.value);
      return findNumbers(evidence).some((n) => Math.abs(n - target) < 1e-9);
    }
  }
}

export function canonicalValuesEqual(a: CanonicalValue, b: CanonicalValue): boolean {
  return a.value === b.value && (a.unit ?? null) === (b.unit ?? null);
}
