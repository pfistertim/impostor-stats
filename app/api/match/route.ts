// app/api/match/route.ts
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

type ModeIn = "ranked" | "zwanglos" | "casual";
type ModeDb = "ranked" | "zwanglos";
type Winner = "imposter" | "unschuldig";

type WinMethodDb =
  | "guessed_word"
  | "voted_out_innocent"
  | "voted_out_imposter"
  | "wrong_guess"
  | "timeout"
  | "other";

type PlayerIn = {
  discord_id: string;
  display_name?: string | null;
  elo_before?: number | null;
  total_points?: number | null;
};

type RoundInBot = {
  round_no?: number;
  category?: string;
  category_slug?: string | null;
  category_name?: string | null;
  word?: string | null;
  imposter_discord_id: string;
  winner: Winner;
  win_method?: string;
  aborted?: boolean;
  aborted_reason?: string | null;
};

type Payload = {
  guild_id: string; // ✅ existiert bei dir in matches & player_violations
  mode: ModeIn;
  started_at?: string | null;
  ended_at?: string | null;

  players: PlayerIn[];
  rounds?: RoundInBot[] | null;

  ended_reason?: string | null;
  abort_reason?: string | null;

  violation?: {
    type: "afk" | "unangemessen" | "left_voice";
    discord_id: string;
    round_no?: number | null; // kommt evtl. vom Bot, aber wir speichern in Variante B KEIN round_id
  } | null;
};

function j(data: any, status = 200) {
  return NextResponse.json(data, { status });
}
function nowIso() {
  return new Date().toISOString();
}

const ELO_FLOOR = 300;
const PLACEMENT_GAMES = 6;
const PLACEMENT_MULT = 3;
const CASUAL_REQUIRED_FOR_RANKED = 5;

/**
 * Escalation:
 * 1: 30m
 * 2: 1h
 * 3: 2h
 * 4: 4h
 * 5: 8h
 * 6: 16h
 * 7+: 24h (8,9,10,... auch 24h)
 */
function penaltyMsForCount(countAfter: number) {
  if (countAfter <= 1) return 30 * 60 * 1000;
  if (countAfter === 2) return 60 * 60 * 1000;
  if (countAfter === 3) return 2 * 60 * 60 * 1000;
  if (countAfter === 4) return 4 * 60 * 60 * 1000;
  if (countAfter === 5) return 8 * 60 * 60 * 1000;
  if (countAfter === 6) return 16 * 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000;
}

function readBotToken(req: Request) {
  const auth = req.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m?.[1]) return m[1].trim();
  const legacy = req.headers.get("x-bot-token");
  if (legacy) return legacy.trim();
  return "";
}

function normalizeMode(mode: ModeIn): ModeDb {
  if (mode === "casual") return "zwanglos";
  if (mode === "zwanglos") return "zwanglos";
  return "ranked";
}

function mapWinMethod(raw?: string | null): WinMethodDb {
  const s = String(raw ?? "").trim().toLowerCase();

  if (s === "imposter_correct_guess" || s === "guessed_word") return "guessed_word";
  if (s === "wrong_guess" || s === "imposter_wrong_guess" || s === "all_imposters_guessed_wrong")
    return "wrong_guess";

  if (s === "voted_out_wrong" || s === "voted_out_innocent") return "voted_out_innocent";
  if (s === "voted_out_imposter_no_guess" || s === "voted_out_imposter") return "voted_out_imposter";

  if (s === "timeout") return "timeout";
  return "other";
}

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

/** Ranked Elo helpers */
function clampPct(absDiff: number) {
  if (absDiff >= 300) return 0.6;
  if (absDiff >= 200) return 0.4;
  if (absDiff >= 100) return 0.2;
  return 0;
}
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

