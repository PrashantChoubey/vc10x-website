// Shared logic for the CIO Pulse (/cio-pulse/ and /api/pulse/*).
// Needs, in Cloudflare Pages > Settings > Bindings and Variables and Secrets:
//   PULSE_DB         a D1 database binding (tables are created on first use)
//   PULSE_ADMIN_KEY  (as a Secret) any long random string, used on /cio-pulse/admin/
import { json } from "./_shared.js";

// No result is shown for any group smaller than this, so no single CIO's answers can be read back.
export const MIN_N = 8;

export const ORG_TYPES = {
  family: "Family office",
  endowment: "Endowment or foundation",
  pension: "Pension or insurance",
  institution: "OCIO, fund of funds or other institution",
};
export const AUM = { s: "Under $1B", m: "$1B to $10B", l: "Over $10B" };
export const CLASSES = [
  ["us_eq", "US equities"],
  ["intl_eq", "Non-US equities"],
  ["bonds", "Investment-grade bonds"],
  ["cash", "Cash"],
  ["gold", "Gold and commodities"],
  ["pe", "Private equity"],
  ["vc", "Venture capital"],
  ["pc", "Private credit"],
  ["real", "Real estate and infrastructure"],
  ["hf", "Hedge funds"],
];
export const DRIVERS = [
  ["rates", "Interest rates and central banks"],
  ["inflation", "Inflation"],
  ["geo", "Geopolitics and conflict"],
  ["growth", "Growth and recession risk"],
  ["policy", "Elections, tariffs and policy"],
  ["valuations", "Equity valuations"],
  ["ai", "AI and tech concentration"],
  ["liquidity", "Private market liquidity"],
  ["credit", "Credit stress"],
  ["dollar", "Currencies and the dollar"],
];
export const CONFIG = { MIN_N, ORG_TYPES, AUM, CLASSES, DRIVERS };

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new HttpError(400, m);

