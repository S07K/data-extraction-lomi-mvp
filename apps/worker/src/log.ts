/** Minimal structured logger (JSON lines) — enough to follow a version through the pipeline. */
export function log(event: string, fields: Record<string, unknown> = {}) {
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), svc: "worker", event, ...fields })}\n`);
}
