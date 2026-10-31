// POST /api/pulse/submit  { answers }
// Saves the member's answers for the open round. Checking in again in the same round replaces them.
import { json } from "../../_shared.js";
import { handle, requireMember, currentRound, cleanAnswers, HttpError } from "../../_pulse.js";

export const onRequestPost = handle(async ({ request, env }) => {
  const { d, m } = await requireMember(env, request);
  let b;
  try { b = await request.json(); } catch { throw new HttpError(400, "Request body must be JSON"); }
  const answers = cleanAnswers(b.answers);
  const now = Date.now();
  const round = await currentRound(d, now);
  if (!round.open) throw new HttpError(409, "This round has closed. The next one opens on Monday.");
  await d.batch([
    d.prepare(
      `INSERT INTO responses (round_id, member_id, org_type, aum_band, answers, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (round_id, member_id) DO UPDATE SET
         answers = excluded.answers, org_type = excluded.org_type, aum_band = excluded.aum_band, updated_at = excluded.updated_at`
    ).bind(round.id, m.id, m.org_type, m.aum_band, JSON.stringify(answers), now, now),
    d.prepare("UPDATE members SET last_seen = ? WHERE id = ?").bind(now, m.id),
  ]);
  return json({ ok: true, round: round.id });
});
