/**
 * Text normalization and verbatim quote location.
 *
 * Parsed document text is canonicalized ONCE at parse time (canonicalizeDocumentText)
 * and stored per version. Evidence matching then tolerates exactly one thing beyond
 * an exact substring: differences in whitespace (PDF text extraction is inconsistent
 * about line breaks and runs of spaces). Nothing else is fuzzy.
 */

/** Applied to parser output before it is stored. NFKC folds PDF ligatures (e.g. "ﬁ" → "fi"). */
export function canonicalizeDocumentText(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

/** Whitespace-insensitive form used for comparisons (never for storage). */
export function normalizeForCompare(s: string): string {
  return s.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export interface Span {
  start: number;
  end: number;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Find `quote` in `text`. Exact match first; otherwise the quote's non-whitespace
 * tokens must appear in order separated only by whitespace. Returns the span in
 * the ORIGINAL text (for highlighting), or null if the quote is not verbatim.
 */
export function locateQuote(text: string, quote: string): Span | null {
  const q = quote.normalize("NFKC").trim();
  if (q.length === 0) return null;

  const exact = text.indexOf(q);
  if (exact !== -1) return { start: exact, end: exact + q.length };

  const tokens = q.split(/\s+/).filter(Boolean).map(escapeRegExp);
  const re = new RegExp(tokens.join("\\s+"));
  const m = re.exec(text);
  return m ? { start: m.index, end: m.index + m[0].length } : null;
}

/** True if `quote` occurs verbatim (whitespace-insensitive) in `text`. */
export function containsQuote(text: string, quote: string): boolean {
  return locateQuote(text, quote) !== null;
}
