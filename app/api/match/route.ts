import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

type Mode = "ranked" | "zwanglos";
type Winner = "imposter" | "unschuldig";
type WinMethod =
  | "guessed_word"
  | "voted_out_innocent"
  | "voted_out_imposter"
  | "wrong_guess"
  | "timeout"
  | "other";

type ViolationType = "afk" | "unangemessen" | "left_voice";

type PlayerIn = {
  discord_id: string;
  display_name?: string | null;
  elo_before?: number | null; // empfohlen für ranked
};

type RoundIn = {
  round_no: number; // 1..5
  category_slug?: string | null;
  category_name?: string | null;
  word?: string | null;
  imposter_discord_id: string;
  winner: Winner;
  win_method: WinMethod;
  aborted?: boolean;
  aborted_reason?: string | null;
};

type ViolationIn = {
  type: ViolationType;
  discord_id: string; // Täter
  round_no?: number | null;
};

type Payload = {
  guild_id: string;
  mode: Mode;
  started_at?: string | null;
  ended_at?: string | null;

  players: PlayerIn[]; // 4
  rounds: RoundIn[]; // 5

  violation?: ViolationIn | null;
};

function j(data: any, status = 200) {
  return NextResponse.json(data, { status });
}
function nowIso() {
  return new Date().toISOString();
}

// Elo-Floor
const ELO_FLOOR = 300;

// Placement
const PLACEMENT_GAMES = 6; // erste 6 ranked games
const PLACEMENT_MULT = 3;

// Qualifikation
const CASUAL_REQUIRED_FOR_RANKED = 5;

// Lobby diff multiplier (cap)
function clampPct(absDiff: number) {
  if (absDiff >= 300) return 0.6;
  if (absDiff >= 200) return 0.4;
  if (absDiff >= 100) return 0.2;
  return 0;
}

/**
 * Lobby multiplier (float):
 * diff = playerElo - avgOthers
 * diff > 0: weniger Gewinn, mehr Verlust
 * diff < 0: mehr Gewinn, weniger Verlust
 */
function applyLobbyMultiplierFloat(baseDelta: number, playerElo: number, avgOthers: number) {
  if (baseDelta === 0) return 0;

  const diff = playerElo - avgOthers;
  const pct = clampPct(Math.abs(diff));
  if (pct === 0) return baseDelta;

  let scaled = baseDelta;
  if (diff > 0) {
    if (baseDelta > 0) scaled = baseDelta * (1 - pct);
    else scaled = baseDelta * (1 + pct);
  } else if (diff < 0) {
    if (baseDelta > 0) scaled = baseDelta * (1 + pct);
    else scaled = baseDelta * (1 - pct);
  }
  return scaled;
}

/**
 * Tie average as float (no early rounding)
 * Base deltas (zero-sum):
 * 1:+30, 2:+10, 3:-10, 4:-30
 */
function computeBaseDeltasByTiesFloat(sortedByPoints: { discord_id: string; points: number }[]) {
  const baseByPlace = [30, 10, -10, -30];
  const result = new Map<string, number>();

  let i = 0;
  while (i < sortedByPoints.length) {
    const pts = sortedByPoints[i].points;

    let j = i;
    while (j + 1 < sortedByPoints.length && sortedByPoints[j + 1].points === pts) j++;

    let sum = 0;
    for (let k = i; k <= j; k++) sum += baseByPlace[k] ?? 0;
    const avg = sum / (j - i + 1);

    for (let k = i; k <= j; k++) result.set(sortedByPoints[k].discord_id, avg);
    i = j + 1;
  }
  return result;
}

/**
 * zero-sum normalize + round (ensures sum == 0 exactly)
 * ONLY used when NO placement players are in the match.
 */
function normalizeZeroSumAndRound(deltasFloat: Record<string, number>) {
  const ids = Object.keys(deltasFloat);
  const n = ids.length;

  const sum = ids.reduce((acc, id) => acc + deltasFloat[id], 0);
  const mean = sum / n;

  const zeroFloats: Record<string, number> = {};
  for (const id of ids) zeroFloats[id] = deltasFloat[id] - mean;

  const rounded: Record<string, number> = {};
  const frac: { id: string; frac: number }[] = [];

  let roundedSum = 0;
  for (const id of ids) {
    const r = Math.round(zeroFloats[id]);
    rounded[id] = r;
    roundedSum += r;
    frac.push({ id, frac: zeroFloats[id] - r });
  }

  let residual = -roundedSum;
  if (residual !== 0) {
    frac.sort((a, b) => (residual > 0 ? b.frac - a.frac : a.frac - b.frac));
    let i = 0;
    while (residual !== 0 && i < frac.length * 3) {
      const pick = frac[i % frac.length].id;
      rounded[pick] += residual > 0 ? 1 : -1;
      residual += residual > 0 ? -1 : 1;
      i++;
    }
  }
  return rounded;
}

