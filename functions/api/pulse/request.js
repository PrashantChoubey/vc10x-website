// POST /api/pulse/request
// Invite request from the public page. Stored for review on /cio-pulse/admin/; nothing is sent automatically.
import { json } from "../../_shared.js";
import { handle, getDb, HttpError, EMAIL, clip, ORG_TYPES, AUM } from "../../_pulse.js";

export const onRequestPost = handle(async ({ request, env }) => {
  let b;
  try { b = await request.json(); } catch { throw new HttpError(400, "Request body must be JSON"); }
  if (b.website) return json({ ok: true }); // honeypot: bots fill the hidden field
  const name = clip(b.name, 80), email = clip(b.email, 120).toLowerCase(), firm = clip(b.firm, 120);
  if (!name) throw new HttpError(400, "Add your name");
  if (!EMAIL.test(email)) throw new HttpError(400, "Add a valid work email");
  if (!firm) throw new HttpError(400, "Add your organization");
  if (!ORG_TYPES[b.org_type]) throw new HttpError(400, "Choose your organization type");
  if (!AUM[b.aum_band]) throw new HttpError(400, "Choose your assets under management");
  const d = await getDb(env);
  const now = Date.now();
  const recent = await d.prepare("SELECT COUNT(*) AS n FROM requests WHERE created_at > ?").bind(now - 3600000).first();
  if (recent.n > 50) throw new HttpError(429, "Too many requests right now. Please try again later.");
  // Same answer whether or not the email is already known, so the form can't be used to check who's a member.
  const known = await d.prepare(
    "SELECT 1 FROM requests WHERE email = ? AND status = 'pending' UNION SELECT 1 FROM members WHERE email = ?"
  ).bind(email, email).first();
  if (!known) {
    // A member's "bring a peer" link adds their code. Unknown or revoked codes are ignored, and the
    // response is the same either way.
    const code = clip(b.ref, 20);
    const ref = code ? await d.prepare("SELECT id FROM members WHERE ref_code = ? AND status = 'active'").bind(code).first() : null;
    await d.prepare(
      `INSERT INTO requests (name, email, firm, title, org_type, aum_band, note, referred_by, ref_member_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(name, email, firm, clip(b.title, 120), b.org_type, b.aum_band, clip(b.note, 400), clip(b.referred_by, 120), ref ? ref.id : null, now).run();
  }
  return json({ ok: true });
});
