import { canonicalizeDocumentText, ExtractionError } from "@lomi/core";
import { extractText, getDocumentProxy } from "unpdf";

export const PARSER_VERSION = "unpdf@2.2.3";
const MAX_PAGES = 50;

/**
 * PDF bytes → canonical text. Failures are PERMANENT: re-parsing the same bytes
 * gives the same result, so they go straight to `failed` instead of burning retries.
 */
export async function parsePdf(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
  let pdf;
  try {
    // pdf.js takes ownership of the buffer, so hand it a copy.
    pdf = await getDocumentProxy(new Uint8Array(bytes));
  } catch (err) {
    throw new ExtractionError(`Could not open PDF: ${(err as Error).message}`, "permanent", { cause: err });
  }
  try {
    if (pdf.numPages > MAX_PAGES) {
      throw new ExtractionError(`PDF has ${pdf.numPages} pages; the limit is ${MAX_PAGES}`, "permanent");
    }
    const { text } = await extractText(pdf, { mergePages: true });
    const canonical = canonicalizeDocumentText(text);
    if (!canonical) {
      throw new ExtractionError("PDF has no extractable text layer (scanned image?) — OCR is not supported", "permanent");
    }
    return { text: canonical, pages: pdf.numPages };
  } catch (err) {
    if (err instanceof ExtractionError) throw err;
    throw new ExtractionError(`Could not read PDF text: ${(err as Error).message}`, "permanent", { cause: err });
  }
}
