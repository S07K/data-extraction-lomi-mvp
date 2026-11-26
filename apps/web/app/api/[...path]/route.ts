/**
 * Same-origin proxy to the API. Keeps the browser on one origin and lets the API
 * address be configured at runtime (API_URL) instead of baked in at build time.
 */
const API_URL = process.env["API_URL"] ?? "http://localhost:4000";

async function proxy(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const url = new URL(req.url);
  const target = `${API_URL}/${path.map(encodeURIComponent).join("/")}${url.search}`;
  const headers = new Headers();
  for (const h of ["content-type", "accept"]) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  try {
    const res = await fetch(target, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
      cache: "no-store",
    });
    return new Response(res.body, {
      status: res.status,
      headers: {
        "content-type": res.headers.get("content-type") ?? "application/json",
        ...(res.headers.get("content-disposition") ? { "content-disposition": res.headers.get("content-disposition")! } : {}),
      },
    });
  } catch {
    return Response.json({ error: { code: "unavailable", message: "The API is not reachable. Is the api service running?" } }, { status: 502 });
  }
}

export const GET = proxy;
export const POST = proxy;
export const dynamic = "force-dynamic";
