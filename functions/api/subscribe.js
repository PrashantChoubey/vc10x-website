// POST /api/subscribe
// Adds website and audit signups to your beehiiv publication.
// Set these in Cloudflare Pages > Settings > Variables and Secrets:
//   BEEHIIV_API_KEY         (as a Secret) beehiiv > Settings > API > Create new key
//   BEEHIIV_PUBLICATION_ID  starts with pub_
import { json } from "../_shared.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clip = (v, n = 100) => (v == null || v === "" ? undefined : String(v).slice(0, n));

export async function onRequestPost({ request, env }) {
  let b;
  try { b = await request.json(); } catch { return json({ error: "Request body must be JSON" }, 400); }

  if (b.website) return json({ ok: true }); // honeypot: bots fill the hidden field
  if (!EMAIL.test(b.email || "")) return json({ error: "Invalid email address" }, 400);

  const { BEEHIIV_API_KEY, BEEHIIV_PUBLICATION_ID } = env;
  if (!BEEHIIV_API_KEY || !BEEHIIV_PUBLICATION_ID) {
    console.error("Missing BEEHIIV_API_KEY or BEEHIIV_PUBLICATION_ID");
    return json({ error: "Server not configured" }, 500);
  }

  // These custom fields must already exist in beehiiv (Audience > Custom fields),
  // spelled exactly like this, or beehiiv drops them.
  const custom_fields = [
    { name: "First Name", value: clip(b.firstName, 60) },
    { name: "Role", value: clip(b.role, 60) },
    { name: "Audit Score", value: clip(b.score, 5) },
    { name: "Audit Tier", value: clip(b.tier, 30) },
    { name: "Weakest Pillar", value: clip(b.weakest, 30) },
  ].filter((f) => f.value);

  const res = await fetch(
    `https://api.beehiiv.com/v2/publications/${BEEHIIV_PUBLICATION_ID}/subscriptions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${BEEHIIV_API_KEY}` },
      body: JSON.stringify({
        email: b.email.trim().toLowerCase(),
        reactivate_existing: false,
        send_welcome_email: true,
        utm_source: clip(b.utm_source) || "vc10x.com",
        utm_medium: clip(b.utm_medium) || "website",
        utm_campaign: clip(b.utm_campaign) || clip(b.form, 60) || "website",
        utm_content: clip(b.utm_content),
        referring_site: clip(b.referrer, 200),
        custom_fields,
      }),
    }
  );

  if (!res.ok) {
    console.error("beehiiv error", res.status, await res.text());
    return json({ error: "Subscription failed" }, 502);
  }
  const out = await res.json().catch(() => ({}));
  if (out.warnings?.length) console.warn("beehiiv warnings", JSON.stringify(out.warnings));
  return json({ ok: true });
}

export const onRequest = () => json({ error: "Use POST" }, 405);
