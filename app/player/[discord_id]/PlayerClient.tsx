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
  duo_coins: number | null;
  duo_games: number | null;

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
  coins_earned: number | null;
  duo_coins_delta: number | null;
  ranked_games_played?: number | null; // ✅ Für Unranked-Check in Haupttabelle

  // Supabase join -> kann Object oder Array sein
  matches: {
    id: number;
    started_at: string | null;
    ended_at: string | null;
    mode: "ranked" | "zwanglos" | string;
    aborted_reason: string | null;
  } | {
    id: number;
    started_at: string | null;
    ended_at: string | null;
    mode: "ranked" | "zwanglos" | string;
    aborted_reason: string | null;
  }[];
};

type RoundRow = {
  id: number;
  round_no: number;

  categoryName: string | null;
  word: string | null;

  imposter_discord_id: string | null;
  imposter_team_index: number | null;
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
  duo_coins_delta?: number;
  ranked_games_played?: number; // ✅ Für Unranked-Check
  team_index?: number; // ✅ Für Duo-Modus: Team-Nummer (0-basiert)
};

// raw from supabase: categories join can arrive as array
type RoundRowRaw = {
  id: any;
  round_no: any;
  word: any;
  winner: any;
  win_method: any;
  imposter_discord_id: any;
  imposter_team_index: any;
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

function formatCategoryName(name: string | null) {
  if (!name) return "—";
  
  // Ersetze Unterstriche durch " & " und kapitalisiere Wörter
  return name
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' & ');
}

function formatAbortReason(reason: string | null) {
  if (!reason) return "Abgebrochen";
  
  // Parse violation:xxx Format
  if (reason.startsWith("violation:")) {
    const type = reason.replace("violation:", "");
    const map: Record<string, string> = {
      afk: "AFK",
      left_voice: "Sprachchat verlassen",
      unangemessen: "Unangemessenes Verhalten",
    };
    return map[type] ?? "Verstoß";
  }
  
  return "Abgebrochen";
}

/**
 * Berechnet die tatsächliche Platzierung basierend auf Punktzahlen.
 * Wenn mehrere Spieler die gleiche Punktzahl haben, bekommen sie eine gemeinsame Platzierung.
 * 
 * Beispiele:
 * - [5,5,3,2] -> [1.5, 1.5, 3, 4] (Platz 1 und 2 teilen sich -> 1.5)
 * - [5,3,3,2] -> [1, 2.5, 2.5, 4] (Platz 2 und 3 teilen sich -> 2.5)
 * - [5,3,2,2] -> [1, 2, 3.5, 3.5] (Platz 3 und 4 teilen sich -> 3.5)
 * - [5,5,5,2] -> [2, 2, 2, 4] (Platz 1,2,3 teilen sich -> 2)
 * - [5,3,3,3] -> [1, 3, 3, 3] (Platz 2,3,4 teilen sich -> 3)
 * - [5,5,5,5] -> [2.5, 2.5, 2.5, 2.5] (Alle teilen sich -> 2.5)
 */
function calculateActualPlacement(players: { total_points: number; placement: number }[]): Map<number, number> {
  // Sortiere nach Punkten (höchste zuerst)
  const sorted = [...players].sort((a, b) => b.total_points - a.total_points);
  
  const placementMap = new Map<number, number>(); // original placement -> actual placement
  
  let currentRank = 1;
  let i = 0;
  
  while (i < sorted.length) {
    const currentPoints = sorted[i].total_points;
    
    // Finde alle Spieler mit gleicher Punktzahl
    const tiedPlayers = sorted.filter((p, idx) => idx >= i && p.total_points === currentPoints);
    const tiedCount = tiedPlayers.length;
    
    if (tiedCount > 1) {
      // Mehrere Spieler mit gleicher Punktzahl -> berechne Durchschnitt
      const ranksSum = Array.from({ length: tiedCount }, (_, idx) => currentRank + idx).reduce((a, b) => a + b, 0);
      const avgRank = ranksSum / tiedCount;
      
      // Setze für alle gebundenen Spieler die gleiche Platzierung
      tiedPlayers.forEach(p => {
        placementMap.set(p.placement, avgRank);
      });
      
      currentRank += tiedCount;
      i += tiedCount;
    } else {
      // Einzelner Spieler
      placementMap.set(sorted[i].placement, currentRank);
      currentRank++;
      i++;
    }
  }
  
  return placementMap;
}

/* ===================== RANK SYSTEM ===================== */

const RANKS = [
  { label: "Eisen I", min: 300, badge: "/badges/Eisen1.png" },
  { label: "Eisen II", min: 400, badge: "/badges/Eisen2.png" },
  { label: "Eisen III", min: 500, badge: "/badges/Eisen3.png" },

  { label: "Bronze I", min: 600, badge: "/badges/Bronze1.png" },
  { label: "Bronze II", min: 700, badge: "/badges/Bronze2.png" },
  { label: "Bronze III", min: 800, badge: "/badges/Bronze3.png" },

  { label: "Silber I", min: 900, badge: "/badges/Silber1.png" },
  { label: "Silber II", min: 1000, badge: "/badges/Silber2.png" },
  { label: "Silber III", min: 1100, badge: "/badges/Silber3.png" },

  { label: "Gold I", min: 1200, badge: "/badges/Gold1.png" },
  { label: "Gold II", min: 1300, badge: "/badges/Gold2.png" },
  { label: "Gold III", min: 1400, badge: "/badges/Gold3.png" },

  { label: "Platin I", min: 1500, badge: "/badges/Platin1.png" },
  { label: "Platin II", min: 1600, badge: "/badges/Platin2.png" },
  { label: "Platin III", min: 1700, badge: "/badges/Platin3.png" },

  { label: "Diamant I", min: 1800, badge: "/badges/Diamant1.png" },
  { label: "Diamant II", min: 1900, badge: "/badges/Diamant2.png" },
  { label: "Diamant III", min: 2000, badge: "/badges/Diamant3.png" },

  { label: "Master", min: 2100, badge: "/badges/Master.png", master: true },
];

function getRankInfo(eloRaw: number | null | undefined, gamesRankedRaw: number | null | undefined) {
  const elo = clamp(eloRaw);
  const gamesRanked = clamp(gamesRankedRaw);

  // Unranked: <6 ranked games => unranked badge + keine Elo-Ziffern
  if (gamesRanked < 6) {
    return { label: "Unranked", badge: "/badges/unranked.png", value: null as null, tier: "unranked" as const };
  }

  let best = RANKS[0];
  for (const r of RANKS) if (elo >= r.min) best = r;

  const value = (best as any).master ? Math.max(0, elo - 2100) : ((elo % 100) + 100) % 100;
  
  // Bestimme Tier basierend auf Elo
  let tier: "unranked" | "eisen" | "bronze" | "silver" | "gold" | "platin" | "diamant" | "master" = "unranked";
  if (elo >= 2100) tier = "master";
  else if (elo >= 1800) tier = "diamant";
  else if (elo >= 1500) tier = "platin";
  else if (elo >= 1200) tier = "gold";
  else if (elo >= 900) tier = "silver";
  else if (elo >= 600) tier = "bronze";
  else if (elo >= 300) tier = "eisen";
  
  return { label: best.label, badge: (best as any).badge, value, tier };
}

function getHeaderEffects(tier: "unranked" | "eisen" | "bronze" | "silver" | "gold" | "platin" | "diamant" | "master") {
  switch (tier) {
    case "unranked":
      return {
        className: "border-zinc-800 bg-zinc-900/40",
        style: {},
      };
    case "eisen":
      return {
        className: "border-gray-600/30 bg-gradient-to-br from-black via-gray-700/30 to-black shadow-lg shadow-gray-700/20 animate-subtle-pulse",
        style: {},
      };
    case "bronze":
      return {
        className: "border-amber-700/30 bg-gradient-to-br from-black via-amber-900/30 to-black shadow-lg shadow-amber-800/20 animate-subtle-pulse",
        style: {},
      };
    case "silver":
      return {
        className: "border-gray-400/30 bg-gradient-to-br from-black via-gray-700/30 to-black shadow-lg shadow-gray-600/20 animate-subtle-pulse",
        style: {},
      };
    case "gold":
      return {
        className: "border-yellow-500/30 bg-gradient-to-br from-black via-yellow-700/30 to-black animate-subtle-pulse animate-gold-glow",
        style: {},
      };
    case "platin":
      return {
        className: "border-gray-300/40 shadow-lg animate-platin-flow animate-platin-rainbow-glow",
        style: {
          backgroundImage: 'linear-gradient(135deg, #f3f4f6, #e5e7eb, #d1d5db, #9ca3af, #6b7280, #9ca3af, #d1d5db, #e5e7eb, #f3f4f6)',
        },
      };
    case "diamant":
      return {
        className: "border-cyan-400/60 shadow-lg animate-diamant-flow animate-diamant-rainbow-glow",
        style: {
          backgroundImage: 'linear-gradient(135deg, #e0f2fe, #a5f3fc, #67e8f9, #22d3ee, #06b6d4, #0891b2, #22d3ee, #67e8f9, #a5f3fc, #e0f2fe)',
        },
      };
    case "master":
      return {
        className: "border-purple-400/40 bg-gradient-to-br from-black via-purple-700/40 to-black shadow-lg animate-rainbow-glow",
        style: {},
      };
  }
}