/**
 * ✅ VARIANTE B:
 * - player_violations.round_id bleibt NULL
 * - Website sieht nur: Match aborted_reason = "violation:xxx"
 * - Violations zählen pro Server: guild_id + discord_id
 *
 * Deine player_violations Spalten (Screenshot):
 * - guild_id (text)
 * - discord_id (text)
 * - violation_type (text)
 * - source (text)
 * - match_id (int8)
 * - round_id (int8 nullable)  <-- bleibt NULL
 * - created_at (timestamptz)
 */
async function insertViolationAndReturnPenalty(args: {
  guild_id: string;
  discord_id: string;
  violation_type: "afk" | "unangemessen" | "left_voice";
  match_id: number;
}) {
  const { guild_id, discord_id, violation_type, match_id } = args;

  const { error: insErr } = await supabaseAdmin.from("player_violations").insert([
    {
      guild_id,
      discord_id,
      violation_type,
      source: "discord",
      match_id,
      round_id: null,
      created_at: nowIso(),
    },
  ]);
  if (insErr) throw insErr;

  const { count, error: cErr } = await supabaseAdmin
    .from("player_violations")
    .select("id", { count: "exact", head: true })
    .eq("guild_id", guild_id)
    .eq("discord_id", discord_id);
  if (cErr) throw cErr;

  const violations_count = Number(count ?? 0);
  const penalty_ms = penaltyMsForCount(violations_count);
  const penalty_until = new Date(Date.now() + penalty_ms).toISOString();

  // ✅ In players auch “anerkennen”
  // (deine players Tabelle hat: violations_count, banned_until, last_violation_at)
  const { error: updErr } = await supabaseAdmin
    .from("players")
    .update({
      violations_count,
      banned_until: penalty_until,
      last_violation_at: nowIso(),
      updated_at: nowIso(),
    })
    .eq("discord_id", discord_id);
  if (updErr) throw updErr;

  return { violations_count, penalty_ms, penalty_until };
}

