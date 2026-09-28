// GET /api/issues
// Latest published newsletter issues from beehiiv, cached at the edge for 10 minutes.
import { json, cached } from "../_shared.js";

const LIMIT = 6;

export async function onRequestGet(context) {
  const { BEEHIIV_API_KEY, BEEHIIV_PUBLICATION_ID } = context.env;
  if (!BEEHIIV_API_KEY || !BEEHIIV_PUBLICATION_ID) return json({ issues: [] }, 500);

  return cached(context, 600, async () => {
    const q = new URLSearchParams({
      status: "confirmed",
      hidden_from_feed: "false",
      order_by: "publish_date",
      direction: "desc",
      limit: String(LIMIT + 4),
    });
    try {
      const res = await fetch(
        `https://api.beehiiv.com/v2/publications/${BEEHIIV_PUBLICATION_ID}/posts?${q}`,
        { headers: { Authorization: `Bearer ${BEEHIIV_API_KEY}` } }
      );
      if (!res.ok) {
        console.error("beehiiv", res.status, await res.text());
        return json({ issues: [] }, 502);
      }
      const { data = [] } = await res.json();
      const now = Date.now() / 1000;
      const issues = data
        .filter((p) => p.web_url && p.title && (p.publish_date || 0) <= now)
        .slice(0, LIMIT)
        .map((p) => ({
          title: p.title,
          subtitle: p.subtitle || p.preview_text || "",
          url: p.web_url,
          image: p.thumbnail_url || "",
          date: new Date((p.displayed_date || p.publish_date) * 1000).toISOString(),
        }));
      const archive = issues[0] ? new URL(issues[0].url).origin : "";
      return json({ issues, archive });
    } catch (e) {
      console.error(e);
      return json({ issues: [] }, 502);
    }
  });
}
