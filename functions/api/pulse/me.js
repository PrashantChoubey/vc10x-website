// GET /api/pulse/me
// The member's current round, whether they've checked in, and their latest answers to prefill the form.
import { json } from "../../_shared.js";
import { handle, requireMember, currentRound, roundMeta, accessSince, refCode, typeCounts, CONFIG } from "../../_pulse.js";

export const onRequestGet = handle(async ({ request, env }) => {
  const { d, m } = await requireMember(env, request);
  const now = Date.now();
  const round = await currentRound(d, now);
  const count = await d.prepare("SELECT COUNT(*) AS n FROM responses WHERE round_id = ?").bind(round.id).first();
  const mine = (await d.prepare(
    "SELECT x.round_id, x.answers, r.opens_at FROM responses x JOIN rounds r ON r.id = x.round_id WHERE x.member_id = ? ORDER BY r.opens_at DESC LIMIT 20"
  ).bind(m.id).all()).results;
  const here = mine.find((x) => x.round_id === round.id);
  const latest = here || mine[0]; // prefill: this round's answers if any, else the most recent
  const canSeeResults = mine.some((x) => x.opens_at >= accessSince(now));
  await d.prepare("UPDATE members SET last_seen = ? WHERE id = ?").bind(now, m.id).run();
  const [ref, byType] = await Promise.all([refCode(d, m), typeCounts(d, round.id)]);
  return json({
    member: { first: m.name.split(" ")[0], firm: m.firm, org_type: m.org_type, aum_band: m.aum_band },
    round: { ...roundMeta(round, now), open: round.open, n: count.n, byType },
    ref,
    submitted: !!here,
    answers: latest ? JSON.parse(latest.answers) : null,
    answersFrom: latest?.round_id ?? null,
    canSeeResults,
    config: CONFIG,
  }, 200, { "Cache-Control": "no-store" });
});