function banMinutesForViolationCount(count: number) {
  if (count === 1) return 30;
  if (count === 2) return 60;
  if (count === 3) return 120;
  if (count === 4) return 360;
  if (count === 5) return 720;
  return 24 * 60;
}
function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60_000);
}

/** category get/create */
async function getOrCreateCategoryId(slugOrName?: string | null, name?: string | null) {
  const raw = (slugOrName ?? name ?? "").trim();
  if (!raw) return null;

  const slug = raw
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\-]/g, "");

  if (!slug) return null;

  const { data: found, error: findErr } = await supabaseAdmin
    .from("categories")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  if (findErr) throw findErr;
  if (found?.id) return found.id as number;

  const { data: created, error: createErr } = await supabaseAdmin
    .from("categories")
    .insert([{ slug, name: (name ?? slugOrName ?? slug).trim() || slug }])
    .select("id")
    .single();
  if (createErr) throw createErr;

  return created.id as number;
}

export async function POST(req: Request) {
  try {
    // --- Secret Auth ---
    const token = req.headers.get("x-bot-token");
    if (!token || token !== process.env.BOT_INGEST_TOKEN) {
      return j({ ok: false, error: "unauthorized" }, 401);
    }

    const body = (await req.json()) as Payload;

    if (!body?.guild_id || !body?.mode || !Array.isArray(body.players) || !Array.isArray(body.rounds)) {
      return j({ ok: false, error: "missing fields" }, 400);
    }

    const mode: Mode = body.mode;
    if (mode !== "ranked" && mode !== "zwanglos") {
      return j({ ok: false, error: "mode must be ranked|zwanglos" }, 400);
    }
    if (body.players.length !== 4) return j({ ok: false, error: "expected 4 players" }, 400);
    if (body.rounds.length !== 5) return j({ ok: false, error: "expected 5 rounds" }, 400);

    const guild_id = String(body.guild_id);

    // --- Players upsert (name) ---
    const upsertPlayers = body.players.map((p) => ({
      discord_id: String(p.discord_id),
      last_name: p.display_name ?? null,
      updated_at: nowIso(),
    }));
    const { error: upsertErr } = await supabaseAdmin.from("players").upsert(upsertPlayers, { onConflict: "discord_id" });
    if (upsertErr) throw upsertErr;

    // --- Read current player stats (needed for: casual gate, placement flag, elo floor) ---
    const ids = body.players.map((p) => String(p.discord_id));

    const { data: playerRows, error: prErr } = await supabaseAdmin
      .from("players")
      .select("discord_id, elo_ranked, games_casual, games_ranked, ranked_games_played, violations_count, banned_until")
      .in("discord_id", ids);
    if (prErr) throw prErr;

    const byId: Record<string, any> = {};
    for (const r of playerRows ?? []) byId[String(r.discord_id)] = r;

    // --- Ranked qualification gate: must have 5 casual games ---
    if (mode === "ranked") {
      for (const id of ids) {
        const gamesCasual = Number(byId[id]?.games_casual ?? 0);
        if (gamesCasual < CASUAL_REQUIRED_FOR_RANKED) {
          return j(
            {
              ok: false,
              error: `player_not_qualified_for_ranked:${id}`,
              required_casual: CASUAL_REQUIRED_FOR_RANKED,
              current_casual: gamesCasual,
            },
            400
          );
        }
      }
    }

    // --- Match erstellen ---
    const { data: match, error: matchErr } = await supabaseAdmin
      .from("matches")
      .insert([
        {
          guild_id,
          mode,
          started_at: body.started_at ? new Date(body.started_at).toISOString() : nowIso(),
          ended_at: body.ended_at ? new Date(body.ended_at).toISOString() : null,
          aborted_reason: body.violation ? `violation:${body.violation.type}` : null,
        },
      ])
      .select("id")
      .single();
    if (matchErr) throw matchErr;
    const match_id = match.id as number;

    // --- Runden speichern ---
    const roundInsert: any[] = [];
    for (const r of body.rounds) {
      const category_id = await getOrCreateCategoryId(r.category_slug ?? null, r.category_name ?? null);

      roundInsert.push({
        match_id,
        round_no: r.round_no,
        category_id,
        word: r.word ?? null,
        imposter_discord_id: String(r.imposter_discord_id),
        winner: r.winner,
        win_method: r.win_method,
        aborted: Boolean(r.aborted),
        aborted_reason: r.aborted_reason ?? null,
      });
    }

    const { data: insertedRounds, error: roundErr } = await supabaseAdmin
      .from("match_rounds")
      .insert(roundInsert)
      .select("id, round_no, imposter_discord_id, winner, aborted");
    if (roundErr) throw roundErr;

    // --- Punkte berechnen + round_player_points ---
    const points: Record<string, number> = {};
    for (const id of ids) points[id] = 0;

    const rppRows: { round_id: number; discord_id: string; points: number }[] = [];
    const roundWinsImposter: Record<string, number> = {};
    const roundWinsUnschuldig: Record<string, number> = {};

    for (const ir of insertedRounds ?? []) {
      const round_id = ir.id as number;
      const imp = String(ir.imposter_discord_id);

      if (ir.aborted) continue;

      if (ir.winner === "imposter") {
        points[imp] += 2;
        roundWinsImposter[imp] = (roundWinsImposter[imp] ?? 0) + 1;

        for (const id of ids) {
          rppRows.push({ round_id, discord_id: id, points: id === imp ? 2 : 0 });
        }
      } else {
        for (const id of ids) {
          if (id === imp) {
            rppRows.push({ round_id, discord_id: id, points: 0 });
          } else {
            points[id] += 1;
            roundWinsUnschuldig[id] = (roundWinsUnschuldig[id] ?? 0) + 1;
            rppRows.push({ round_id, discord_id: id, points: 1 });
          }
        }
      }
    }

    const { error: rppErr } = await supabaseAdmin.from("round_player_points").insert(rppRows);
    if (rppErr) throw rppErr;

    // --- Regelverstoß (Abbruch + Bann + Ranked: Täter -30, Rest 0) ---
    if (body.violation) {
      const viol = body.violation;
      const violator = String(viol.discord_id);

      let viol_round_id: number | null = null;
      if (viol.round_no) {
        const found = (insertedRounds ?? []).find((r: any) => r.round_no === viol.round_no);
        viol_round_id = found?.id ?? null;
      }

      const { error: vioErr } = await supabaseAdmin.from("player_violations").insert([
        {
          guild_id,
          discord_id: violator,
          violation_type: viol.type,
          source: "system",
          match_id,
          round_id: viol_round_id,
        },
      ]);
      if (vioErr) throw vioErr;

      const oldCount = Number(byId[violator]?.violations_count ?? 0);
      const newCount = oldCount + 1;

      const minutes = banMinutesForViolationCount(newCount);
      const now = new Date();
      const newBanUntil = addMinutes(now, minutes);

      const currentBan = byId[violator]?.banned_until ? new Date(byId[violator].banned_until) : null;
      const finalBan = currentBan && currentBan > newBanUntil ? currentBan : newBanUntil;

      const { error: updV } = await supabaseAdmin
        .from("players")
        .update({
          violations_count: newCount,
          banned_until: finalBan.toISOString(),
          last_violation_at: nowIso(),
        })
        .eq("discord_id", violator);
      if (updV) throw updV;

      await supabaseAdmin.from("matches").update({ aborted_reason: `violation:${viol.type}` }).eq("id", match_id);

      if (mode === "ranked") {
        // abort results
        const resultsAbort = ids.map((id) => ({
          match_id,
          discord_id: id,
          total_points: points[id] ?? 0,
          placement: 0,
          elo_delta: id === violator ? -30 : 0,
        }));
        const { error: mrErr } = await supabaseAdmin.from("match_results").insert(resultsAbort);
        if (mrErr) throw mrErr;

        // Täter elo -30 (mit floor)
        const currentElo = Number(byId[violator]?.elo_ranked ?? 1000);
        const newElo = Math.max(ELO_FLOOR, currentElo - 30);

        const { error: eloUpdErr } = await supabaseAdmin
          .from("players")
          .update({ elo_ranked: newElo, updated_at: nowIso() })
          .eq("discord_id", violator);
        if (eloUpdErr) throw eloUpdErr;

        return j({ ok: true, match_id, aborted: true });
      }

      // zwanglos abort -> elo_delta 0
      const resultsAbort = ids.map((id) => ({
        match_id,
        discord_id: id,
        total_points: points[id] ?? 0,
        placement: 0,
        elo_delta: 0,
      }));
      const { error: mrErr } = await supabaseAdmin.from("match_results").insert(resultsAbort);
      if (mrErr) throw mrErr;

      return j({ ok: true, match_id, aborted: true });
    }

    // --- Normales Match Ende: Placements + Elo ---
    const sorted = Object.entries(points)
      .map(([discord_id, pts]) => ({ discord_id, points: pts }))
      .sort((a, b) => b.points - a.points);

    // --- Save results for zwanglos (no Elo) ---
    if (mode === "zwanglos") {
      const resultsRows = sorted.map((s, idx) => ({
        match_id,
        discord_id: s.discord_id,
        total_points: s.points,
        placement: idx + 1,
        elo_delta: 0,
      }));
      const { error: mrErr } = await supabaseAdmin.from("match_results").insert(resultsRows);
      if (mrErr) throw mrErr;

      // update casual counters + round wins
      for (const id of ids) {
        const curGames = Number(byId[id]?.games_casual ?? 0);
        const curWI = Number(byId[id]?.wins_imposter_casual ?? 0);
        const curWC = Number(byId[id]?.wins_crew_casual ?? 0);

        const next = {
          updated_at: nowIso(),
          games_casual: curGames + 1,
          wins_imposter_casual: curWI + Number(roundWinsImposter[id] ?? 0),
          wins_crew_casual: curWC + Number(roundWinsUnschuldig[id] ?? 0),
        };

        const { error: updErr } = await supabaseAdmin.from("players").update(next).eq("discord_id", id);
        if (updErr) throw updErr;
      }

      return j({ ok: true, match_id, aborted: false });
    }

    // --- Ranked Elo: compute base (ties) + lobby multiplier ---
    const baseDeltaMap = computeBaseDeltasByTiesFloat(sorted);

    // Elo-before from payload if provided, else current DB elo
    const eloBefore: Record<string, number> = {};
    for (const p of body.players) {
      const id = String(p.discord_id);
      if (Number.isFinite(p.elo_before as any)) eloBefore[id] = Number(p.elo_before);
      else eloBefore[id] = Number(byId[id]?.elo_ranked ?? 1000);
    }

    // Placement flags: first 6 ranked games of that player
    const isPlacement: Record<string, boolean> = {};
    let anyPlacement = false;
    for (const id of ids) {
      const played = Number(byId[id]?.ranked_games_played ?? 0);
      const placement = played < PLACEMENT_GAMES;
      isPlacement[id] = placement;
      if (placement) anyPlacement = true;
    }

    // 1) scaled deltas (float) for everyone
    const scaled: Record<string, number> = {};
    for (const s of sorted) {
      const id = s.discord_id;
      let d = baseDeltaMap.get(id) ?? 0;

      const others = ids.filter((x) => x !== id);
      const avgOthers = (eloBefore[others[0]] + eloBefore[others[1]] + eloBefore[others[2]]) / 3;

      d = applyLobbyMultiplierFloat(d, eloBefore[id], avgOthers);

      // placement multiplier only for that player
      if (isPlacement[id]) d = d * PLACEMENT_MULT;

      scaled[id] = d;
    }

    // 2) Final deltas:
    // - if any placement player in the match => NOT zero-sum (by design), just round each
    // - else => zero-sum normalize+round
    const finalDeltas: Record<string, number> = anyPlacement
      ? Object.fromEntries(ids.map((id) => [id, Math.round(scaled[id] ?? 0)]))
      : normalizeZeroSumAndRound(scaled);

    // 3) Save match_results (placements from sorted order)
    const resultsRows = sorted.map((s, idx) => ({
      match_id,
      discord_id: s.discord_id,
      total_points: s.points,
      placement: idx + 1,
      elo_delta: finalDeltas[s.discord_id] ?? 0,
    }));

    const { error: mrErr } = await supabaseAdmin.from("match_results").insert(resultsRows);
    if (mrErr) throw mrErr;

    // 4) Update players: elo_ranked (with floor), games_ranked++, ranked_games_played++,
    //    plus round wins counters
    for (const id of ids) {
      const curElo = Number(byId[id]?.elo_ranked ?? 1000);
      const curGR = Number(byId[id]?.games_ranked ?? 0);
      const curRGP = Number(byId[id]?.ranked_games_played ?? 0);
      const curWI = Number(byId[id]?.wins_imposter_ranked ?? 0);
      const curWC = Number(byId[id]?.wins_crew_ranked ?? 0);

      const delta = Number(finalDeltas[id] ?? 0);
      const nextElo = Math.max(ELO_FLOOR, curElo + delta);

      const next = {
        updated_at: nowIso(),
        elo_ranked: nextElo,
        games_ranked: curGR + 1,
        ranked_games_played: curRGP + 1,
        wins_imposter_ranked: curWI + Number(roundWinsImposter[id] ?? 0),
        wins_crew_ranked: curWC + Number(roundWinsUnschuldig[id] ?? 0),
      };

      const { error: updErr } = await supabaseAdmin.from("players").update(next).eq("discord_id", id);
      if (updErr) throw updErr;
    }

    return j({
      ok: true,
      match_id,
      aborted: false,
      anyPlacement,
      placementMult: PLACEMENT_MULT,
      eloFloor: ELO_FLOOR,
    });
  } catch (err: any) {
    console.error(err);
    return j({ ok: false, error: String(err?.message ?? err) }, 500);
  }
}
