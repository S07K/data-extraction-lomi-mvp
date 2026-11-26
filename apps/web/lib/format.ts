import type { VersionStatus } from "@lomi/contracts";

export function fieldLabel(field: string): string {
  const s = field.replace(/_/g, " ").replace(/\b1br\b/, "1-bedroom");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const TYPE_LABEL: Record<string, string> = { invoice: "Invoice", lease: "Lease", market_report: "Market report" };

export function formatValue(value: string | null, fieldType: string, unit: string | null): string {
  if (value === null) return "—";
  if (fieldType === "money") {
    const n = Number(value);
    if (Number.isFinite(n)) {
      try {
        return new Intl.NumberFormat("en-US", { style: "currency", currency: unit ?? "USD" }).format(n);
      } catch {
        return `${value} ${unit ?? ""}`.trim();
      }
    }
  }
  if (fieldType === "percent") return `${value}%`;
  if (fieldType === "date") {
    const d = new Date(`${value}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
    }
  }
  return value;
}

export const STATUS_TEXT: Record<VersionStatus, string> = {
  queued: "Waiting to extract",
  extracting: "Extracting",
  extracted: "Extracted",
  failed: "Extraction failed",
  superseded: "Replaced by a newer version",
};

export function timeAgo(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}
