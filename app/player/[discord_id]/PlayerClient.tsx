"use client";

import Link from "next/link";
import { Fragment, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

/* ===================== TYPES ===================== */

type PlayerRow = {
  discord_id: string;
  last_name: string | null;
  elo_ranked: number | null;

  games_ranked: number | null;
  games_casual: number | null;

  wins_imposter_ranked: number | null;
  wins_crew_ranked: number | null;

  wins_imposter_casual: number | null;
  wins_crew_casual: number | null;
};

type RecentMatchRow = {
  match_id: number;
  total_points: number | null;
  placement: number | null;
  elo_delta: number | null;

  // Supabase join -> kann Object oder Array sein
  matches: {
    id: number;
    started_at: string | null;
    ended_at: string | null;
    mode: "ranked" | "zwanglos" | string;
  } | {
    id: number;
    started_at: string | null;
    ended_at: string | null;
    mode: "ranked" | "zwanglos" | string;
  }[];
};

type RoundRow = {
  id: number;
  round_no: number;

  categoryName: string | null;
  word: string | null;

  imposter_discord_id: string | null;
  imposter_name: string | null;
  winner: string;
  win_method: string;

  points_imposter: number;
  points_unschuldig: number;
  
  aborted: boolean;
  aborted_reason: string | null;
};

type MatchPlayerRow = {
  discord_id: string;
  player_name: string;
  placement: number;
  total_points: number;
  elo_delta: number;
};

// raw from supabase: categories join can arrive as array
type RoundRowRaw = {
  id: any;
  round_no: any;
  word: any;
  winner: any;
  win_method: any;
  imposter_discord_id: any;
  points_imposter: any;
  points_unschuldig: any;
  aborted: any;
  aborted_reason: any;
  categories: { name: any }[] | null;
};

/* ===================== HELPERS ===================== */

const clamp = (n: number | null | undefined) =>
  Number.isFinite(n) ? (n as number) : 0;

function fmtDateTime(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("de-DE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function pct(x: number | null) {
  if (x == null || !Number.isFinite(x)) return "—";
  return `${Math.round(x * 100)}%`;
}

function winnerLabel(w: string) {
  if (w === "imposter") return "Imposter";
  return "Unschuldig";
}

function winMethodLabel(method: string) {
  const map: Record<string, string> = {
    guessed_word: "Richtig geraten",
    wrong_guess: "Falsch geraten",
    voted_out_innocent: "Unschuldigen gewählt",
    voted_out_imposter: "Imposter gewählt",
    timeout: "Zeitablauf",
    other: "Sonstiges",
  };
  return map[method] ?? method;
}

/* ===================== RANK SYSTEM ===================== */

const RANKS = [
  { label: "Eisen I", min: 300, badge: "/badges/eisen1.png" },
  { label: "Eisen II", min: 400, badge: "/badges/eisen2.png" },
  { label: "Eisen III", min: 500, badge: "/badges/eisen3.png" },

  { label: "Bronze I", min: 600, badge: "/badges/bronze1.png" },
  { label: "Bronze II", min: 700, badge: "/badges/bronze2.png" },
  { label: "Bronze III", min: 800, badge: "/badges/bronze3.png" },

  { label: "Silber I", min: 900, badge: "/badges/silber1.png" },
  { label: "Silber II", min: 1000, badge: "/badges/silber2.png" },
  { label: "Silber III", min: 1100, badge: "/badges/silber3.png" },

  { label: "Gold I", min: 1200, badge: "/badges/gold1.png" },
  { label: "Gold II", min: 1300, badge: "/badges/gold2.png" },
  { label: "Gold III", min: 1400, badge: "/badges/gold3.png" },

  { label: "Platin I", min: 1500, badge: "/badges/platin1.png" },
  { label: "Platin II", min: 1600, badge: "/badges/platin2.png" },
  { label: "Platin III", min: 1700, badge: "/badges/platin3.png" },

  { label: "Diamant I", min: 1800, badge: "/badges/diamant1.png" },
  { label: "Diamant II", min: 1900, badge: "/badges/diamant2.png" },
  { label: "Diamant III", min: 2000, badge: "/badges/diamant3.png" },

  { label: "Master", min: 2100, badge: "/badges/master.png", master: true },
];

function getRankInfo(eloRaw: number | null | undefined, gamesRankedRaw: number | null | undefined) {
  const elo = clamp(eloRaw);
  const gamesRanked = clamp(gamesRankedRaw);

  // Unranked: <6 ranked games => unranked badge + keine Elo-Ziffern
  if (gamesRanked < 6) {
    return { label: "Unranked", badge: "/badges/unranked.png", value: null as null };
  }

  let best = RANKS[0];
  for (const r of RANKS) if (elo >= r.min) best = r;

  const value = (best as any).master ? Math.max(0, elo - 2100) : ((elo % 100) + 100) % 100;
  return { label: best.label, badge: (best as any).badge, value };
}

/* ===================== COMPONENT ===================== */

export default function PlayerClient({ discordId }: { discordId: string }) {
  const [player, setPlayer] = useState<PlayerRow | null>(null);
  const [recent, setRecent] = useState<RecentMatchRow[]>([]);
  const [casualFirsts, setCasualFirsts] = useState(0);

  // role stats über match_rounds (round_no=1) für ranked matches
  const [rankedRoleStats, setRankedRoleStats] = useState({
    impGames: 0,
    impWins: 0,
    crewGames: 0,
    crewWins: 0,
  });

  // accordion
  const [openMatchId, setOpenMatchId] = useState<number | null>(null);
  const [roundsByMatch, setRoundsByMatch] = useState<Record<number, RoundRow[]>>({});
  const [roundsLoading, setRoundsLoading] = useState<Record<number, boolean>>({});
  const [playersByMatch, setPlayersByMatch] = useState<Record<number, MatchPlayerRow[]>>({});

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const rank = useMemo(
    () => getRankInfo(player?.elo_ranked, player?.games_ranked),
    [player]
  );

  const rankedOverview = useMemo(() => {
    const gr = clamp(player?.games_ranked);
    const winsImp = clamp(player?.wins_imposter_ranked);
    const winsCrew = clamp(player?.wins_crew_ranked);
    const winsTotal = winsImp + winsCrew;
    const overallWR = gr > 0 ? winsTotal / gr : 0;
    return { gr, overallWR };
  }, [player]);

  const rankedRoleWinrates = useMemo(() => {
    const impWR =
      rankedRoleStats.impGames > 0 ? rankedRoleStats.impWins / rankedRoleStats.impGames : null;
    const crewWR =
      rankedRoleStats.crewGames > 0 ? rankedRoleStats.crewWins / rankedRoleStats.crewGames : null;
    return { impWR, crewWR };
  }, [rankedRoleStats]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      const id = String(discordId ?? "").trim();
      if (!id) {
        setError("discordId ist leer – Link/Route stimmt nicht.");
        setLoading(false);
        return;
      }

      // 1) Player
      const p = await supabase.from("players").select("*").eq("discord_id", id).maybeSingle();
      if (p.error) {
        if (!cancelled) {
          setError(`Supabase (players): ${p.error.message}`);
          setLoading(false);
        }
        return;
      }
      if (!p.data) {
        if (!cancelled) {
          setError(`Spieler nicht gefunden (discord_id=${id})`);
          setLoading(false);
        }
        return;
      }

      // 2) letzte 20 matches
      const m = await supabase
        .from("match_results")
        .select("match_id,total_points,placement,elo_delta,matches!inner(id,started_at,ended_at,mode)")
        .eq("discord_id", id)
        .order("started_at", { foreignTable: "matches", ascending: false })
        .limit(20);

      if (m.error) {
        if (!cancelled) {
          setError(`Supabase (match_results): ${m.error.message}`);
          setLoading(false);
        }
        return;
      }

      // DEBUG: Log the data structure
      console.log("Match results data:", m.data?.[0]);

      // Sortiere nach Datum (neueste zuerst) - falls Supabase-Sortierung nicht funktioniert
      const sortedMatches = (m.data ?? []).sort((a: any, b: any) => {
        const dateA = Array.isArray(a.matches) ? a.matches[0]?.started_at : a.matches?.started_at;
        const dateB = Array.isArray(b.matches) ? b.matches[0]?.started_at : b.matches?.started_at;
        if (!dateA || !dateB) return 0;
        return new Date(dateB).getTime() - new Date(dateA).getTime();
      });

      // 3) Zwanglos 1.-Plätze zählen (count-only)
      const cf = await supabase
        .from("match_results")
        .select("match_id,matches!inner(mode)", { count: "exact", head: true })
        .eq("discord_id", id)
        .eq("placement", 1)
        .eq("matches.mode", "zwanglos");

      const casualFirstCount = cf.count ?? 0;

      // 4) ranked role stats via round_no=1 (distinct pro match)
      const rankedParts = await supabase
        .from("match_results")
        .select("match_id,matches!inner(mode)")
        .eq("discord_id", id)
        .eq("matches.mode", "ranked");

      let impGames = 0,
        impWins = 0,
        crewGames = 0,
        crewWins = 0;

      if (!rankedParts.error && rankedParts.data && rankedParts.data.length > 0) {
        const rankedMatchIds = rankedParts.data.map((x: any) => x.match_id);

        const r1 = await supabase
          .from("match_rounds")
          .select("match_id,imposter_discord_id,winner")
          .in("match_id", rankedMatchIds)
          .eq("round_no", 1);

        if (!r1.error && r1.data) {
          for (const row of r1.data as any[]) {
            const impId = row.imposter_discord_id as string | null;
            const winner = String(row.winner ?? "");

            const isImposter = impId === id;
            if (isImposter) {
              impGames += 1;
              if (winner === "imposter") impWins += 1;
            } else {
              crewGames += 1;
              if (winner !== "imposter") crewWins += 1;
            }
          }
        }
      }

      if (!cancelled) {
        setPlayer(p.data as PlayerRow);
        setRecent(sortedMatches as RecentMatchRow[]);
        setCasualFirsts(casualFirstCount);
        setRankedRoleStats({ impGames, impWins, crewGames, crewWins });
        setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [discordId]);

  async function toggleMatch(matchId: number) {
    if (openMatchId === matchId) {
      setOpenMatchId(null);
      return;
    }

    setOpenMatchId(matchId);

    // cached already
    if (roundsByMatch[matchId] && playersByMatch[matchId]) return;

    setRoundsLoading((s) => ({ ...s, [matchId]: true }));

    // Lade Runden
    const r = await supabase
      .from("match_rounds")
      .select(
        "id,round_no,word,winner,win_method,imposter_discord_id,points_imposter,points_unschuldig,aborted,aborted_reason,categories(name)"
      )
      .eq("match_id", matchId)
      .order("round_no", { ascending: true });

    // Lade alle Spieler für dieses Match
    const mp = await supabase
      .from("match_results")
      .select("discord_id,placement,total_points,elo_delta")
      .eq("match_id", matchId)
      .order("placement", { ascending: true });

    if (!r.error) {
      const raw = (r.data ?? []) as unknown as RoundRowRaw[];

      // Hole Spielernamen für alle Imposter in diesem Match
      const imposterIds = [...new Set(raw.map(x => x.imposter_discord_id).filter(Boolean))];
      const { data: playersData } = await supabase
        .from("players")
        .select("discord_id,last_name")
        .in("discord_id", imposterIds);

      const playerNames = new Map<string, string>();
      (playersData ?? []).forEach((p: any) => {
        playerNames.set(p.discord_id, p.last_name ?? p.discord_id);
      });

      const normalized: RoundRow[] = raw.map((x) => ({
        id: Number(x.id),
        round_no: Number(x.round_no),
        word: x.word ?? null,
        winner: String(x.winner ?? ""),
        win_method: String(x.win_method ?? ""),
        imposter_discord_id: x.imposter_discord_id ?? null,
        imposter_name: x.imposter_discord_id ? playerNames.get(x.imposter_discord_id) ?? x.imposter_discord_id : null,
        points_imposter: Number(x.points_imposter ?? 0),
        points_unschuldig: Number(x.points_unschuldig ?? 0),
        aborted: Boolean(x.aborted),
        aborted_reason: x.aborted_reason ?? null,
        // categories kann Object oder Array sein
        categoryName: Array.isArray(x.categories) 
          ? x.categories[0]?.name ?? null 
          : (x.categories as any)?.name ?? null,
      }));

      setRoundsByMatch((prev) => ({ ...prev, [matchId]: normalized }));
    }

    if (!mp.error && mp.data) {
      // Hole Namen für alle Spieler
      const allPlayerIds = mp.data.map((p: any) => p.discord_id);
      const { data: allPlayersData } = await supabase
        .from("players")
        .select("discord_id,last_name")
        .in("discord_id", allPlayerIds);

      const allPlayerNames = new Map<string, string>();
      (allPlayersData ?? []).forEach((p: any) => {
        allPlayerNames.set(p.discord_id, p.last_name ?? p.discord_id);
      });

      const matchPlayers: MatchPlayerRow[] = mp.data.map((p: any) => ({
        discord_id: p.discord_id,
        player_name: allPlayerNames.get(p.discord_id) ?? p.discord_id,
        placement: Number(p.placement ?? 0),
        total_points: Number(p.total_points ?? 0),
        elo_delta: Number(p.elo_delta ?? 0),
      }));

      setPlayersByMatch((prev) => ({ ...prev, [matchId]: matchPlayers }));
    }

    setRoundsLoading((s) => ({ ...s, [matchId]: false }));
  }

  if (loading) return <div className="p-6 text-zinc-300">Lade Profil…</div>;

  if (error)
    return (
      <div className="p-6 text-red-300">
        Fehler: {error}
        <div className="mt-3">
          <Link className="underline" href="/">
            ← Zurück zur Startseite
          </Link>
        </div>
      </div>
    );

  if (!player) return <div className="p-6">Kein Spieler gefunden.</div>;

  const qualified = clamp(player.games_ranked) >= 6;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            <div className="text-xs text-zinc-400">Spieler</div>
            <div className="truncate text-2xl font-semibold text-zinc-100">
              {player.last_name ?? "Unbenannt"}
            </div>
            <div className="mt-1 font-mono text-xs text-zinc-500">{player.discord_id}</div>
          </div>

          <div className="flex items-center gap-4 rounded-2xl border border-zinc-800 bg-zinc-950/40 px-4 py-3">
            <img src={rank.badge} alt={rank.label} className="h-28 w-auto object-contain" />
            <div>
              <div className="text-xs text-zinc-400">Rank</div>
              <div className="text-xl font-semibold text-zinc-100">
                {rank.label}
                {rank.value !== null && <span className="ml-2">{rank.value}</span>}
              </div>
              {!qualified && (
                <div className="mt-1 text-xs text-zinc-500">
                  Noch {Math.max(0, 6 - clamp(player.games_ranked))} Ranked-Spiele bis sichtbar
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6">
          <div className="text-sm font-semibold text-zinc-100">Ranked</div>
          <div className="mt-2 text-sm text-zinc-300">
            Spiele:{" "}
            <span className="font-semibold text-zinc-100">{rankedOverview.gr}</span>
          </div>
          <div className="mt-1 text-sm text-zinc-300">
            Overall Winrate:{" "}
            <span className="font-semibold text-zinc-100">{pct(rankedOverview.overallWR)}</span>
          </div>
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6">
          <div className="text-sm font-semibold text-zinc-100">Imposter (Ranked)</div>
          <div className="mt-2 text-sm text-zinc-300">
            Spiele:{" "}
            <span className="font-semibold text-zinc-100">{rankedRoleStats.impGames}</span>
          </div>
          <div className="mt-1 text-sm text-zinc-300">
            Winrate:{" "}
            <span className="font-semibold text-zinc-100">{pct(rankedRoleWinrates.impWR)}</span>
          </div>
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6">
          <div className="text-sm font-semibold text-zinc-100">Unschuldig (Ranked)</div>
          <div className="mt-2 text-sm text-zinc-300">
            Spiele:{" "}
            <span className="font-semibold text-zinc-100">{rankedRoleStats.crewGames}</span>
          </div>
          <div className="mt-1 text-sm text-zinc-300">
            Winrate:{" "}
            <span className="font-semibold text-zinc-100">{pct(rankedRoleWinrates.crewWR)}</span>
          </div>
        </div>
      </div>

      {/* Casual */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6">
        <div className="text-sm font-semibold text-zinc-100">Zwanglos</div>
        <div className="mt-2 text-sm text-zinc-300">
          Spiele:{" "}
          <span className="font-semibold text-zinc-100">{clamp(player.games_casual)}</span>
        </div>
        <div className="mt-1 text-sm text-zinc-300">
          1. Plätze:{" "}
          <span className="font-semibold text-zinc-100">{casualFirsts}</span>
        </div>
      </div>

      {/* Matches + Accordion */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-zinc-100">Letzte 20 Spiele</div>
          <div className="text-xs text-zinc-500">{recent.length} angezeigt</div>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-zinc-400">
              <tr>
                <th className="py-2">Datum</th>
                <th className="py-2">Modus</th>
                <th className="py-2">Platz</th>
                <th className="py-2">Punkte</th>
                <th className="py-2">Elo Δ</th>
                <th className="py-2">Details</th>
              </tr>
            </thead>

            <tbody className="text-zinc-200">
              {recent.map((row) => {
                // Supabase kann matches als Object oder Array zurückgeben
                const meta = Array.isArray(row.matches) ? row.matches[0] : row.matches;
                const isOpen = openMatchId === row.match_id;

                return (
                  <Fragment key={`match-${row.match_id}`}>
                    <tr className="border-t border-zinc-800">
                      <td className="py-2">{fmtDateTime(meta?.started_at)}</td>
                      <td className="py-2">{meta?.mode ?? "—"}</td>
                      <td className="py-2">{row.placement ?? "—"}</td>
                      <td className="py-2">{row.total_points ?? "—"}</td>
                      <td className="py-2">{meta?.mode === "zwanglos" ? "—" : (row.elo_delta ?? 0)}</td>
                      <td className="py-2">
                        <button
                          className="rounded-lg border border-zinc-700 bg-zinc-950/30 px-2 py-1 text-xs hover:bg-zinc-950/60"
                          onClick={() => toggleMatch(row.match_id)}
                        >
                          {isOpen ? "schließen" : "anzeigen"}
                        </button>
                      </td>
                    </tr>

                    {isOpen && (
                      <tr className="border-t border-zinc-800">
                        <td colSpan={6} className="py-3">
                          <div className="space-y-4">
                            {/* Runden-Tabelle */}
                            <div className="rounded-xl border border-zinc-800 bg-zinc-950/30 p-4">
                              <div className="mb-2 text-sm font-semibold text-zinc-100">Runden</div>
                              {roundsLoading[row.match_id] ? (
                                <div className="text-sm text-zinc-300">Lade Runden…</div>
                              ) : (roundsByMatch[row.match_id] ?? []).length === 0 ? (
                                <div className="text-sm text-zinc-400">Keine Rundendaten gefunden.</div>
                              ) : (
                                <div className="overflow-x-auto">
                                  <table className="w-full text-sm">
                                    <thead className="text-xs text-zinc-400">
                                      <tr>
                                        <th className="text-left py-2">Runde</th>
                                        <th className="py-2">Imposter</th>
                                        <th className="py-2">Gewinner</th>
                                        <th className="py-2">Methode</th>
                                        <th className="py-2">Kategorie</th>
                                        <th className="py-2">Wort</th>
                                        <th className="py-2">Punkte I</th>
                                        <th className="py-2">Punkte U</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {(roundsByMatch[row.match_id] ?? []).map((rr) => {
                                        // Punkte basierend auf Gewinner berechnen
                                        const pointsImposter = rr.aborted ? 0 : (rr.winner === "imposter" ? 2 : 0);
                                        const pointsUnschuldig = rr.aborted ? 0 : (rr.winner === "imposter" ? 0 : 1);
                                        
                                        return (
                                        <tr key={rr.id} className={`border-t border-zinc-800 ${rr.aborted ? 'opacity-50' : ''}`}>
                                          <td className="py-2">{rr.round_no}{rr.aborted ? ' ⚠️' : ''}</td>
                                          <td className="py-2">{rr.imposter_name ?? "—"}</td>
                                          <td className="py-2">{rr.aborted ? 'Abgebrochen' : winnerLabel(rr.winner)}</td>
                                          <td className="py-2">{rr.aborted ? (rr.aborted_reason ?? '—') : winMethodLabel(rr.win_method)}</td>
                                          <td className="py-2">{rr.categoryName ?? "—"}</td>
                                          <td className="py-2">{rr.word ?? "—"}</td>
                                          <td className="py-2">{rr.aborted ? '—' : pointsImposter}</td>
                                          <td className="py-2">{rr.aborted ? '—' : pointsUnschuldig}</td>
                                        </tr>
                                        );
                                      })}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                            </div>

                            {/* Spieler-Rangliste */}
                            <div className="rounded-xl border border-zinc-800 bg-zinc-950/30 p-4">
                              <div className="mb-2 text-sm font-semibold text-zinc-100">Spieler-Rangliste</div>
                              {roundsLoading[row.match_id] ? (
                                <div className="text-sm text-zinc-300">Lade Spieler…</div>
                              ) : (playersByMatch[row.match_id] ?? []).length === 0 ? (
                                <div className="text-sm text-zinc-400">Keine Spielerdaten gefunden.</div>
                              ) : (
                                <div className="overflow-x-auto">
                                  <table className="w-full text-sm">
                                    <thead className="text-xs text-zinc-400">
                                      <tr>
                                        <th className="text-left py-2">Platz</th>
                                        <th className="text-left py-2">Spieler</th>
                                        <th className="text-center py-2">Punkte</th>
                                        <th className="text-center py-2">Elo Δ</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {(playersByMatch[row.match_id] ?? []).map((mp) => (
                                        <tr key={mp.discord_id} className="border-t border-zinc-800">
                                          <td className="py-2">{mp.placement}</td>
                                          <td className="py-2">
                                            <Link 
                                              href={`/player/${encodeURIComponent(mp.discord_id)}`}
                                              className="text-blue-400 hover:text-blue-300 hover:underline"
                                            >
                                              {mp.player_name}
                                            </Link>
                                          </td>
                                          <td className="py-2 text-center">{mp.total_points}</td>
                                          <td className="py-2 text-center">
                                            {meta?.mode === "zwanglos" ? "—" : (
                                              <span className={mp.elo_delta >= 0 ? "text-green-400" : "text-red-400"}>
                                                {mp.elo_delta >= 0 ? "+" : ""}{mp.elo_delta}
                                              </span>
                                            )}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}

              {recent.length === 0 && (
                <tr className="border-t border-zinc-800">
                  <td className="py-4 text-sm text-zinc-400" colSpan={6}>
                    Noch keine Matches gefunden.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="mt-4">
          <Link href="/" className="text-sm underline text-zinc-200">
            ← Zurück zur Startseite
          </Link>
        </div>
      </div>
    </div>
  );
}
