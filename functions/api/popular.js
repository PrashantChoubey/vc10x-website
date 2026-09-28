// GET /api/popular?ids=a,b,c
// Titles for the Popular uploads videos via YouTube's public oEmbed endpoint
// (no API key needed), cached at the edge for a day.
import { json, cached } from "../_shared.js";

const ID = /^[A-Za-z0-9_-]{11}$/;

export async function onRequestGet(context) {
  const ids = (new URL(context.request.url).searchParams.get("ids") || "")
    .split(",").map((s) => s.trim()).filter((s) => ID.test(s)).slice(0, 12);
  if (!ids.length) return json({ videos: [] }, 400);

  return cached(context, 86400, async () => {
    const videos = await Promise.all(ids.map(async (id) => {
      try {
        const r = await fetch(
          `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent("https://www.youtube.com/watch?v=" + id)}`
        );
        if (!r.ok) throw new Error(String(r.status));
        const d = await r.json();
        return { id, title: d.title || "", channel: d.author_name || "" };
      } catch (e) {
        console.error("oEmbed failed", id, e.message);
        return { id, title: "", channel: "" };
      }
    }));
    return json({ videos });
  });
}