function getBadgeEffects(tier: "unranked" | "eisen" | "bronze" | "silver" | "gold" | "platin" | "diamant" | "master") {
  switch (tier) {
    case "unranked":
      return {
        className: "",
        style: {},
      };
    case "eisen":
      return {
        className: "",
        style: {
          filter: "drop-shadow(0 0 4px rgba(120, 120, 120, 0.4))",
        },
      };
    case "bronze":
      return {
        className: "",
        style: {
          filter: "drop-shadow(0 0 4px rgba(180, 83, 9, 0.4))",
        },
      };
    case "silver":
      return {
        className: "",
        style: {
          filter: "drop-shadow(0 0 4px rgba(192, 192, 192, 0.4))",
        },
      };
    case "gold":
      return {
        className: "animate-subtle-pulse",
        style: {
          filter: "drop-shadow(0 0 6px rgba(255, 215, 0, 0.5))",
        },
      };
    case "platin":
      return {
        className: "animate-subtle-pulse",
        style: {
          filter: "drop-shadow(0 0 8px rgba(0, 255, 255, 0.6))",
        },
      };
    case "diamant":
      return {
        className: "animate-subtle-pulse",
        style: {
          filter: "drop-shadow(0 0 10px rgba(0, 191, 255, 0.7))",
        },
      };
    case "master":
      return {
        className: "animate-rainbow-glow",
        style: {},
      };
  }
}

function PlacementPill({ p }: { p: number }) {
  // Prüfe ob es eine .5 Platzierung ist
  const isHalf = p % 1 === 0.5;
  const lowerPlace = Math.floor(p);
  const upperPlace = Math.ceil(p);
  
  if (isHalf) {
    // Mische die Farben der beiden Plätze
    let mixedCls = "";
    let mixedStyle: any = {};
    
    if (p === 1.5) {
      // Gold + Silber Mix
      mixedCls = "text-yellow-50 border-yellow-300/60 shadow-lg shadow-yellow-400/25";
      mixedStyle = {
        backgroundImage: 'linear-gradient(135deg, #fbbf24, #f59e0b, #d1d5db, #9ca3af, #fbbf24)',
        textShadow: '0 0 2px rgba(0,0,0,0.8), 0 0 4px rgba(0,0,0,0.6)',
      };
    } else if (p === 2.5) {
      // Silber + Bronze Mix
      mixedCls = "text-gray-50 border-gray-400/60 shadow-md shadow-gray-500/20";
      mixedStyle = {
        backgroundImage: 'linear-gradient(135deg, #d1d5db, #9ca3af, #b45309, #d97706, #d1d5db)',
        textShadow: '0 0 2px rgba(0,0,0,0.8), 0 0 4px rgba(0,0,0,0.6)',
      };
    } else if (p === 3.5) {
      // Bronze + Rot Mix
      mixedCls = "text-amber-50 border-amber-700/60 shadow-md shadow-amber-800/20";
      mixedStyle = {
        backgroundImage: 'linear-gradient(135deg, #b45309, #d97706, #991b1b, #7f1d1d, #b45309)',
        textShadow: '0 0 2px rgba(0,0,0,0.8), 0 0 4px rgba(0,0,0,0.6)',
      };
    } else {
      // Fallback für andere .5 Platzierungen (z.B. 4.5, 5.5, etc.)
      mixedCls = "text-red-50 border-red-700/60 shadow-md shadow-red-800/20";
      mixedStyle = {
        backgroundImage: 'linear-gradient(135deg, #991b1b, #7f1d1d, #450a0a, #7f1d1d, #991b1b)',
        textShadow: '0 0 2px rgba(0,0,0,0.8), 0 0 4px rgba(0,0,0,0.6)',
      };
    }
    
    // Verwende Animation des niedrigeren Platzes
    const animationCls = lowerPlace === 1 ? "animate-subtle-pulse animate-gold-flow" : 
                        lowerPlace === 2 ? "animate-silver-flow" :
                        lowerPlace === 3 ? "animate-bronze-flow" : "";
    
    return (
      <span
        className={[
          "inline-flex items-center justify-center rounded-md border font-semibold",
          "h-8 w-8 text-xs transition-all duration-300 hover:scale-110",
          animationCls,
          mixedCls,
        ].join(" ")}
        style={mixedStyle}
      >
        {p}.
      </span>
    );
  }
  
  // Normale Platzierung (1, 2, 3, 4)
  const cls =
    p === 1
      ? "text-yellow-50 border-yellow-400/60 shadow-lg shadow-yellow-500/30"
      : p === 2
      ? "text-gray-50 border-gray-300/60 shadow-md shadow-gray-400/20"
      : p === 3
      ? "text-amber-50 border-amber-600/60 shadow-md shadow-amber-700/20"
      : "bg-gradient-to-br from-red-800 via-red-900 to-red-950 text-red-50 border-red-700/50";

  const metalStyle = 
    p === 1 ? {
      backgroundImage: 'linear-gradient(135deg, #fbbf24, #f59e0b, #fef3c7, #f59e0b, #fbbf24)',
      textShadow: '0 0 2px rgba(0,0,0,0.8), 0 0 4px rgba(0,0,0,0.6)',
    } : p === 2 ? {
      backgroundImage: 'linear-gradient(135deg, #d1d5db, #9ca3af, #f3f4f6, #9ca3af, #d1d5db)',
      textShadow: '0 0 2px rgba(0,0,0,0.8), 0 0 4px rgba(0,0,0,0.6)',
    } : p === 3 ? {
      backgroundImage: 'linear-gradient(135deg, #b45309, #d97706, #ca8a04, #d97706, #b45309)',
      textShadow: '0 0 2px rgba(0,0,0,0.8), 0 0 4px rgba(0,0,0,0.6)',
    } : {
      textShadow: '0 0 2px rgba(0,0,0,0.8), 0 0 4px rgba(0,0,0,0.6)',
    };

  return (
    <span
      className={[
        "inline-flex items-center justify-center rounded-md border font-semibold",
        "h-8 w-8 text-xs transition-all duration-300 hover:scale-110",
        p === 1 ? "animate-subtle-pulse animate-gold-flow" : 
        p === 2 ? "animate-silver-flow" :
        p === 3 ? "animate-bronze-flow" : "",
        cls,
      ].join(" ")}
      style={metalStyle}
    >
      {p}.
    </span>
  );
}

/* ===================== COMPONENT ===================== */