export async function POST(req: Request) {
  let body: Payload | null = null;

  try {
    const token = readBotToken(req);
    if (!token || token !== process.env.BOT_INGEST_TOKEN) {
      return j({ ok: false, error: "unauthorized" }, 401);
    }

    const rawBody = await req.text();
    if (!rawBody) return j({ ok: false, error: "empty body" }, 400);

    try {
      body = JSON.parse(rawBody);
    } catch {
      return j({ ok: false, error: "invalid json" }, 400);
    }

    if (!body?.guild_id || !body?.mode || !Array.isArray(body.players)) {
      return j({ ok: false, error: "missing fields" }, 400);
    }
    if (body.players.length !== 4) {
      return j({ ok: false, error: "expected 4 players", got: body.players.length }, 400);
    }

    const modeDb = normalizeMode(body.mode);
    const guild_id = String(body.guild_id);
    const ids = body.players.map((p) => String(p.discord_id));

    // Upsert players (Name)
    const upsertPlayers = body.players.map((p) => ({
      discord_id: String(p.discord_id),
      last_name: p.display_name ?? null,
      updated_at: nowIso(),
    }));
    const { error: upsertErr } = await supabaseAdmin
      .from("players")
      .upsert(upsertPlayers, { onConflict: "discord_id" });
    if (upsertErr) throw upsertErr;

    // Read current stats
    const { data: playerRows, error: prErr } = await supabaseAdmin
      .from("players")
      .select("discord_id, elo_ranked, games_casual, games_ranked, ranked_games_played")
      .in("discord_id", ids);
    if (prErr) throw prErr;

    const byId: Record<string, any> = {};
    for (const r of playerRows ?? []) byId[String(r.discord_id)] = r;

    // ranked gate: 5 casual
    if (modeDb === "ranked") {
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

    const rounds: RoundInBot[] = Array.isArray(body.rounds) ? body.rounds : [];
    const hasRounds = rounds.length > 0;

    // ✅ ended_at IMMER setzen
    const startedAtIso = body.started_at ? new Date(body.started_at).toISOString() : nowIso();
    const endedAtIso = body.ended_at ? new Date(body.ended_at).toISOString() : nowIso();

    // ✅ aborted_reason NUR bei violation / abort_reason
    const aborted_reason =
      body.violation?.type ? `violation:${body.violation.type}` : (body.abort_reason ?? null);

    // Create match (dein matches hat guild_id)
    const { data: match, error: matchErr } = await supabaseAdmin
      .from("matches")
      .insert([
        {
          guild_id,
          mode: modeDb,
          started_at: startedAtIso,
          ended_at: endedAtIso,
          aborted_reason,
        },
      ])
      .select("id")
      .single();
    if (matchErr) throw matchErr;

    const match_id = match.id as number;

    // ✅ Violation speichern + Eskalation berechnen (VARIANTE B -> round_id bleibt NULL)
    let violationResult:
      | null
      | {
          discord_id: string;
          violation_type: string;
          violations_count: number;
          penalty_ms: number;
          penalty_until: string;
        } = null;

    if (body.violation?.type && body.violation?.discord_id) {
      const v = body.violation;
      const vr = await insertViolationAndReturnPenalty({
        guild_id,
        match_id,
        discord_id: String(v.discord_id),
        violation_type: v.type,
      });

      violationResult = {
        discord_id: String(v.discord_id),
        violation_type: v.type,
        violations_count: vr.violations_count,
        penalty_ms: vr.penalty_ms,
        penalty_until: vr.penalty_until,
      };
    }

    // Compute points
    const points: Record<string, number> = {};
    for (const id of ids) points[id] = 0;

    if (hasRounds) {
      const roundInsert: any[] = [];

      for (let idx = 0; idx < rounds.length; idx++) {
        const r = rounds[idx];

        const round_no = Number(r.round_no ?? idx + 1);
        const category_name = r.category_name ?? r.category ?? null;
        const category_slug = r.category_slug ?? null;

        const category_id = await getOrCreateCategoryId(category_slug, category_name);
        const win_method_db = mapWinMethod(r.win_method ?? null);

        // ✅ match_rounds Schema bei dir hat zusätzliche Felder
        roundInsert.push({
          match_id,
          round_no,
          category_id,
          word: r.word ?? null,
          imposter_discord_id: String(r.imposter_discord_id),
          winner: r.winner,
          win_method: win_method_db,

          // diese Felder existieren bei dir:
          points_imposter: 2,
          points_unschuldig: 1,
          started_at: null,
          ended_at: null,
          skipped: false,
          aborted: Boolean(r.aborted),
          aborted_reason: r.aborted_reason ?? null,
        });
      }

      const { data: insertedRounds, error: roundErr } = await supabaseAdmin
        .from("match_rounds")
        .insert(roundInsert)
        .select("id, imposter_discord_id, winner, aborted");
      if (roundErr) throw roundErr;

      // round_player_points rows (dein table: round_id, discord_id, points)
      const rppRows: { round_id: number; discord_id: string; points: number }[] = [];

      for (const ir of insertedRounds ?? []) {
        const round_id = ir.id as number;
        const imp = String(ir.imposter_discord_id);
        const aborted = Boolean(ir.aborted);

        if (aborted) continue;

        if (ir.winner === "imposter") {
          points[imp] += 2;
          for (const id of ids) rppRows.push({ round_id, discord_id: id, points: id === imp ? 2 : 0 });
        } else {
          for (const id of ids) {
            if (id === imp) rppRows.push({ round_id, discord_id: id, points: 0 });
            else {
              points[id] += 1;
              rppRows.push({ round_id, discord_id: id, points: 1 });
            }
          }
        }
      }

      if (rppRows.length) {
        const { error: rppErr } = await supabaseAdmin.from("round_player_points").insert(rppRows);
        if (rppErr) throw rppErr;
      }
    } else {
      for (const p of body.players) {
        const id = String(p.discord_id);
        points[id] = Number(p.total_points ?? 0);
      }
    }

    const sorted = Object.entries(points)
      .map(([discord_id, pts]) => ({ discord_id, points: pts }))
      .sort((a, b) => b.points - a.points);

    // --- zwanglos ---
    if (modeDb === "zwanglos") {
      const resultsRows = sorted.map((s, idx) => ({
        match_id,
        discord_id: s.discord_id,
        total_points: s.points,
        placement: idx + 1,
        elo_delta: 0,
      }));
      const { error: mrErr } = await supabaseAdmin.from("match_results").insert(resultsRows);
      if (mrErr) throw mrErr;

      for (const id of ids) {
        const cur = Number(byId[id]?.games_casual ?? 0);
        const { error: updErr } = await supabaseAdmin
          .from("players")
          .update({ updated_at: nowIso(), games_casual: cur + 1 })
          .eq("discord_id", id);
        if (updErr) throw updErr;
      }

      return j({ ok: true, match_id, aborted: Boolean(aborted_reason), rounds_saved: hasRounds, violation: violationResult });
    }

    // --- ranked ---
    const baseDeltaMap = computeBaseDeltasByTiesFloat(sorted);

    const eloBefore: Record<string, number> = {};
    for (const p of body.players) {
      const id = String(p.discord_id);
      if (Number.isFinite(p.elo_before as any)) eloBefore[id] = Number(p.elo_before);
      else eloBefore[id] = Number(byId[id]?.elo_ranked ?? 1000);
    }

    const isPlacement: Record<string, boolean> = {};
    let anyPlacement = false;
    for (const id of ids) {
      const played = Number(byId[id]?.ranked_games_played ?? 0);
      const placement = played < PLACEMENT_GAMES;
      isPlacement[id] = placement;
      if (placement) anyPlacement = true;
    }

    const scaled: Record<string, number> = {};
    for (const s of sorted) {
      const id = s.discord_id;
      let d = baseDeltaMap.get(id) ?? 0;

      const others = ids.filter((x) => x !== id);
      const avgOthers = (eloBefore[others[0]] + eloBefore[others[1]] + eloBefore[others[2]]) / 3;

      d = applyLobbyMultiplierFloat(d, eloBefore[id], avgOthers);
      if (isPlacement[id]) d = d * PLACEMENT_MULT;

      scaled[id] = d;
    }

    const finalDeltas: Record<string, number> = anyPlacement
      ? Object.fromEntries(ids.map((id) => [id, Math.round(scaled[id] ?? 0)]))
      : normalizeZeroSumAndRound(scaled);

    const resultsRows = sorted.map((s, idx) => ({
      match_id,
      discord_id: s.discord_id,
      total_points: s.points,
      placement: idx + 1,
      elo_delta: finalDeltas[s.discord_id] ?? 0,
    }));
    const { error: mrErr } = await supabaseAdmin.from("match_results").insert(resultsRows);
    if (mrErr) throw mrErr;

    for (const id of ids) {
      const curElo = Number(byId[id]?.elo_ranked ?? 1000);
      const curGR = Number(byId[id]?.games_ranked ?? 0);
      const curRGP = Number(byId[id]?.ranked_games_played ?? 0);

      const delta = Number(finalDeltas[id] ?? 0);
      const nextElo = Math.max(ELO_FLOOR, curElo + delta);

      const { error: updErr } = await supabaseAdmin
        .from("players")
        .update({
          updated_at: nowIso(),
          elo_ranked: nextElo,
          games_ranked: curGR + 1,
          ranked_games_played: curRGP + 1,
        })
        .eq("discord_id", id);
      if (updErr) throw updErr;
    }

    return j({
      ok: true,
      match_id,
      aborted: Boolean(aborted_reason),
      anyPlacement,
      placementMult: PLACEMENT_MULT,
      eloFloor: ELO_FLOOR,
      rounds_saved: hasRounds,
      violation: violationResult,
    });
  } catch (err: any) {
    console.error("API /api/match error:", err);
    const msg = String(err?.message ?? err);
    const details = err?.details || err?.hint || err?.code || err?.stack || null;
    return j({ ok: false, error: msg, details }, 500);
  }
}
