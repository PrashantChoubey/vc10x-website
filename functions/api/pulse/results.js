// GET /api/pulse/results
// Peer results for members who checked in this week or last week ("give to get").
// Only groups of at least MIN_N answers are returned, and never anyone's individual answers.
import { json } from "../../_shared.js";
import { handle, requireMember, currentRound, roundMeta, aggregate, parseRow, accessSince, MIN_N, HttpError } from "../../_pulse.js";

const HISTORY = 26;

export const onRequestGet = handle(async ({ request, env }) => {
  const { d, m } = await requireMember(env, request);
  const now = Date.now();
  const cur = await currentRound(d, now);
  const rounds = (await d.prepare(
    `SELECT r.*, (SELECT COUNT(*) FROM responses x WHERE x.round_id = r.id) AS n
     FROM rounds r WHERE r.opens_at <= ? ORDER BY r.opens_at DESC LIMIT ?`
  ).bind(now, HISTORY + 1).all()).results;

  const i = rounds.findIndex((r) => r.id === cur.id);
  const mine = (await d.prepare(
    "SELECT x.round_id, x.answers, r.opens_at FROM responses x JOIN rounds r ON r.id = x.round_id WHERE x.member_id = ? ORDER BY r.opens_at DESC"
  ).bind(m.id).all()).results;
  if (!mine.some((x) => x.opens_at >= accessSince(now))) {
    throw new HttpError(403, "Check in to this round to see the results.");
  }

  // Featured: the newest round with enough answers (this one once it reaches MIN_N), compared with the one before it.
  const shown = rounds.filter((r) => r.n >= MIN_N);
  const featured = shown[0], compare = shown[1];
  const base = { round: { ...roundMeta(cur, now), open: cur.open, n: rounds[i]?.n ?? 0 }, minN: MIN_N };
  if (!featured) return json({ ...base, featured: null }, 200, { "Cache-Control": "no-store" });

  const ids = shown.slice(0, HISTORY).map((r) => r.id);
  const rows = (await d.prepare(
    `SELECT round_id, org_type, aum_band, answers FROM responses WHERE round_id IN (${ids.map(() => "?").join(",")})`
  ).bind(...ids).all()).results.map(parseRow);
  const byRound = (id) => rows.filter((r) => r.round_id === id);

  const history = shown.slice(0, HISTORY).reverse().map((r) => {
    const a = aggregate(byRound(r.id), { segments: false });
    return { ...roundMeta(r, now), risk: a.risk.avg, riskNet: a.risk.chg.net ?? null,
      pos: Object.fromEntries(Object.entries(a.pos).map(([k, v]) => [k, v.hidden ? null : v.net])) };
  });
  const you = mine.find((x) => x.round_id === featured.id) || mine[0];

  return json({
    ...base,
    featured: { ...roundMeta(featured, now), agg: aggregate(byRound(featured.id)) },
    compare: compare ? { ...roundMeta(compare, now), agg: aggregate(byRound(compare.id), { segments: false }) } : null,
    history,
    you: you ? { round_id: you.round_id, answers: JSON.parse(you.answers) } : null,
  }, 200, { "Cache-Control": "no-store" });
});
