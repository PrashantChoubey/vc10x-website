// POST /api/pulse/admin  { action, ... }   Authorization: Bearer <PULSE_ADMIN_KEY>
// Used by /cio-pulse/admin/. Invites, members, rounds, and the aggregate results for the weekly email.
import { json } from "../../_shared.js";
import {
  handle, requireAdmin, currentRound, roundMeta, newToken, sha256, aggregate, parseRow,
  HttpError, EMAIL, clip, ORG_TYPES, AUM, CONFIG,
} from "../../_pulse.js";

const link = (origin, token) => `${origin}/cio-pulse/#k=${token}`;
const need = (v, msg) => { if (!v) throw new HttpError(400, msg); return v; };
const idOf = (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 1) throw new HttpError(400, "Bad id"); return n; };

const ACTIONS = {
  async overview(d, b, now) {
    const round = await currentRound(d, now);
    const [rounds, members, requests] = await Promise.all([
      d.prepare(`SELECT r.*, (SELECT COUNT(*) FROM responses x WHERE x.round_id = r.id) AS n
                 FROM rounds r ORDER BY r.opens_at DESC LIMIT 30`).all(),
      d.prepare(`SELECT m.id, m.name, m.email, m.firm, m.title, m.org_type, m.aum_band, m.status, m.created_at, m.last_seen,
                   (SELECT COUNT(*) FROM responses x WHERE x.member_id = m.id) AS answered,
                   EXISTS (SELECT 1 FROM responses x WHERE x.member_id = m.id AND x.round_id = ?) AS this_round,
                   (SELECT COUNT(*) FROM requests q WHERE q.ref_member_id = m.id) AS referrals,
                   (SELECT COUNT(*) FROM requests q WHERE q.ref_member_id = m.id AND q.status = 'approved') AS referrals_joined
                 FROM members m ORDER BY m.created_at DESC`).bind(round.id).all(),
      d.prepare(`SELECT q.*, m.name AS ref_member_name, m.firm AS ref_member_firm FROM requests q
                 LEFT JOIN members m ON m.id = q.ref_member_id
                 WHERE q.status = 'pending' ORDER BY q.created_at DESC`).all(),
    ]);
    return { round: roundMeta(round, now), rounds: rounds.results.map((r) => roundMeta(r, now)),
      members: members.results, requests: requests.results, config: CONFIG };
  },

  // Create a member (optionally from a pending request) and return their private link, shown once.
  async invite(d, b, now, origin) {
    const name = need(clip(b.name, 80), "Add a name");
    const email = clip(b.email, 120).toLowerCase();
    if (!EMAIL.test(email)) throw new HttpError(400, "Add a valid email");
    const firm = need(clip(b.firm, 120), "Add an organization");
    if (!ORG_TYPES[b.org_type]) throw new HttpError(400, "Choose an organization type");
    if (!AUM[b.aum_band]) throw new HttpError(400, "Choose an AUM band");
    if (await d.prepare("SELECT 1 FROM members WHERE email = ?").bind(email).first()) {
      throw new HttpError(409, "There's already a member with that email. Use Reissue link instead.");
    }
    const token = newToken();
    const stmts = [d.prepare(
      "INSERT INTO members (token_hash, name, email, firm, title, org_type, aum_band, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(await sha256(token), name, email, firm, clip(b.title, 120), b.org_type, b.aum_band, now)];
    if (b.request_id) stmts.push(d.prepare("UPDATE requests SET status = 'approved' WHERE id = ?").bind(idOf(b.request_id)));
    await d.batch(stmts);
    return { link: link(origin, token), name };
  },

  // New link for a member who lost theirs. The old link stops working.
  async reissue(d, b, now, origin) {
    const m = await d.prepare("SELECT id, name FROM members WHERE id = ?").bind(idOf(b.member_id)).first();
    need(m, "No such member");
    const token = newToken();
    await d.prepare("UPDATE members SET token_hash = ?, status = 'active' WHERE id = ?").bind(await sha256(token), m.id).run();
    return { link: link(origin, token), name: m.name };
  },

  async set_status(d, b) {
    if (!["active", "revoked"].includes(b.status)) throw new HttpError(400, "Bad status");
    await d.prepare("UPDATE members SET status = ? WHERE id = ?").bind(b.status, idOf(b.member_id)).run();
    return { ok: true };
  },

  async decline(d, b) {
    await d.prepare("UPDATE requests SET status = 'declined' WHERE id = ?").bind(idOf(b.request_id)).run();
    return { ok: true };
  },

  // Event round after a market-moving event. It runs alongside the week and takes over while open.
  async open_event(d, b, now) {
    const label = need(clip(b.label, 80), "Add a label, for example \"Fed decision, 4 Nov\"");
    const days = Number(b.days);
    if (!Number.isInteger(days) || days < 1 || days > 7) throw new HttpError(400, "Days must be 1 to 7");
    const open = await d.prepare("SELECT 1 FROM rounds WHERE kind = 'event' AND opens_at <= ? AND closes_at > ?").bind(now, now).first();
    if (open) throw new HttpError(409, "An event round is already open. Close it first.");
    const id = `E-${new Date(now).toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 6)}`;
    await d.prepare("INSERT INTO rounds (id, kind, label, opens_at, closes_at) VALUES (?, 'event', ?, ?, ?)")
      .bind(id, label, now, now + days * 86400000).run();
    return { id };
  },

  async close_round(d, b, now) {
    const r = await d.prepare("SELECT * FROM rounds WHERE id = ?").bind(clip(b.round_id, 40)).first();
    need(r, "No such round");
    if (r.closes_at <= now) throw new HttpError(409, "That round is already closed");
    await d.prepare("UPDATE rounds SET closes_at = ? WHERE id = ?").bind(now, r.id).run();
    return { ok: true };
  },

  // Aggregate results and the anonymous notes for one round, for writing the weekly summary.
  // The same group-size threshold applies here as on the members' page.
  async round(d, b) {
    const r = await d.prepare("SELECT * FROM rounds WHERE id = ?").bind(clip(b.round_id, 40)).first();
    need(r, "No such round");
    const rows = (await d.prepare("SELECT round_id, org_type, aum_band, answers FROM responses WHERE round_id = ?")
      .bind(r.id).all()).results.map(parseRow);
    const notes = rows.map((x) => ({ org_type: x.org_type, note: x.a.note })).filter((x) => x.note);
    return { round: roundMeta(r), agg: aggregate(rows), notes: rows.length >= CONFIG.MIN_N ? notes : [] };
  },
};

export const onRequestPost = handle(async ({ request, env }) => {
  const d = await requireAdmin(env, request);
  let b;
  try { b = await request.json(); } catch { throw new HttpError(400, "Request body must be JSON"); }
  const fn = ACTIONS[b.action];
  if (!fn) throw new HttpError(400, "Unknown action");
  // Links point at whichever site the admin is using (vc10x.com, or a preview while testing).
  return json(await fn(d, b, Date.now(), new URL(request.url).origin), 200, { "Cache-Control": "no-store" });
});
