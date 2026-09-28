// Helpers shared by the /api functions.
export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

// Serve from Cloudflare's edge cache when we can, so beehiiv and YouTube
// aren't called on every page view. `ttl` is in seconds.
export async function cached(context, ttl, build) {
  const cache = caches.default;
  const key = new Request(new URL(context.request.url).toString(), { method: "GET" });
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await build();
  if (res.ok) {
    const copy = new Response(res.body, res);
    copy.headers.set("Cache-Control", `public, max-age=${ttl}`);
    context.waitUntil(cache.put(key, copy.clone()));
    return copy;
  }
  return res;
}