// Wraps a handler so thrown HttpErrors become JSON responses.
export const handle = (fn) => async (ctx) => {
  try { return await fn(ctx); }
  catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error("pulse", e);
    return json({ error: "Something went wrong" }, 500);
  }
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL,
    firm TEXT NOT NULL, title TEXT, org_type TEXT NOT NULL, aum_band TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, last_seen INTEGER, ref_code TEXT)`,
  `CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, firm TEXT NOT NULL, title TEXT,
    org_type TEXT, aum_band TEXT, note TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL,
    referred_by TEXT, ref_member_id INTEGER)`,
  `CREATE TABLE IF NOT EXISTS rounds (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL, opens_at INTEGER NOT NULL, closes_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS responses (
    round_id TEXT NOT NULL, member_id INTEGER NOT NULL, org_type TEXT NOT NULL, aum_band TEXT NOT NULL,
    answers TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (round_id, member_id))`,
  `CREATE INDEX IF NOT EXISTS responses_member ON responses (member_id)`,
  `CREATE INDEX IF NOT EXISTS rounds_opens ON rounds (opens_at)`,
];
// Columns added after launch. Each runs on its own, since a batch would roll back on the first
// "duplicate column" error from a database that already has them.
const MIGRATIONS = [
  "ALTER TABLE members ADD COLUMN ref_code TEXT",
  "ALTER TABLE requests ADD COLUMN referred_by TEXT",
  "ALTER TABLE requests ADD COLUMN ref_member_id INTEGER",
];
let ready = false;
export async function getDb(env) {
  const d = env.PULSE_DB;
  if (!d) { console.error("Missing PULSE_DB binding"); throw new HttpError(500, "Server not configured"); }
  if (!ready) {
    await d.batch(SCHEMA.map((s) => d.prepare(s)));
    for (const m of MIGRATIONS) {
      try { await d.prepare(m).run(); } catch (e) { if (!/duplicate column/i.test(String(e.message))) throw e; }
    }
    await d.prepare("CREATE UNIQUE INDEX IF NOT EXISTS members_ref ON members (ref_code)").run();
    ready = true;
  }
  return d;
}

// ---------- Tokens ----------
export function newToken() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export async function sha256(s) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
// Short code for a member's "bring a peer" link. It identifies the referrer to the admin only;
// the public page never resolves it to a name, so it can't be used to look up who's a member.
export const newRefCode = () => newToken().slice(0, 10);
export async function refCode(d, m) {
  if (m.ref_code) return m.ref_code;
  const code = newRefCode();
  await d.prepare("UPDATE members SET ref_code = ? WHERE id = ? AND ref_code IS NULL").bind(code, m.id).run();
  return (await d.prepare("SELECT ref_code FROM members WHERE id = ?").bind(m.id).first()).ref_code;
}

const bearer = (req) => (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();

// The signed-in member, from the private link's token. Only a hash of the token is stored.
export async function requireMember(env, req) {
  const t = bearer(req);
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(t)) throw new HttpError(401, "This link isn't valid. Ask for a new one.");
  const d = await getDb(env);
  const m = await d.prepare("SELECT * FROM members WHERE token_hash = ?").bind(await sha256(t)).first();
  if (!m || m.status !== "active") throw new HttpError(401, "This link isn't valid. Ask for a new one.");
  return { d, m };
}

export async function requireAdmin(env, req) {
  const key = env.PULSE_ADMIN_KEY || "";
  if (key.length < 16) throw new HttpError(500, "PULSE_ADMIN_KEY is not set, or shorter than 16 characters");
  if ((await sha256(bearer(req))) !== (await sha256(key))) throw new HttpError(401, "Wrong admin key");
  return getDb(env);
}

// ---------- Rounds ----------
// A weekly round runs Monday 00:00 to Monday 00:00 UTC. An event round, opened by the admin
// after a market-moving event, takes over while it's open.
const DAY = 86400000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const dayLabel = (ms) => { const d = new Date(ms); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };

export function isoWeek(ms) {
  const d = new Date(ms);
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - ((d.getUTCDay() + 6) % 7) * DAY;
  const year = new Date(monday + 3 * DAY).getUTCFullYear(); // the ISO year is the year of the week's Thursday
  const jan4 = Date.UTC(year, 0, 4);
  const week1 = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY;
  const n = 1 + Math.round((monday - week1) / (7 * DAY));
  return { id: `${year}-W${String(n).padStart(2, "0")}`, opens: monday, closes: monday + 7 * DAY };
}

export async function currentRound(d, now = Date.now()) {
  const ev = await d.prepare(
    "SELECT * FROM rounds WHERE kind = 'event' AND opens_at <= ? AND closes_at > ? ORDER BY opens_at DESC LIMIT 1"
  ).bind(now, now).first();
  if (ev) return { ...ev, open: true };
  const w = isoWeek(now);
  await d.prepare("INSERT OR IGNORE INTO rounds (id, kind, label, opens_at, closes_at) VALUES (?, 'weekly', ?, ?, ?)")
    .bind(w.id, `Week of ${dayLabel(w.opens)}`, w.opens, w.closes).run();
  const r = await d.prepare("SELECT * FROM rounds WHERE id = ?").bind(w.id).first();
  return { ...r, open: r.closes_at > now }; // closed early by the admin: no round open until next Monday
}

// Give to get: results are open to members with a check-in (weekly or event) since the start of last week.
export const accessSince = (now) => isoWeek(now).opens - 7 * DAY;

export const roundMeta = (r, now = Date.now()) => r && ({
  id: r.id, kind: r.kind, label: r.label, opens_at: r.opens_at, closes_at: r.closes_at,
  open: r.opens_at <= now && r.closes_at > now, n: r.n ?? undefined,
});

// ---------- Answers ----------
const tri = (v) => v === -1 || v === 0 || v === 1;
const CLASS_IDS = new Set(CLASSES.map((c) => c[0]));
const DRIVER_IDS = new Set(DRIVERS.map((c) => c[0]));

export function cleanAnswers(a) {
  if (!a || typeof a !== "object") throw bad("Missing answers");
  const pos = {}, next = {};
  for (const [id, label] of CLASSES) {
    const p = a.pos?.[id];
    if (p === null) { pos[id] = null; next[id] = null; continue; } // doesn't hold this asset class
    if (!tri(p)) throw bad(`Add your positioning in ${label}`);
    const n = a.next?.[id];
    if (!tri(n)) throw bad(`Add your next-three-months view on ${label}`);
    pos[id] = p; next[id] = n;
  }
  if (CLASSES.every(([id]) => pos[id] === null)) throw bad("Mark at least one asset class you hold");
  if (!Number.isInteger(a.risk) || a.risk < 1 || a.risk > 5) throw bad("Add your overall risk appetite");
  if (!tri(a.riskChg)) throw bad("Add how your risk has changed over the past month");
  const drivers = Array.isArray(a.drivers) ? [...new Set(a.drivers)] : [];
  if (!drivers.length || drivers.length > 2 || !drivers.every((x) => DRIVER_IDS.has(x))) throw bad("Pick one or two macro drivers");
  if (!(a.pacing === null || tri(a.pacing))) throw bad("Add your private-markets pacing");
  const note = typeof a.note === "string" ? a.note.trim().slice(0, 280) : "";
  return { pos, next, risk: a.risk, riskChg: a.riskChg, drivers, pacing: a.pacing, note };
}

// ---------- Aggregation ----------
// rows: [{ org_type, aum_band, a }] for one round. Every figure covers at least MIN_N answers;
// smaller groups come back as { count, hidden: true } with no breakdown.
const pct = (x, c) => Math.round((x / c) * 100);
function tally(rows, get) {
  let up = 0, mid = 0, down = 0;
  for (const r of rows) { const v = get(r.a); if (v === 1) up++; else if (v === 0) mid++; else if (v === -1) down++; }
  const count = up + mid + down;
  if (count < MIN_N) return { count, hidden: true };
  return { count, up: pct(up, count), mid: pct(mid, count), down: pct(down, count), net: Math.round(((up - down) / count) * 100) };
}
const avg = (xs) => Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10;

export function aggregate(rows, { segments = true } = {}) {
  const n = rows.length;
  if (n < MIN_N) return { n, locked: true };
  const pos = {}, next = {};
  for (const [id] of CLASSES) { pos[id] = tally(rows, (a) => a.pos[id]); next[id] = tally(rows, (a) => a.next[id]); }
  const dist = [1, 2, 3, 4, 5].map((k) => pct(rows.filter((r) => r.a.risk === k).length, n));
  const drivers = DRIVERS.map(([id]) => ({ id, pct: pct(rows.filter((r) => r.a.drivers.includes(id)).length, n) }))
    .sort((x, y) => y.pct - x.pct);
  const out = {
    n, pos, next,
    risk: { avg: avg(rows.map((r) => r.a.risk)), dist, chg: tally(rows, (a) => a.riskChg) },
    drivers,
    pacing: tally(rows, (a) => a.pacing),
  };
  if (segments) {
    const seg = (key, labels) => {
      const groups = Object.keys(labels).map((k) => ({ id: k, rows: rows.filter((r) => r[key] === k) }));
      // Complementary suppression: the total minus the groups shown must not leave a hidden
      // remainder of 1 to MIN_N - 1 people, or their average could be worked out by subtraction.
      const shown = new Set(groups.filter((g) => g.rows.length >= MIN_N).map((g) => g.id));
      for (;;) {
        const rest = groups.filter((g) => !shown.has(g.id)).reduce((t, g) => t + g.rows.length, 0);
        if (rest === 0 || rest >= MIN_N || !shown.size) break;
        const smallest = groups.filter((g) => shown.has(g.id)).sort((a, b) => a.rows.length - b.rows.length)[0];
        shown.delete(smallest.id);
      }
      return groups.map(({ id: k, rows: g }) => {
        if (!shown.has(k)) return { id: k, hidden: true, small: g.length < MIN_N };
        const s = aggregate(g, { segments: false });
        return { id: k, n: g.length, risk: s.risk.avg, riskNet: s.risk.chg.net ?? null,
          pos: Object.fromEntries(CLASSES.map(([id]) => [id, s.pos[id].hidden ? null : s.pos[id].net])) };
      });
    };
    out.byType = seg("org_type", ORG_TYPES);
    out.bySize = seg("aum_band", AUM);
  }
  return out;
}

// Check-ins per organization type for one round, so members can see which groups are close to
// unlocking. Counts only, never answers.
export async function typeCounts(d, roundId) {
  const rows = (await d.prepare("SELECT org_type, COUNT(*) AS n FROM responses WHERE round_id = ? GROUP BY org_type")
    .bind(roundId).all()).results;
  return Object.fromEntries(Object.keys(ORG_TYPES).map((k) => [k, rows.find((r) => r.org_type === k)?.n ?? 0]));
}

export const parseRow = (r) => ({ round_id: r.round_id, org_type: r.org_type, aum_band: r.aum_band, a: JSON.parse(r.answers) });

export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const clip = (v, n = 120) => (typeof v === "string" ? v.trim().slice(0, n) : "");