export default function PlayerClient({ discordId }: { discordId: string }) {
  const [player, setPlayer] = useState<PlayerRow | null>(null);
  const [recent, setRecent] = useState<RecentMatchRow[]>([]);
  const [casualFirsts, setCasualFirsts] = useState(0);
  const [casualFullGameFirsts, setCasualFullGameFirsts] = useState(0);
  const [duoAvgPlacement, setDuoAvgPlacement] = useState<number | null>(null);

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
  const [violationsByMatch, setViolationsByMatch] = useState<Record<number, { player_name: string; type: string } | null>>({});

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const rank = useMemo(
    () => getRankInfo(player?.elo_ranked, player?.games_ranked),
    [player]
  );

  const badgeEffects = useMemo(
    () => getBadgeEffects(rank.tier),
    [rank.tier]
  );

  const headerEffects = useMemo(
    () => getHeaderEffects(rank.tier),
    [rank.tier]
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

      // 2) letzte 20 matches (ranked + zwanglos aus match_results)
      const m = await supabase
        .from("match_results")
        .select("match_id,total_points,placement,elo_delta,matches!inner(id,started_at,ended_at,mode,aborted_reason)")
        .eq("discord_id", id)
        .limit(100); // ✅ Lade mehr, sortiere dann in JS

      if (m.error) {
        if (!cancelled) {
          setError(`Supabase (match_results): ${m.error.message}`);
          setLoading(false);
        }
        return;
      }

      // ✅ Sortiere in JavaScript nach started_at
      const sortedMatchResults = (m.data ?? []).sort((a: any, b: any) => {
        const metaA = Array.isArray(a.matches) ? a.matches[0] : a.matches;
        const metaB = Array.isArray(b.matches) ? b.matches[0] : b.matches;
        const dateA = metaA?.started_at;
        const dateB = metaB?.started_at;
        if (!dateA || !dateB) return 0;
        return new Date(dateB).getTime() - new Date(dateA).getTime();
      }).slice(0, 20); // Nur die neuesten 20

      // 2b) Duo matches - Alternative: Lade separat
      console.log("Loading duo matches for player ID:", id, "Type:", typeof id);
      
      // Erst alle Duo-Matches laden
      const allDuoMatchesSimple = await supabase
        .from("matches")
        .select("id,started_at,ended_at,mode,aborted_reason")
        .eq("mode", "duo")
        .order("started_at", { ascending: false })
        .limit(100);

      console.log("All duo matches (simple):", allDuoMatchesSimple);

      let duoMatchesWithInfo: any[] = [];
      
      if (allDuoMatchesSimple.data && allDuoMatchesSimple.data.length > 0) {
        const matchIds = allDuoMatchesSimple.data.map(m => m.id);
        
        console.log("Match IDs to query:", matchIds, "Types:", matchIds.map(id => typeof id));
        
        // Versuche alle Teams zu laden (ohne Filter) um zu sehen welche Spalten existieren
        const allTeamsQueryTest = await supabase
          .from("duo_teams")
          .select("*")
          .limit(10);

        console.log("All teams test query (all columns):", allTeamsQueryTest);
        console.log("Sample team data:", allTeamsQueryTest.data?.[0]);
        console.log("All column names:", allTeamsQueryTest.data?.[0] ? Object.keys(allTeamsQueryTest.data[0]) : []);
        
        // Dann alle Teams für diese Matches laden - mit allen Spalten
        const allTeamsQuery = await supabase
          .from("duo_teams")
          .select("*")
          .filter("match_id", "in", `(${matchIds.join(",")})`);

        console.log("All teams query:", allTeamsQuery);
        console.log("All teams error:", allTeamsQuery.error);

        if (allTeamsQuery.data) {
          // Gruppiere Teams nach Match
          const teamsByMatch: Record<number, any[]> = {};
          for (const team of allTeamsQuery.data) {
            const mid = team.match_id;
            if (!teamsByMatch[mid]) teamsByMatch[mid] = [];
            teamsByMatch[mid].push(team);
          }

          console.log("Teams by match:", teamsByMatch);

          // Filtere Matches wo Spieler dabei war
          for (const match of allDuoMatchesSimple.data) {
            const teams = teamsByMatch[match.id] ?? [];
            
            const playerTeam = teams.find((t: any) => {
              const captainId = String(t.captain_discord_id);
              const memberId = String(t.member_discord_id);
              return captainId === id || memberId === id;
            });

            if (playerTeam) {
              duoMatchesWithInfo.push({
                match_id: match.id,
                team_index: playerTeam.team_index,
                score: playerTeam.score,
                coins_earned: playerTeam.coins_earned ?? 0,
                captain_discord_id: playerTeam.captain_discord_id,
                member_discord_id: playerTeam.member_discord_id,
                matches: {
                  id: match.id,
                  started_at: match.started_at,
                  ended_at: match.ended_at,
                  mode: match.mode,
                  aborted_reason: match.aborted_reason,
                },
                allTeams: teams,
              });
            }
          }
        }
      }

      console.log("Duo matches for player:", duoMatchesWithInfo);
      console.log("Number of duo matches for player:", duoMatchesWithInfo.length);

      // Kombiniere beide Listen
      const allMatches: any[] = [];

      // Füge match_results hinzu
      for (const row of sortedMatchResults) {
        const meta = Array.isArray(row.matches) ? row.matches[0] : row.matches;
        allMatches.push({
          match_id: row.match_id,
          total_points: row.total_points,
          placement: row.placement,
          elo_delta: row.elo_delta,
          matches: meta,
          isDuo: false,
        });
      }

      // Füge duo_teams hinzu
      if (duoMatchesWithInfo.length > 0) {
        for (const row of duoMatchesWithInfo) {
          const meta = row.matches;
          if (!meta) continue;
          
          // Berechne Platzierung aus allen Teams
          const allTeams = row.allTeams ?? [];
          const sortedTeams = [...allTeams].sort((a: any, b: any) => b.score - a.score);
          const placement = sortedTeams.findIndex((t: any) => t.team_index === row.team_index) + 1;

          allMatches.push({
            match_id: row.match_id,
            total_points: row.score,
            placement: placement,
            elo_delta: null,
            duo_coins_delta: row.coins_earned ?? 0,
            matches: meta,
            isDuo: true,
          });
        }
      }

      // Sortiere nach Datum (neueste zuerst)
      const sortedMatches = allMatches.sort((a: any, b: any) => {
        const dateA = a.matches?.started_at;
        const dateB = b.matches?.started_at;
        if (!dateA || !dateB) return 0;
        return new Date(dateB).getTime() - new Date(dateA).getTime();
      }).slice(0, 20); // Nur die neuesten 20

      // ✅ Berechne tatsächliche Platzierungen für alle Matches
      const matchIdsToFix = sortedMatches.filter((m: any) => !m.isDuo).map((m: any) => m.match_id);
      
      if (matchIdsToFix.length > 0) {
        // Lade alle Spieler für diese Matches
        const { data: allPlayersInMatches } = await supabase
          .from("match_results")
          .select("match_id,discord_id,total_points,placement")
          .in("match_id", matchIdsToFix);

        if (allPlayersInMatches) {
          // Gruppiere nach Match
          const playersByMatch: Record<number, any[]> = {};
          for (const p of allPlayersInMatches) {
            const mid = p.match_id;
            if (!playersByMatch[mid]) playersByMatch[mid] = [];
            playersByMatch[mid].push(p);
          }

          // Berechne tatsächliche Platzierungen pro Match
          const actualPlacementsByMatch: Record<number, Map<string, number>> = {};
          for (const [matchId, players] of Object.entries(playersByMatch)) {
            const playersData = players.map((p: any) => ({
              discord_id: String(p.discord_id),
              total_points: Number(p.total_points ?? 0),
              placement: Number(p.placement ?? 0),
            }));
            
            const sorted = [...playersData].sort((a, b) => b.total_points - a.total_points);
            const placementMap = new Map<string, number>();
            let currentRank = 1;
            let i = 0;
            
            while (i < sorted.length) {
              const currentPoints = sorted[i].total_points;
              const tiedPlayers = sorted.filter((p, idx) => idx >= i && p.total_points === currentPoints);
              const tiedCount = tiedPlayers.length;
              
              if (tiedCount > 1) {
                const ranksSum = Array.from({ length: tiedCount }, (_, idx) => currentRank + idx).reduce((a, b) => a + b, 0);
                const avgRank = ranksSum / tiedCount;
                tiedPlayers.forEach(p => placementMap.set(p.discord_id, avgRank));
                currentRank += tiedCount;
                i += tiedCount;
              } else {
                placementMap.set(sorted[i].discord_id, currentRank);
                currentRank++;
                i++;
              }
            }
            
            actualPlacementsByMatch[Number(matchId)] = placementMap;
          }

          // Aktualisiere Platzierungen in sortedMatches
          sortedMatches.forEach((match: any) => {
            if (!match.isDuo && actualPlacementsByMatch[match.match_id]) {
              const actualPlacement = actualPlacementsByMatch[match.match_id].get(id);
              if (actualPlacement !== undefined) {
                match.placement = actualPlacement;
              }
            }
          });
        }
      }

      // ✅ Berechne ranked_games_played für jedes Match (für Unranked-Check)
      const rankedMatchesForPlayer = sortedMatches.filter((m: any) => {
        const meta = m.matches;
        return meta?.mode === "ranked";
      });

      // Für jedes Ranked-Match: Zähle wie viele Ranked-Matches der Spieler VOR diesem Match hatte
      for (const match of rankedMatchesForPlayer) {
        const matchDate = match.matches?.started_at ? new Date(match.matches.started_at) : null;
        
        if (matchDate) {
          const { count } = await supabase
            .from("match_results")
            .select("match_id,matches!inner(started_at,mode)", { count: "exact", head: true })
            .eq("discord_id", id)
            .eq("matches.mode", "ranked")
            .lt("matches.started_at", matchDate.toISOString());
          
          match.ranked_games_played = Number(count ?? 0);
        }
      }

      // Berechne auch für Duo-Matches die tatsächlichen Platzierungen
      const duoMatchIds = sortedMatches.filter((m: any) => m.isDuo).map((m: any) => m.match_id);
      
      if (duoMatchIds.length > 0) {
        const { data: allDuoTeams } = await supabase
          .from("duo_teams")
          .select("match_id,team_index,captain_discord_id,member_discord_id,score")
          .in("match_id", duoMatchIds);

        if (allDuoTeams) {
          const teamsByMatch: Record<number, any[]> = {};
          for (const t of allDuoTeams) {
            const mid = t.match_id;
            if (!teamsByMatch[mid]) teamsByMatch[mid] = [];
            teamsByMatch[mid].push(t);
          }

          const actualPlacementsByMatch: Record<number, Map<number, number>> = {};
          for (const [matchId, teams] of Object.entries(teamsByMatch)) {
            const teamData = teams.map((t: any, idx: number) => ({
              team_index: t.team_index,
              score: Number(t.score ?? 0),
              original_placement: idx + 1,
            }));
            
            const sorted = [...teamData].sort((a, b) => b.score - a.score);
            const placementMap = new Map<number, number>();
            let currentRank = 1;
            let i = 0;
            
            while (i < sorted.length) {
              const currentScore = sorted[i].score;
              const tiedTeams = sorted.filter((t, idx) => idx >= i && t.score === currentScore);
              const tiedCount = tiedTeams.length;
              
              if (tiedCount > 1) {
                const ranksSum = Array.from({ length: tiedCount }, (_, idx) => currentRank + idx).reduce((a, b) => a + b, 0);
                const avgRank = ranksSum / tiedCount;
                tiedTeams.forEach(t => placementMap.set(t.team_index, avgRank));
                currentRank += tiedCount;
                i += tiedCount;
              } else {
                placementMap.set(sorted[i].team_index, currentRank);
                currentRank++;
                i++;
              }
            }
            
            actualPlacementsByMatch[Number(matchId)] = placementMap;
          }

          // Aktualisiere Platzierungen in sortedMatches
          sortedMatches.forEach((match: any) => {
            if (match.isDuo) {
              // Finde team_index für diesen Spieler
              const teams = teamsByMatch[match.match_id] ?? [];
              const playerTeam = teams.find((t: any) => 
                String(t.captain_discord_id) === id || String(t.member_discord_id) === id
              );
              
              if (playerTeam && actualPlacementsByMatch[match.match_id]) {
                const actualPlacement = actualPlacementsByMatch[match.match_id].get(playerTeam.team_index);
                if (actualPlacement !== undefined) {
                  match.placement = actualPlacement;
                }
              }
            }
          });
        }
      }

      console.log("Combined matches with actual placements:", sortedMatches);

      // 3) Zwanglos 1.-Plätze zählen (count-only)
      const cf = await supabase
        .from("match_results")
        .select("match_id,matches!inner(mode)", { count: "exact", head: true })
        .eq("discord_id", id)
        .eq("placement", 1)
        .eq("matches.mode", "zwanglos");

      const casualFirstCount = cf.count ?? 0;

      // 3b) Zwanglos 1.-Plätze in VOLLEN Spielen (4 Spieler)
      // Hole alle Zwanglos-Matches wo Spieler 1. war
      const cfFull = await supabase
        .from("match_results")
        .select("match_id,matches!inner(id,mode)")
        .eq("discord_id", id)
        .eq("placement", 1)
        .eq("matches.mode", "zwanglos");

      let casualFullGameFirstCount = 0;
      if (cfFull.data && cfFull.data.length > 0) {
        const casualFirstMatchIds = cfFull.data.map((x: any) => {
          return Array.isArray(x.matches) ? x.matches[0]?.id : x.matches?.id;
        }).filter(Boolean);

        // Zähle Spieler pro Match
        if (casualFirstMatchIds.length > 0) {
          const { data: matchCounts } = await supabase
            .from("match_results")
            .select("match_id")
            .in("match_id", casualFirstMatchIds);

          const countByMatch: Record<number, number> = {};
          for (const row of matchCounts ?? []) {
            const mid = row.match_id;
            countByMatch[mid] = (countByMatch[mid] || 0) + 1;
          }

          // Zähle nur Matches mit 4 Spielern
          casualFullGameFirstCount = Object.values(countByMatch).filter(c => c === 4).length;
        }
      }

      // 4) Duo durchschnittliche Platzierung
      // Hole alle Duo-Matches für diesen Spieler
      const duoMatches = await supabase
        .from("matches")
        .select("id,started_at,duo_teams(team_index,captain_discord_id,member_discord_id,score)")
        .eq("mode", "duo")
        .order("started_at", { ascending: false })
        .limit(500);

      let duoAvg: number | null = null;
      if (duoMatches.data && duoMatches.data.length > 0) {
        const placements: number[] = [];
        
        for (const match of duoMatches.data) {
          const teams = (match as any).duo_teams ?? [];
          if (teams.length === 0) continue;
          
          // Sortiere Teams nach Score (höchster = Platz 1)
          const sortedTeams = [...teams].sort((a: any, b: any) => b.score - a.score);
          
          // Finde Platzierung des Spielers
          sortedTeams.forEach((team: any, idx: number) => {
            const captain = String(team.captain_discord_id);
            const member = String(team.member_discord_id);
            
            if (captain === id || member === id) {
              placements.push(idx + 1);
            }
          });
        }
        
        if (placements.length > 0) {
          duoAvg = placements.reduce((a, b) => a + b, 0) / placements.length;
        }
      }

      console.log("Duo placements:", duoAvg);

      // 5) ranked role stats via round_no=1 (distinct pro match)
      const rankedParts = await supabase
        .from("match_results")
        .select("match_id,matches!inner(mode)")
        .eq("discord_id", id)
        .eq("matches.mode", "ranked");

      console.log("Ranked matches for player:", rankedParts);

      let impGames = 0,
        impWins = 0,
        crewGames = 0,
        crewWins = 0;

      if (!rankedParts.error && rankedParts.data && rankedParts.data.length > 0) {
        const rankedMatchIds = rankedParts.data.map((x: any) => x.match_id);

        console.log("Ranked match IDs:", rankedMatchIds);

        const r1 = await supabase
          .from("match_rounds")
          .select("match_id,imposter_discord_id,winner")
          .in("match_id", rankedMatchIds)
          .eq("round_no", 1);

        console.log("Round data for player:", id, r1.data);
        console.log("Sample round:", r1.data?.[0]);

        if (!r1.error && r1.data) {
          for (const row of r1.data as any[]) {
            const impId = String(row.imposter_discord_id ?? "");
            const winner = String(row.winner ?? "");

            console.log(`Round: imposter=${impId}, winner=${winner}, player=${id}, isImposter=${impId === id}`);

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

      console.log("Ranked role stats:", { impGames, impWins, crewGames, crewWins });

      if (!cancelled) {
        setPlayer(p.data as PlayerRow);
        setRecent(sortedMatches as RecentMatchRow[]);
        setCasualFirsts(casualFirstCount);
        setCasualFullGameFirsts(casualFullGameFirstCount);
        setDuoAvgPlacement(duoAvg);
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

    // Bestimme Match-Modus zuerst
    const matchMeta = recent.find(r => r.match_id === matchId);
    const meta = Array.isArray((matchMeta as any)?.matches) ? (matchMeta as any).matches[0] : (matchMeta as any)?.matches;
    console.log("Match mode for", matchId, ":", meta?.mode);

    // ✅ Lade Violation-Daten (falls vorhanden)
    if (meta?.aborted_reason && meta.aborted_reason.startsWith("violation:")) {
      const { data: violationData } = await supabase
        .from("player_violations")
        .select("discord_id,violation_type")
        .eq("match_id", matchId)
        .maybeSingle();

      if (violationData) {
        // Hole Spielername
        const { data: playerData } = await supabase
          .from("players")
          .select("last_name")
          .eq("discord_id", violationData.discord_id)
          .maybeSingle();

        setViolationsByMatch((prev) => ({
          ...prev,
          [matchId]: {
            player_name: playerData?.last_name ?? violationData.discord_id,
            type: violationData.violation_type,
          },
        }));
      }
    }

    // Test: Lade erst mit allen Spalten
    const rTest = await supabase
      .from("match_rounds")
      .select("*")
      .eq("match_id", matchId)
      .limit(1);

    console.log("Rounds test query (all columns):", rTest);
    console.log("Sample round data:", rTest.data?.[0]);
    console.log("Round column names:", rTest.data?.[0] ? Object.keys(rTest.data[0]) : []);

    // Lade Runden - mit allen Spalten, da imposter_team_index nicht existiert
    const r = await supabase
      .from("match_rounds")
      .select("*")
      .eq("match_id", matchId)
      .order("round_no", { ascending: true });

    console.log("Rounds query for match", matchId, ":", r);
    console.log("Rounds error:", r.error);
    console.log("Rounds data:", r.data);

    // Lade alle Spieler für dieses Match
    const mp = await supabase
      .from("match_results")
      .select("discord_id,placement,total_points,elo_delta")
      .eq("match_id", matchId)
      .order("placement", { ascending: true });

    console.log("Match players query for match", matchId, ":", mp);
    console.log("Match players error:", mp.error);
    console.log("Match players data:", mp.data);

    if (!r.error) {
      const raw = (r.data ?? []) as unknown as any[];

      console.log("Processing rounds, sample:", raw[0]);

      // Für Duo-Matches: Lade Teams um zu wissen welcher Spieler zu welchem Team gehört
      let teamMapping: Map<string, number> = new Map(); // discord_id -> team_index
      
      if (meta?.mode === "duo") {
        const { data: teamsData } = await supabase
          .from("duo_teams")
          .select("team_index,captain_discord_id,member_discord_id")
          .eq("match_id", matchId);

        console.log("Teams for match:", teamsData);

        if (teamsData) {
          for (const team of teamsData) {
            teamMapping.set(String(team.captain_discord_id), team.team_index);
            teamMapping.set(String(team.member_discord_id), team.team_index);
          }
        }

        console.log("Team mapping:", teamMapping);
      }

      // Hole Spielernamen für alle Imposter in diesem Match (nur für Nicht-Duo)
      const imposterIds = [...new Set(raw.map(x => x.imposter_discord_id).filter(Boolean))];
      const { data: playersData } = await supabase
        .from("players")
        .select("discord_id,last_name")
        .in("discord_id", imposterIds);

      const playerNames = new Map<string, string>();
      (playersData ?? []).forEach((p: any) => {
        playerNames.set(p.discord_id, p.last_name ?? p.discord_id);
      });

      // Hole Kategorie-Namen separat
      const categoryIds = [...new Set(raw.map(x => x.category_id).filter(Boolean))];
      const { data: categoriesData } = await supabase
        .from("categories")
        .select("id,name")
        .in("id", categoryIds);

      const categoryNames = new Map<number, string>();
      (categoriesData ?? []).forEach((c: any) => {
        categoryNames.set(c.id, c.name);
      });

      const normalized: RoundRow[] = raw.map((x) => {
        // Für Duo: Bestimme Team-Index aus imposter_discord_id
        let imposterTeamIndex = null;
        if (meta?.mode === "duo" && x.imposter_discord_id) {
          imposterTeamIndex = teamMapping.get(String(x.imposter_discord_id)) ?? null;
        }

        return {
          id: Number(x.id),
          round_no: Number(x.round_no),
          word: x.word ?? null,
          winner: String(x.winner ?? ""),
          win_method: String(x.win_method ?? ""),
          imposter_discord_id: x.imposter_discord_id ?? null,
          imposter_team_index: imposterTeamIndex,
          imposter_name: x.imposter_discord_id ? playerNames.get(x.imposter_discord_id) ?? x.imposter_discord_id : null,
          points_imposter: Number(x.points_imposter ?? 0),
          points_unschuldig: Number(x.points_unschuldig ?? 0),
          aborted: Boolean(x.aborted),
          aborted_reason: x.aborted_reason ?? null,
          categoryName: x.category_id ? categoryNames.get(x.category_id) ?? null : null,
        };
      });

      console.log("Normalized rounds:", normalized);
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
        ranked_games_played: 0, // ✅ Wird gleich geladen
      }));

      // ✅ Lade ranked_games_played ZUM ZEITPUNKT DES MATCHES
      // Zähle wie viele Ranked-Matches der Spieler VOR diesem Match hatte
      const matchDate = meta?.started_at ? new Date(meta.started_at) : null;
      
      console.log("Match date for ranked_games_played calculation:", matchDate);
      
      const playersStatsAtMatchTime = new Map<string, number>();
      
      if (matchDate) {
        for (const playerId of allPlayerIds) {
          // Zähle Ranked-Matches VOR diesem Match
          const { count } = await supabase
            .from("match_results")
            .select("match_id,matches!inner(started_at,mode)", { count: "exact", head: true })
            .eq("discord_id", playerId)
            .eq("matches.mode", "ranked")
            .lt("matches.started_at", matchDate.toISOString());
          
          const rankedGamesCount = Number(count ?? 0);
          playersStatsAtMatchTime.set(playerId, rankedGamesCount);
          console.log(`Player ${playerId} had ${rankedGamesCount} ranked games before this match`);
        }
      }

      // ✅ Aktualisiere matchPlayers mit ranked_games_played zum Zeitpunkt des Matches
      matchPlayers.forEach((p) => {
        p.ranked_games_played = playersStatsAtMatchTime.get(p.discord_id) ?? 0;
        console.log(`Setting ranked_games_played for ${p.player_name} (${p.discord_id}): ${p.ranked_games_played}`);
      });

      // ✅ Berechne tatsächliche Platzierungen basierend auf Punktzahlen
      const actualPlacements = calculateActualPlacement(matchPlayers);
      matchPlayers.forEach((p) => {
        const actualPlacement = actualPlacements.get(p.placement);
        if (actualPlacement !== undefined) {
          p.placement = actualPlacement;
        }
      });

      setPlayersByMatch((prev) => ({ ...prev, [matchId]: matchPlayers }));
    }

    // Falls es ein Duo-Match ist, lade auch die Duo-Teams (meta wurde oben definiert)
    if (meta?.mode === "duo") {
      const duoTeams = await supabase
        .from("duo_teams")
        .select("team_index,captain_discord_id,member_discord_id,score,coins_earned")
        .eq("match_id", matchId)
        .order("score", { ascending: false });

      if (!duoTeams.error && duoTeams.data) {
        // Hole Namen für alle Spieler
        const allDuoPlayerIds = duoTeams.data.flatMap((t: any) => [t.captain_discord_id, t.member_discord_id]);
        const { data: duoPlayersData } = await supabase
          .from("players")
          .select("discord_id,last_name")
          .in("discord_id", allDuoPlayerIds);

        const duoPlayerNames = new Map<string, string>();
        (duoPlayersData ?? []).forEach((p: any) => {
          duoPlayerNames.set(p.discord_id, p.last_name ?? p.discord_id);
        });

        const duoMatchPlayers: MatchPlayerRow[] = [];
        duoTeams.data.forEach((team: any, idx: number) => {
          const placement = idx + 1;
          const coinsEarned = Number(team.coins_earned ?? 0);
          const score = Number(team.score ?? 0);
          const teamIndex = Number(team.team_index ?? 0);
          
          duoMatchPlayers.push({
            discord_id: team.captain_discord_id,
            player_name: duoPlayerNames.get(team.captain_discord_id) ?? team.captain_discord_id,
            placement: placement,
            total_points: score,
            elo_delta: 0,
            duo_coins_delta: coinsEarned,
            team_index: teamIndex,
          });
          
          duoMatchPlayers.push({
            discord_id: team.member_discord_id,
            player_name: duoPlayerNames.get(team.member_discord_id) ?? team.member_discord_id,
            placement: placement,
            total_points: score,
            elo_delta: 0,
            duo_coins_delta: coinsEarned,
            team_index: teamIndex,
          });
        });

        // ✅ Berechne tatsächliche Platzierungen basierend auf Scores
        // Gruppiere nach Team (beide Spieler haben gleiche Platzierung)
        const teamScores: { total_points: number; placement: number }[] = [];
        duoTeams.data.forEach((team: any, idx: number) => {
          teamScores.push({
            total_points: Number(team.score ?? 0),
            placement: idx + 1,
          });
        });
        
        const actualPlacements = calculateActualPlacement(teamScores);
        duoMatchPlayers.forEach((p) => {
          const actualPlacement = actualPlacements.get(p.placement);
          if (actualPlacement !== undefined) {
            p.placement = actualPlacement;
          }
        });

        setPlayersByMatch((prev) => ({ ...prev, [matchId]: duoMatchPlayers }));
      }
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
      <div className={`rounded-2xl p-6 ${headerEffects.className}`} style={headerEffects.style}>
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            <div className="text-xs text-zinc-400">Spieler</div>
            <div className="truncate text-2xl font-semibold text-zinc-100" style={{ textShadow: '0 0 3px black, 0 0 5px black, 1px 1px 2px black' }}>
              {player.last_name ?? "Unbenannt"}
            </div>
            <div className="mt-1 font-mono text-xs text-zinc-500">{player.discord_id}</div>
          </div>

          <div className="flex items-center gap-4">
            {/* Duo Coins */}
            <div className="flex items-center gap-4 rounded-2xl border border-orange-500/30 bg-gradient-to-br from-black via-orange-900/40 to-black shadow-lg shadow-orange-700/30 px-4 py-3">
              <div>
                <div className="text-xs text-zinc-400">Duo Coins</div>
                <div 
                  className="text-2xl font-bold animate-subtle-pulse animate-gold-flow"
                  style={{
                    fontFamily: '"Segoe UI", "Roboto", "Helvetica Neue", Arial, sans-serif',
                    backgroundImage: 'linear-gradient(135deg, #fbbf24, #f59e0b, #fef3c7, #f59e0b, #fbbf24)',
                    backgroundClip: 'text',
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                    letterSpacing: '0.02em',
                    filter: 'drop-shadow(0 0 3px rgba(0,0,0,0.9)) drop-shadow(0 0 6px rgba(0,0,0,0.7))',
                  }}
                >
                  {clamp(player.duo_coins)}
                </div>
              </div>
              <img src="/badges/Duocoin.png" alt="Duo Coin" className="h-16 w-auto object-contain" />
            </div>

            {/* Ranked */}
            <div className="flex items-center gap-4 rounded-2xl border border-zinc-800 bg-zinc-950/40 px-4 py-3">
              <div 
                className={`relative ${badgeEffects.className}`}
                style={badgeEffects.style}
              >
                <img src={rank.badge} alt={rank.label} className="h-28 w-auto object-contain" />
                {(rank.tier === "gold" || rank.tier === "platin" || rank.tier === "diamant" || rank.tier === "master") && (
                  <div 
                    className="absolute inset-0 pointer-events-none rounded-full"
                    style={{
                      background: 'linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.5) 50%, transparent 100%)',
                      backgroundSize: '200% 100%',
                      animation: 'light-reflection 10s ease-in-out infinite',
                      mixBlendMode: 'overlay',
                      maskImage: `url(${rank.badge})`,
                      WebkitMaskImage: `url(${rank.badge})`,
                      maskSize: 'contain',
                      WebkitMaskSize: 'contain',
                      maskRepeat: 'no-repeat',
                      WebkitMaskRepeat: 'no-repeat',
                      maskPosition: 'center',
                      WebkitMaskPosition: 'center',
                    }}
                  />
                )}
              </div>
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
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {/* Zwanglos Box */}
        <div className="rounded-xl border border-white/20 bg-gradient-to-br from-black via-gray-800/30 to-black shadow-lg shadow-white/10 p-6">
          <div className="text-sm font-semibold text-white/85">Zwanglos</div>
          <div className="mt-2 text-sm text-zinc-300">
            Spiele:{" "}
            <span className="font-semibold text-zinc-100">{clamp(player.games_casual)}</span>
          </div>
          <div className="mt-1 text-sm text-zinc-300">
            1. Plätze (volle Spiele):{" "}
            <span className="font-semibold text-zinc-100">{casualFullGameFirsts}</span>
          </div>
        </div>

        {/* Ranked Box */}
        <div className="rounded-xl border border-blue-500/30 bg-gradient-to-br from-black via-blue-900/40 to-black shadow-lg shadow-blue-700/30 p-6">
          <div className="text-sm font-semibold text-white/85">Ranked</div>
          <div className="mt-2 text-sm text-zinc-300">
            Spiele:{" "}
            <span className="font-semibold text-zinc-100">{rankedOverview.gr}</span>
          </div>
          <div className="mt-1 text-sm text-zinc-300">
            Imposter Winrate:{" "}
            <span className="font-semibold text-zinc-100">{pct(rankedRoleWinrates.impWR)}</span>
          </div>
          <div className="mt-1 text-sm text-zinc-300">
            Unschuldig Winrate:{" "}
            <span className="font-semibold text-zinc-100">{pct(rankedRoleWinrates.crewWR)}</span>
          </div>
        </div>

        {/* Duo Box */}
        <div className="rounded-xl border border-orange-500/30 bg-gradient-to-br from-black via-orange-900/40 to-black shadow-lg shadow-orange-700/30 p-6">
          <div className="text-sm font-semibold text-white/85">Duo</div>
          <div className="mt-2 text-sm text-zinc-300">
            Spiele:{" "}
            <span className="font-semibold text-zinc-100">{clamp(player.duo_games)}</span>
          </div>
          <div className="mt-1 text-sm text-zinc-300">
            Ø Platzierung:{" "}
            <span className="font-semibold text-zinc-100">
              {duoAvgPlacement !== null ? duoAvgPlacement.toFixed(2) : "—"}
            </span>
          </div>
        </div>
      </div>

      {/* Old Stats - kann entfernt werden */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3" style={{ display: 'none' }}>
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

      {/* Casual - kann entfernt werden */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6" style={{ display: 'none' }}>
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
                <th className="py-2">Elo/Coins</th>
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
                      <td className="py-2">
                        <span className="inline-block px-2 py-1 rounded text-xs font-semibold bg-gradient-to-r from-zinc-700/80 to-zinc-600/80 border border-zinc-400/40 text-zinc-100">
                          {fmtDateTime(meta?.started_at)}
                        </span>
                      </td>
                      <td className="py-2">
                        <span className={
                          meta?.mode === "ranked" 
                            ? "inline-block px-2 py-1 rounded text-xs font-semibold bg-gradient-to-r from-blue-900/60 to-blue-800/60 border border-blue-500/30 text-blue-100"
                            : meta?.mode === "duo"
                            ? "inline-block px-2 py-1 rounded text-xs font-semibold bg-gradient-to-r from-orange-900/60 to-orange-800/60 border border-orange-500/30 text-orange-100"
                            : "inline-block px-2 py-1 rounded text-xs font-semibold bg-gradient-to-r from-gray-800/60 to-gray-700/60 border border-gray-500/30 text-gray-100"
                        }>
                          {meta?.mode ?? "—"}
                        </span>
                        {meta?.aborted_reason && (() => {
                          const violation = violationsByMatch[row.match_id];
                          const tooltipText = violation 
                            ? `Abgebrochen wegen: ${formatAbortReason(meta.aborted_reason)} (${violation.player_name})`
                            : `Abgebrochen wegen: ${formatAbortReason(meta.aborted_reason)}`;
                          
                          return (
                            <span 
                              className="ml-2 inline-block text-orange-400 cursor-help"
                              title={tooltipText}
                            >
                              ⚠️
                            </span>
                          );
                        })()}
                      </td>
                      <td className="py-2">
                        {meta?.aborted_reason ? (
                          <span className="inline-flex items-center justify-center rounded-md border border-zinc-700 bg-black font-semibold h-8 w-8 text-xs text-zinc-400">
                            X
                          </span>
                        ) : row.placement ? (
                          <PlacementPill p={row.placement} />
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="py-2">
                        <span className="inline-block px-2 py-1 rounded text-xs font-semibold bg-gradient-to-r from-zinc-700/80 to-zinc-600/80 border border-zinc-400/40 text-zinc-100">
                          {row.total_points ?? "—"}
                        </span>
                      </td>
                      <td className="py-2">
                        {meta?.mode === "zwanglos" ? (
                          <span className="text-zinc-400">—</span>
                        ) : meta?.mode === "duo" ? (
                          (() => {
                            const coins = row.duo_coins_delta ?? 0;
                            if (coins === 0) {
                              return (
                                <span className="inline-block px-2 py-1 rounded text-xs font-semibold bg-gradient-to-r from-zinc-700/80 to-zinc-600/80 border border-zinc-400/40 text-zinc-400">
                                  0
                                </span>
                              );
                            }
                            return (
                              <span className="inline-block px-2 py-1 rounded text-xs font-semibold bg-gradient-to-r from-orange-900/60 to-orange-800/60 border border-orange-500/30 text-orange-100">
                                {coins >= 0 ? "+" : ""}{coins}
                              </span>
                            );
                          })()
                        ) : (typeof row.ranked_games_played === 'number' && row.ranked_games_played < 6) ? (
                          <span 
                            className="inline-block px-2 py-1 rounded text-xs font-semibold bg-gradient-to-r from-zinc-700/80 to-zinc-600/80 border border-zinc-400/40 text-zinc-100 cursor-help"
                            title="Elo nicht einsehbar weil der Spieler noch unranked ist"
                          >
                            ?
                          </span>
                        ) : (
                          (() => {
                            const elo = row.elo_delta ?? 0;
                            if (elo === 0) {
                              return (
                                <span className="inline-block px-2 py-1 rounded text-xs font-semibold bg-gradient-to-r from-zinc-700/80 to-zinc-600/80 border border-zinc-400/40 text-zinc-400">
                                  0
                                </span>
                              );
                            }
                            return (
                              <span className={
                                elo >= 0
                                  ? "inline-block px-2 py-1 rounded text-xs font-semibold bg-gradient-to-r from-green-900/60 to-green-800/60 border border-green-500/30 text-green-100"
                                  : "inline-block px-2 py-1 rounded text-xs font-semibold bg-gradient-to-r from-red-900/60 to-red-800/60 border border-red-500/30 text-red-100"
                              }>
                                {elo >= 0 ? "+" : ""}{elo}
                              </span>
                            );
                          })()
                        )}
                      </td>
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
                            {/* Match Info Header */}
                            <div className="flex items-center gap-3 px-4">
                              <span className="text-sm text-zinc-400">Modus:</span>
                              <span className={
                                meta?.mode === "ranked" 
                                  ? "inline-block px-3 py-1.5 rounded text-sm font-semibold bg-gradient-to-r from-blue-900/60 to-blue-800/60 border border-blue-500/30 text-blue-100"
                                  : meta?.mode === "duo"
                                  ? "inline-block px-3 py-1.5 rounded text-sm font-semibold bg-gradient-to-r from-orange-900/60 to-orange-800/60 border border-orange-500/30 text-orange-100"
                                  : "inline-block px-3 py-1.5 rounded text-sm font-semibold bg-gradient-to-r from-gray-800/60 to-gray-700/60 border border-gray-500/30 text-gray-100"
                              }>
                                {meta?.mode ?? "—"}
                              </span>
                              {meta?.aborted_reason && (() => {
                                const violation = violationsByMatch[row.match_id];
                                const abortText = violation 
                                  ? `Abgebrochen wegen: ${formatAbortReason(meta.aborted_reason)} (${violation.player_name})`
                                  : `Abgebrochen wegen: ${formatAbortReason(meta.aborted_reason)}`;
                                
                                return (
                                  <>
                                    <span className="text-orange-400">⚠️</span>
                                    <span className="text-sm text-orange-300">{abortText}</span>
                                  </>
                                );
                              })()}
                            </div>

                            {/* Runden-Tabelle */}
                            <div className="rounded-xl border border-zinc-800 bg-zinc-950/30 p-4">
                              <div className="mb-2 text-sm font-semibold text-zinc-100">Runden</div>
                              {roundsLoading[row.match_id] ? (
                                <div className="text-sm text-zinc-300">Lade Runden…</div>
                              ) : (() => {
                                const rounds = roundsByMatch[row.match_id] ?? [];
                                const matchMeta = Array.isArray((row as any).matches) ? (row as any).matches[0] : (row as any).matches;
                                const abortedReason = matchMeta?.aborted_reason;
                                const isAborted = Boolean(abortedReason);
                                
                                console.log('[DEBUG] Match ID:', row.match_id);
                                console.log('[DEBUG] Aborted Reason:', abortedReason);
                                console.log('[DEBUG] Is Aborted:', isAborted);
                                console.log('[DEBUG] Played Rounds:', rounds.length);
                                
                                // Bestimme maximale Rundenanzahl (5 für alle Modi)
                                const maxRounds = 5;
                                const playedRounds = rounds.length;
                                
                                // Erstelle Array mit allen Runden (gespielte + abgebrochene)
                                const allRounds: (RoundRow | { isAborted: true; round_no: number })[] = [...rounds];
                                
                                // Füge abgebrochene Runden hinzu wenn Spiel abgebrochen wurde
                                if (isAborted && playedRounds < maxRounds) {
                                  for (let i = playedRounds + 1; i <= maxRounds; i++) {
                                    allRounds.push({ isAborted: true, round_no: i });
                                  }
                                }
                                
                                if (allRounds.length === 0) {
                                  return <div className="text-sm text-zinc-400">Keine Rundendaten gefunden.</div>;
                                }
                                
                                return (
                                  <div className="overflow-x-auto">
                                    <table className="w-full text-sm">
                                      <thead className="text-xs text-zinc-400">
                                        <tr>
                                          <th className="text-left py-2 px-2">
                                            <span className="inline-block px-2 py-1 rounded text-xs font-semibold bg-gradient-to-r from-zinc-700/80 to-zinc-600/80 border border-zinc-400/40 text-zinc-100">
                                              Runde
                                            </span>
                                          </th>
                                          <th className="py-2 px-2">
                                            <span className="inline-block px-2 py-1 rounded text-xs font-semibold bg-gradient-to-r from-zinc-700/80 to-zinc-600/80 border border-zinc-400/40 text-zinc-100">
                                              Imposter
                                            </span>
                                          </th>
                                          <th className="py-2 px-2">
                                            <span className="inline-block px-2 py-1 rounded text-xs font-semibold bg-gradient-to-r from-zinc-700/80 to-zinc-600/80 border border-zinc-400/40 text-zinc-100">
                                              Gewinner
                                            </span>
                                          </th>
                                          <th className="py-2 px-2">
                                            <span className="inline-block px-2 py-1 rounded text-xs font-semibold bg-gradient-to-r from-zinc-700/80 to-zinc-600/80 border border-zinc-400/40 text-zinc-100">
                                              Methode
                                            </span>
                                          </th>
                                          <th className="py-2 px-2">
                                            <span className="inline-block px-2 py-1 rounded text-xs font-semibold bg-gradient-to-r from-zinc-700/80 to-zinc-600/80 border border-zinc-400/40 text-zinc-100">
                                              Kategorie
                                            </span>
                                          </th>
                                          <th className="py-2 px-2">
                                            <span className="inline-block px-2 py-1 rounded text-xs font-semibold bg-gradient-to-r from-zinc-700/80 to-zinc-600/80 border border-zinc-400/40 text-zinc-100">
                                              Wort
                                            </span>
                                          </th>
                                          <th className="py-2 px-2">
                                            <span className="inline-block px-2 py-1 rounded text-xs font-semibold bg-gradient-to-r from-zinc-700/80 to-zinc-600/80 border border-zinc-400/40 text-zinc-100">
                                              Punkte I
                                            </span>
                                          </th>
                                          <th className="py-2 px-2">
                                            <span className="inline-block px-2 py-1 rounded text-xs font-semibold bg-gradient-to-r from-zinc-700/80 to-zinc-600/80 border border-zinc-400/40 text-zinc-100">
                                              Punkte U
                                            </span>
                                          </th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {allRounds.map((rr) => {
                                          // Prüfe ob es eine abgebrochene Runde ist
                                          if ('isAborted' in rr && rr.isAborted) {
                                            return (
                                              <tr key={`aborted-${rr.round_no}`} className="border-t border-zinc-800 opacity-60">
                                                <td className="py-2 px-2">
                                                  <span className="inline-block px-2 py-1 rounded text-xs font-semibold bg-gradient-to-r from-zinc-700/80 to-zinc-600/80 border border-zinc-400/40 text-zinc-100">
                                                    {rr.round_no}
                                                  </span>
                                                </td>
                                                <td className="py-2 px-2" colSpan={7}>
                                                  <span className="inline-block px-2 py-1 rounded text-xs font-semibold bg-gradient-to-r from-orange-900/60 to-orange-800/60 border border-orange-500/30 text-orange-100">
                                                    Abgebrochen wegen: {formatAbortReason(abortedReason)}
                                                  </span>
                                                </td>
                                              </tr>
                                            );
                                          }
                                          
                                          // TypeScript weiß jetzt, dass rr vom Typ RoundRow ist
                                          const round = rr as RoundRow;
                                          
                                          // Normale gespielte Runde
                                          const pointsImposter = round.aborted ? 0 : (round.winner === "imposter" ? 2 : 0);
                                          const pointsUnschuldig = round.aborted ? 0 : (round.winner === "imposter" ? 0 : 1);
                                          
                                          const imposterDisplay = meta?.mode === "duo" && round.imposter_team_index != null
                                            ? `Team ${round.imposter_team_index + 1}`
                                            : (round.imposter_name ?? "—");
                                          
                                          return (
                                            <tr key={round.id} className={`border-t border-zinc-800 ${round.aborted ? 'opacity-50' : ''}`}>
                                              <td className="py-2 px-2">
                                                <span className="inline-block px-2 py-1 rounded text-xs font-semibold bg-gradient-to-r from-zinc-700/80 to-zinc-600/80 border border-zinc-400/40 text-zinc-100">
                                                  {round.round_no}{round.aborted ? ' ⚠️' : ''}
                                                </span>
                                              </td>
                                              <td className="py-2 px-2">
                                                <span className="inline-block px-2 py-1 rounded text-xs font-semibold bg-gradient-to-r from-red-900/60 to-red-800/60 border border-red-500/30 text-red-100">
                                                  {imposterDisplay}
                                                </span>
                                              </td>
                                              <td className="py-2 px-2">
                                                <span className="inline-block px-2 py-1 rounded text-xs font-semibold bg-gradient-to-r from-zinc-700/80 to-zinc-600/80 border border-zinc-400/40 text-zinc-100">
                                                  {round.aborted ? 'Abgebrochen' : winnerLabel(round.winner)}
                                                </span>
                                              </td>
                                              <td className="py-2 px-2">
                                                <span className="inline-block px-2 py-1 rounded text-xs font-semibold bg-gradient-to-r from-zinc-700/80 to-zinc-600/80 border border-zinc-400/40 text-zinc-100">
                                                  {round.aborted ? (round.aborted_reason ?? '—') : winMethodLabel(round.win_method)}
                                                </span>
                                              </td>
                                              <td className="py-2 px-2">
                                                <span className="inline-block px-2 py-1 rounded text-xs font-semibold bg-gradient-to-r from-zinc-700/80 to-zinc-600/80 border border-zinc-400/40 text-zinc-100">
                                                  {formatCategoryName(round.categoryName)}
                                                </span>
                                              </td>
                                              <td className="py-2 px-2">
                                                <span className="inline-block px-2 py-1 rounded text-xs font-semibold bg-gradient-to-r from-zinc-700/80 to-zinc-600/80 border border-zinc-400/40 text-zinc-100">
                                                  {round.word ?? "—"}
                                                </span>
                                              </td>
                                              <td className="py-2 px-2">
                                                <span className="inline-block px-2 py-1 rounded text-xs font-semibold bg-gradient-to-r from-zinc-700/80 to-zinc-600/80 border border-zinc-400/40 text-zinc-100">
                                                  {round.aborted ? '—' : pointsImposter}
                                                </span>
                                              </td>
                                              <td className="py-2 px-2">
                                                <span className="inline-block px-2 py-1 rounded text-xs font-semibold bg-gradient-to-r from-zinc-700/80 to-zinc-600/80 border border-zinc-400/40 text-zinc-100">
                                                  {round.aborted ? '—' : pointsUnschuldig}
                                                </span>
                                              </td>
                                            </tr>
                                          );
                                        })}
                                      </tbody>
                                    </table>
                                  </div>
                                );
                              })()}
                            </div>

                            {/* Spieler-Rangliste */}
                            <div className="rounded-xl border border-zinc-800 bg-zinc-950/30 p-4">
                              <div className="mb-2 text-sm font-semibold text-zinc-100">Spieler-Rangliste</div>
                              {roundsLoading[row.match_id] ? (
                                <div className="text-sm text-zinc-300">Lade Spieler…</div>
                              ) : (playersByMatch[row.match_id] ?? []).length === 0 ? (
                                <div className="text-sm text-zinc-400">Keine Spielerdaten gefunden.</div>
                              ) : meta?.mode === "duo" ? (
                                // Duo-Modus: Gruppiere nach Teams
                                <div className="overflow-x-auto">
                                  <table className="w-full text-sm">
                                    <thead className="text-xs text-zinc-400">
                                      <tr>
                                        <th className="text-left py-2">Team</th>
                                        <th className="text-left py-2">Spieler</th>
                                        <th className="text-center py-2">Punkte</th>
                                        <th className="text-center py-2">Coins</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {(() => {
                                        // Gruppiere Spieler nach team_index (nicht nach Platzierung!)
                                        const byTeam: Record<number, MatchPlayerRow[]> = {};
                                        (playersByMatch[row.match_id] ?? []).forEach((mp) => {
                                          const teamIdx = mp.team_index ?? 0;
                                          if (!byTeam[teamIdx]) byTeam[teamIdx] = [];
                                          byTeam[teamIdx].push(mp);
                                        });
                                        
                                        // Sortiere Teams nach Platzierung (niedrigste Platzierung zuerst)
                                        const sortedTeams = Object.entries(byTeam)
                                          .map(([teamIdx, players]) => ({
                                            teamIdx: Number(teamIdx),
                                            players,
                                            placement: players[0].placement, // Alle Spieler im Team haben gleiche Platzierung
                                          }))
                                          .sort((a, b) => a.placement - b.placement);
                                        
                                        return sortedTeams.map((team, displayIndex) => {
                                          const teamNumber = displayIndex + 1; // Team 1, 2, 3, 4 basierend auf Anzeigereihenfolge
                                          console.log(`[DUO TEAM] Placement: ${team.placement}, TeamIndex: ${team.teamIdx}, DisplayNumber: ${teamNumber}`);
                                          
                                          return team.players.map((mp, idx) => (
                                            <tr key={mp.discord_id} className="border-t border-zinc-800">
                                              {idx === 0 && (
                                                <td className="py-2" rowSpan={team.players.length}>
                                                  <div className="flex items-center gap-2">
                                                    {meta?.aborted_reason ? (
                                                      <span className="inline-flex items-center justify-center rounded-md border border-zinc-700 bg-black font-semibold h-8 w-8 text-xs text-zinc-400">
                                                        X
                                                      </span>
                                                    ) : (
                                                      <PlacementPill p={team.placement} />
                                                    )}
                                                    <span className="text-zinc-300">Team {teamNumber}</span>
                                                  </div>
                                                </td>
                                              )}
                                              <td className="py-2">
                                                <span className="inline-block px-2 py-1 rounded text-xs font-semibold bg-gradient-to-r from-zinc-700/80 to-zinc-600/80 border border-zinc-400/40">
                                                  <Link 
                                                    href={`/player/${encodeURIComponent(mp.discord_id)}`}
                                                    className="text-blue-400 hover:text-blue-300 hover:underline"
                                                  >
                                                    {mp.player_name}
                                                  </Link>
                                                </span>
                                              </td>
                                              {idx === 0 && (
                                                <>
                                                  <td className="py-2 text-center" rowSpan={team.players.length}>
                                                    <span className="inline-block px-2 py-1 rounded text-xs font-semibold bg-gradient-to-r from-zinc-700/80 to-zinc-600/80 border border-zinc-400/40 text-zinc-100">
                                                      {mp.total_points}
                                                    </span>
                                                  </td>
                                                  <td className="py-2 text-center" rowSpan={team.players.length}>
                                                    {(() => {
                                                      const coins = mp.duo_coins_delta ?? 0;
                                                      if (coins === 0) {
                                                        return (
                                                          <span className="inline-block px-2 py-1 rounded text-xs font-semibold bg-gradient-to-r from-zinc-700/80 to-zinc-600/80 border border-zinc-400/40 text-zinc-400">
                                                            0
                                                          </span>
                                                        );
                                                      }
                                                      return (
                                                        <span className="inline-block px-2 py-1 rounded text-xs font-semibold bg-gradient-to-r from-orange-900/60 to-orange-800/60 border border-orange-500/30 text-orange-100">
                                                          {coins >= 0 ? "+" : ""}{coins}
                                                        </span>
                                                      );
                                                    })()}
                                                  </td>
                                                </>
                                              )}
                                            </tr>
                                          ));
                                        });
                                      })()}
                                    </tbody>
                                  </table>
                                </div>
                              ) : (
                                // Ranked/Zwanglos: Normale Anzeige
                                <div className="overflow-x-auto">
                                  <table className="w-full text-sm">
                                    <thead className="text-xs text-zinc-400">
                                      <tr>
                                        <th className="text-left py-2">Platz</th>
                                        <th className="text-left py-2">Spieler</th>
                                        <th className="text-center py-2">Punkte</th>
                                        <th className="text-center py-2">Elo/Coins</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {(playersByMatch[row.match_id] ?? []).map((mp) => (
                                        <tr key={mp.discord_id} className="border-t border-zinc-800">
                                          <td className="py-2">
                                            {meta?.aborted_reason ? (
                                              <span className="inline-flex items-center justify-center rounded-md border border-zinc-700 bg-black font-semibold h-8 w-8 text-xs text-zinc-400">
                                                X
                                              </span>
                                            ) : mp.placement ? (
                                              <PlacementPill p={mp.placement} />
                                            ) : (
                                              "—"
                                            )}
                                          </td>
                                          <td className="py-2">
                                            <span className="inline-block px-2 py-1 rounded text-xs font-semibold bg-gradient-to-r from-zinc-700/80 to-zinc-600/80 border border-zinc-400/40">
                                              <Link 
                                                href={`/player/${encodeURIComponent(mp.discord_id)}`}
                                                className="text-blue-400 hover:text-blue-300 hover:underline"
                                              >
                                                {mp.player_name}
                                              </Link>
                                            </span>
                                          </td>
                                          <td className="py-2 text-center">
                                            <span className="inline-block px-2 py-1 rounded text-xs font-semibold bg-gradient-to-r from-zinc-700/80 to-zinc-600/80 border border-zinc-400/40 text-zinc-100">
                                              {mp.total_points}
                                            </span>
                                          </td>
                                          <td className="py-2 text-center">
                                            {(meta?.mode === "zwanglos") ? (
                                              <span className="text-zinc-400">—</span>
                                            ) : (mp.ranked_games_played !== undefined && mp.ranked_games_played < 6) ? (
                                              <span 
                                                className="inline-block px-2 py-1 rounded text-xs font-semibold bg-gradient-to-r from-zinc-700/80 to-zinc-600/80 border border-zinc-400/40 text-zinc-100 cursor-help"
                                                title="Elo nicht einsehbar weil der Spieler noch unranked ist"
                                              >
                                                ?
                                              </span>
                                            ) : (
                                              (() => {
                                                const elo = mp.elo_delta ?? 0;
                                                if (elo === 0) {
                                                  return (
                                                    <span className="inline-block px-2 py-1 rounded text-xs font-semibold bg-gradient-to-r from-zinc-700/80 to-zinc-600/80 border border-zinc-400/40 text-zinc-400">
                                                      0
                                                    </span>
                                                  );
                                                }
                                                return (
                                                  <span className={
                                                    elo >= 0
                                                      ? "inline-block px-2 py-1 rounded text-xs font-semibold bg-gradient-to-r from-green-900/60 to-green-800/60 border border-green-500/30 text-green-100"
                                                      : "inline-block px-2 py-1 rounded text-xs font-semibold bg-gradient-to-r from-red-900/60 to-red-800/60 border border-red-500/30 text-red-100"
                                                  }>
                                                    {elo >= 0 ? "+" : ""}{elo}
                                                  </span>
                                                );
                                              })()
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
