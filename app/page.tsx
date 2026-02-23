"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type PlayerRow = {
  discord_id: string;
  last_name: string | null;
  elo_ranked: number | null;
  games_ranked: number | null;
  games_casual: number | null;
  wins_imposter_ranked: number | null;
  wins_imposter_casual: number | null;
  wins_crew_ranked: number | null;
  wins_crew_casual: number | null;
  duo_coins: number | null;
};

type LeaderRow = {
  discord_id: string;
  name: string;

  // Elo nur intern (wird bei Unranked nicht angezeigt)
  elo: number;

  // Unranked-Regel: games_ranked < 6
  gamesRanked: number;
  gamesCasual: number;

  gamesTotal: number;
  impWinsTotal: number;
  crewWinsTotal: number;

  last5Placements: number[];
};

type DuoLeaderRow = {
  discord_id: string;
  name: string;
  duoCoins: number;
  last5DuoPlacements: number[];
};

type RankInfo = {
  label: string;
  min: number;
  badgePath: string;
  isMaster?: boolean;
};

const RANKS: RankInfo[] = [
  { label: "Eisen I", min: 300, badgePath: "/badges/Eisen1.png" },
  { label: "Eisen II", min: 400, badgePath: "/badges/Eisen2.png" },
  { label: "Eisen III", min: 500, badgePath: "/badges/Eisen3.png" },

  { label: "Bronze I", min: 600, badgePath: "/badges/Bronze1.png" },
  { label: "Bronze II", min: 700, badgePath: "/badges/Bronze2.png" },
  { label: "Bronze III", min: 800, badgePath: "/badges/Bronze3.png" },

  { label: "Silber I", min: 900, badgePath: "/badges/Silber1.png" },
  { label: "Silber II", min: 1000, badgePath: "/badges/Silber2.png" },
  { label: "Silber III", min: 1100, badgePath: "/badges/Silber3.png" },

  { label: "Gold I", min: 1200, badgePath: "/badges/Gold1.png" },
  { label: "Gold II", min: 1300, badgePath: "/badges/Gold2.png" },
  { label: "Gold III", min: 1400, badgePath: "/badges/Gold3.png" },

  { label: "Platin I", min: 1500, badgePath: "/badges/Platin1.png" },
  { label: "Platin II", min: 1600, badgePath: "/badges/Platin2.png" },
  { label: "Platin III", min: 1700, badgePath: "/badges/Platin3.png" },

  { label: "Diamant I", min: 1800, badgePath: "/badges/Diamant1.png" },
  { label: "Diamant II", min: 1900, badgePath: "/badges/Diamant2.png" },
  { label: "Diamant III", min: 2000, badgePath: "/badges/Diamant3.png" },

  { label: "Master", min: 2100, badgePath: "/badges/Master.png", isMaster: true },
];

// Unranked = weniger als 6 ranked games -> Badge unranked, KEINE Elo-Zahl anzeigen
function getRankInfo(elo: number, gamesRanked: number) {
  if (gamesRanked < 6) {
    return {
      label: "Unranked",
      badgePath: "/badges/unranked.png",
      value: null as null,
      tier: "unranked" as const,
    };
  }

  let best = RANKS[0];
  for (const r of RANKS) if (elo >= r.min) best = r;

  const value = best.isMaster ? Math.max(0, elo - 2100) : ((elo % 100) + 100) % 100;
  
  // Bestimme Tier basierend auf Elo
  let tier: "unranked" | "eisen" | "bronze" | "silver" | "gold" | "platin" | "diamant" | "master" = "unranked";
  if (elo >= 2100) tier = "master";
  else if (elo >= 1800) tier = "diamant";
  else if (elo >= 1500) tier = "platin";
  else if (elo >= 1200) tier = "gold";
  else if (elo >= 900) tier = "silver";
  else if (elo >= 600) tier = "bronze";
  else if (elo >= 300) tier = "eisen";
  
  return { ...best, value, tier };
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
        style: {
          // Rainbow-Glow wird durch die Animation gesteuert
        },
      };
  }
}

function PlacementPill({ p }: { p: number }) {
  // Prüfe ob es eine .5 Platzierung ist
  const isHalf = p % 1 === 0.5;
  const lowerPlace = Math.floor(p);
  
  if (isHalf) {
    // Mische die Farben der beiden Plätze
    let mixedCls = "";
    let mixedStyle: any = {};
    
    if (p === 1.5) {
      // Gold + Silber Mix - mit subtiler Animation für Glanz (42% Gold, 38% Silber)
      mixedCls = "text-yellow-50 border-yellow-300/60 shadow-lg shadow-yellow-400/25";
      mixedStyle = {
        backgroundImage: 'linear-gradient(135deg, #fbbf24 0%, #f59e0b 14%, #fef3c7 28%, #fbbf24 42%, #d1d5db 62%, #f3f4f6 80%, #d1d5db 100%)',
        backgroundSize: '200% 200%',
        animation: 'gold-flow 8s ease-in-out infinite',
        textShadow: '0 0 2px rgba(0,0,0,0.8), 0 0 4px rgba(0,0,0,0.6)',
      };
    } else if (p === 2.5) {
      // Silber + Bronze Mix - mit subtiler Animation für Glanz
      mixedCls = "text-gray-50 border-gray-400/60 shadow-md shadow-gray-500/20";
      mixedStyle = {
        backgroundImage: 'linear-gradient(135deg, #d1d5db 0%, #9ca3af 20%, #f3f4f6 40%, #b45309 60%, #d97706 80%, #b45309 100%)',
        backgroundSize: '200% 200%',
        animation: 'silver-flow 8s ease-in-out infinite',
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
      // Fallback für andere .5 Platzierungen
      mixedCls = "text-red-50 border-red-700/60 shadow-md shadow-red-800/20";
      mixedStyle = {
        backgroundImage: 'linear-gradient(135deg, #991b1b, #7f1d1d, #450a0a, #7f1d1d, #991b1b)',
        textShadow: '0 0 2px rgba(0,0,0,0.8), 0 0 4px rgba(0,0,0,0.6)',
      };
    }
    
    // Subtile Animation für Glanz-Effekt
    const animationCls = "animate-subtle-pulse";
    
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
      ? "text-amber-50 border-amber-600/60 shadow-md shadow-amber-700/30"
      : "bg-gradient-to-br from-red-800 via-red-900 to-red-950 text-red-50 border-red-700/50";

  const metalStyle = 
    p === 1 ? {
      backgroundImage: 'linear-gradient(135deg, #fbbf24, #f59e0b, #fef3c7, #f59e0b, #fbbf24)',
      textShadow: '0 0 2px rgba(0,0,0,0.8), 0 0 4px rgba(0,0,0,0.6)',
    } : p === 2 ? {
      backgroundImage: 'linear-gradient(135deg, #d1d5db, #9ca3af, #f3f4f6, #9ca3af, #d1d5db)',
      textShadow: '0 0 2px rgba(0,0,0,0.8), 0 0 4px rgba(0,0,0,0.6)',
    } : p === 3 ? {
      backgroundImage: 'linear-gradient(135deg, #92400e, #b45309, #d97706, #f59e0b, #d97706, #b45309, #92400e)',
      backgroundSize: '200% 200%',
      animation: 'bronze-flow 8s ease-in-out infinite',
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
        p === 3 ? "animate-subtle-pulse" : "",
        cls,
      ].join(" ")}
      style={metalStyle}
    >
      {p}.
    </span>
  );
}

function DuoPlacementPill({ p }: { p: number }) {
  // Prüfe ob es eine .5 Platzierung ist
  const isHalf = p % 1 === 0.5;
  const lowerPlace = Math.floor(p);
  
  if (isHalf) {
    // Mische die Farben der beiden Plätze
    let mixedCls = "";
    let mixedStyle: any = {};
    
    if (p === 1.5) {
      // Gold + Silber Mix - mit subtiler Animation für Glanz (42% Gold, 38% Silber)
      mixedCls = "text-yellow-50 border-yellow-300/60 shadow-lg shadow-yellow-400/25";
      mixedStyle = {
        backgroundImage: 'linear-gradient(135deg, #fbbf24 0%, #f59e0b 14%, #fef3c7 28%, #fbbf24 42%, #d1d5db 62%, #f3f4f6 80%, #d1d5db 100%)',
        backgroundSize: '200% 200%',
        animation: 'gold-flow 8s ease-in-out infinite',
        textShadow: '0 0 2px rgba(0,0,0,0.8), 0 0 4px rgba(0,0,0,0.6)',
      };
    } else if (p === 2.5) {
      // Silber + Bronze Mix - mit subtiler Animation für Glanz
      mixedCls = "text-gray-50 border-gray-400/60 shadow-md shadow-gray-500/20";
      mixedStyle = {
        backgroundImage: 'linear-gradient(135deg, #d1d5db 0%, #9ca3af 20%, #f3f4f6 40%, #b45309 60%, #d97706 80%, #b45309 100%)',
        backgroundSize: '200% 200%',
        animation: 'silver-flow 8s ease-in-out infinite',
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
      // Fallback für andere .5 Platzierungen
      mixedCls = "text-red-50 border-red-700/60 shadow-md shadow-red-800/20";
      mixedStyle = {
        backgroundImage: 'linear-gradient(135deg, #991b1b, #7f1d1d, #450a0a, #7f1d1d, #991b1b)',
        textShadow: '0 0 2px rgba(0,0,0,0.8), 0 0 4px rgba(0,0,0,0.6)',
      };
    }
    
    // Subtile Animation für Glanz-Effekt
    const animationCls = "animate-subtle-pulse";
    
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
      ? "text-amber-50 border-amber-600/60 shadow-md shadow-amber-700/30"
      : "bg-gradient-to-br from-red-800 via-red-900 to-red-950 text-red-50 border-red-700/50";

  const metalStyle = 
    p === 1 ? {
      backgroundImage: 'linear-gradient(135deg, #fbbf24, #f59e0b, #fef3c7, #f59e0b, #fbbf24)',
      textShadow: '0 0 2px rgba(0,0,0,0.8), 0 0 4px rgba(0,0,0,0.6)',
    } : p === 2 ? {
      backgroundImage: 'linear-gradient(135deg, #d1d5db, #9ca3af, #f3f4f6, #9ca3af, #d1d5db)',
      textShadow: '0 0 2px rgba(0,0,0,0.8), 0 0 4px rgba(0,0,0,0.6)',
    } : p === 3 ? {
      backgroundImage: 'linear-gradient(135deg, #92400e, #b45309, #d97706, #f59e0b, #d97706, #b45309, #92400e)',
      backgroundSize: '200% 200%',
      animation: 'bronze-flow 8s ease-in-out infinite',
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
        p === 3 ? "animate-subtle-pulse" : "",
        cls,
      ].join(" ")}
      style={metalStyle}
    >
      {p}.
    </span>
  );
}

function MiniTable({
  title,
  rows,
  valueLabel,
  valueOf,
  top,
}: {
  title: string;
  rows: LeaderRow[];
  valueLabel: string;
  valueOf: (r: LeaderRow) => number;
  top: number;
}) {
  return (
    <div className="rounded-xl border border-white/20 bg-gradient-to-br from-black via-gray-800/30 to-black shadow-lg shadow-gray-700/20">
      <div className="px-3 py-2">
        <div className="text-sm font-semibold text-white/85">{title}</div>
      </div>
      <div className="divide-y divide-white/10">
        {rows.slice(0, top).map((r, i) => (
          <div key={r.discord_id} className="flex items-center gap-2 px-3 py-2">
            <div className="w-6 text-right text-sm text-white/55">{i + 1}</div>
            <div className="min-w-0 flex-1 truncate text-base text-white/90">{r.name}</div>
            <div className="text-sm text-white/65">
              {valueLabel} <span className="font-semibold text-white/90">{valueOf(r)}</span>
            </div>
          </div>
        ))}
        {rows.length === 0 && <div className="px-3 py-3 text-sm text-white/50">Keine Daten</div>}
      </div>
    </div>
  );
}

export default function Home() {
  const [q, setQ] = useState("");

  // Ranked: default 20, load more up to 200
  const [rankLimit, setRankLimit] = useState(20);

  // Mini tables: default 10, expand up to 100
  const [miniLimit, setMiniLimit] = useState(10);

  // Duo Coin Leaderboard: default 10, expand up to 100
  const [duoLimit, setDuoLimit] = useState(10);

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // Für Ranked-Liste (nur qualified)
  const [leaders, setLeaders] = useState<LeaderRow[]>([]);

  // Für Suche (alle Spieler)
  const [allPlayers, setAllPlayers] = useState<LeaderRow[]>([]);

  // Duo Coin Leaderboard
  const [duoLeaders, setDuoLeaders] = useState<DuoLeaderRow[]>([]);

  // Mini tables
  const [mostGames, setMostGames] = useState<LeaderRow[]>([]);
  const [mostImpWins, setMostImpWins] = useState<LeaderRow[]>([]);
  const [mostCrewWins, setMostCrewWins] = useState<LeaderRow[]>([]);

  useEffect(() => {
    let alive = true;

    async function load() {
      try {
        setLoading(true);
        setErr(null);

        // 1) Players holen
        const { data, error } = await supabase
          .from("players")
          .select(
            "discord_id,last_name,elo_ranked,games_ranked,games_casual,duo_games,wins_imposter_ranked,wins_imposter_casual,wins_crew_ranked,wins_crew_casual,duo_coins"
          )
          .limit(5000);

        if (error) throw new Error(error.message);

        const mapped: LeaderRow[] = (data ?? []).map((p: PlayerRow) => {
          const gamesRanked = Number(p.games_ranked ?? 0);
          const gamesCasual = Number(p.games_casual ?? 0);
          const gamesDuo = Number((p as any).duo_games ?? 0);

          const gamesTotal = gamesRanked + gamesCasual + gamesDuo;

          const impWinsTotal =
            Number(p.wins_imposter_ranked ?? 0) + Number(p.wins_imposter_casual ?? 0);
          const crewWinsTotal =
            Number(p.wins_crew_ranked ?? 0) + Number(p.wins_crew_casual ?? 0);

          return {
            discord_id: String(p.discord_id),
            name: (p.last_name ?? String(p.discord_id)) as string,
            elo: Number(p.elo_ranked ?? 0), // intern, nicht immer sichtbar
            gamesRanked,
            gamesCasual,
            gamesTotal,
            impWinsTotal,
            crewWinsTotal,
            last5Placements: [],
          };
        });

        // Für Suche: alle Spieler speichern
        if (!alive) return;
        setAllPlayers(mapped);

        // Berechne Runden-Siege aus round_player_points
        const allPlayerIds = mapped.map((p) => p.discord_id);
        
        if (allPlayerIds.length > 0) {
          const { data: roundPoints, error: rpErr } = await supabase
            .from("round_player_points")
            .select("discord_id,points")
            .in("discord_id", allPlayerIds);

          if (rpErr) throw new Error(rpErr.message);

          // Zähle Runden-Siege pro Spieler
          const roundWins: Record<string, { imposter: number; crew: number }> = {};
          
          for (const rp of roundPoints ?? []) {
            const did = String(rp.discord_id);
            const points = Number(rp.points);
            
            if (!roundWins[did]) {
              roundWins[did] = { imposter: 0, crew: 0 };
            }
            
            if (points === 2) {
              roundWins[did].imposter++;
            } else if (points === 1) {
              roundWins[did].crew++;
            }
          }

          // Aktualisiere mapped mit den echten Runden-Siegen
          for (const p of mapped) {
            if (roundWins[p.discord_id]) {
              p.impWinsTotal = roundWins[p.discord_id].imposter;
              p.crewWinsTotal = roundWins[p.discord_id].crew;
            }
          }
        }

        // Ranked Top 200: NUR ranked-qualified (>=6 ranked games)
        const rankedTop200 = [...mapped]
          .filter((p) => p.gamesRanked >= 6)
          .sort((a, b) => b.elo - a.elo)
          .slice(0, 200);

        const ids = rankedTop200.map((x) => x.discord_id);

        // 2) Letzte 5 Ranked-Platzierungen (nur für qualified Top200)
        let rankedWithPlacements = rankedTop200;

        if (ids.length > 0) {
          const { data: results, error: rErr } = await supabase
            .from("match_results")
            .select("discord_id,placement,total_points,match_id,matches!inner(started_at,mode,aborted_reason)")
            .in("discord_id", ids)
            .eq("matches.mode", "ranked")
            .limit(4000); // ✅ Lade ohne Sortierung, sortiere in JS

          if (rErr) throw new Error(rErr.message);

          // ✅ Sortiere in JavaScript nach started_at
          const sortedResults = (results ?? []).sort((a: any, b: any) => {
            const metaA = Array.isArray(a.matches) ? a.matches[0] : a.matches;
            const metaB = Array.isArray(b.matches) ? b.matches[0] : b.matches;
            const dateA = metaA?.started_at;
            const dateB = metaB?.started_at;
            if (!dateA || !dateB) return 0;
            return new Date(dateB).getTime() - new Date(dateA).getTime();
          });

          // ✅ Gruppiere nach Match-ID um tatsächliche Platzierungen zu berechnen
          const byMatch: Record<number, any[]> = {};
          for (const row of sortedResults) {
            const matchId = Number((row as any).match_id);
            if (!byMatch[matchId]) byMatch[matchId] = [];
            byMatch[matchId].push(row);
          }

          // ✅ Lade ALLE Spieler für diese Matches (nicht nur Top 200)
          const matchIds = Object.keys(byMatch).map(Number);
          const { data: allPlayersInMatches } = await supabase
            .from("match_results")
            .select("match_id,discord_id,total_points,placement")
            .in("match_id", matchIds);

          // Ersetze byMatch mit vollständigen Daten
          const completeByMatch: Record<number, any[]> = {};
          for (const row of allPlayersInMatches ?? []) {
            const matchId = Number(row.match_id);
            if (!completeByMatch[matchId]) completeByMatch[matchId] = [];
            completeByMatch[matchId].push(row);
          }

          // ✅ Berechne tatsächliche Platzierungen pro Match
          const actualPlacementsByMatch: Record<number, Map<string, number>> = {};
          for (const [matchId, players] of Object.entries(completeByMatch)) {
            const playersData = players.map((p: any) => ({
              discord_id: String(p.discord_id),
              total_points: Number(p.total_points ?? 0),
              placement: Number(p.placement ?? 0),
            }));
            
            // Sortiere nach Punkten
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

          const byPlayer: Record<string, number[]> = {};
          for (const row of sortedResults) {
            const did = String((row as any).discord_id);
            const matchId = Number((row as any).match_id);
            
            // ✅ Überspringe abgebrochene Matches
            const matchData = Array.isArray((row as any).matches) ? (row as any).matches[0] : (row as any).matches;
            if (matchData?.aborted_reason) continue;
            
            // ✅ Verwende tatsächliche Platzierung
            const actualPlacement = actualPlacementsByMatch[matchId]?.get(did) ?? Number((row as any).placement);
            
            if (!byPlayer[did]) byPlayer[did] = [];
            if (byPlayer[did].length < 5) byPlayer[did].push(actualPlacement);
          }

          rankedWithPlacements = rankedTop200.map((p) => ({
            ...p,
            last5Placements: byPlayer[p.discord_id] ?? [],
          }));
        }

        if (!alive) return;

        setLeaders(rankedWithPlacements);

        // Duo Coin Leaderboard: Top 100 nach duo_coins sortiert
        const duoTop100 = [...mapped]
          .map((p) => ({
            discord_id: p.discord_id,
            name: p.name,
            duoCoins: Number((data ?? []).find((d: PlayerRow) => String(d.discord_id) === p.discord_id)?.duo_coins ?? 0),
            last5DuoPlacements: [] as number[],
          }))
          .filter((p) => p.duoCoins > 0)
          .sort((a, b) => b.duoCoins - a.duoCoins)
          .slice(0, 100);

        const duoIds = duoTop100.map((x) => x.discord_id);

        // Letzte 5 Duo-Platzierungen berechnen aus duo_teams
        let duoWithPlacements = duoTop100;

        if (duoIds.length > 0) {
          // Hole alle Duo-Matches mit Teams
          const { data: duoMatches, error: duoErr } = await supabase
            .from("matches")
            .select("id,started_at,aborted_reason,duo_teams(team_index,captain_discord_id,member_discord_id,score)")
            .eq("mode", "duo")
            .order("started_at", { ascending: false })
            .limit(500);

          if (duoErr) {
            console.error("Duo matches error:", duoErr);
          } else {
            console.log("Duo matches loaded:", duoMatches?.length);
            
            // Für jeden Spieler: sammle Platzierungen
            const playerPlacements: Record<string, number[]> = {};
            
            for (const match of duoMatches ?? []) {
              // ✅ Überspringe abgebrochene Matches
              if ((match as any).aborted_reason) continue;
              
              const teams = (match as any).duo_teams ?? [];
              if (teams.length === 0) continue;
              
              // ✅ Berechne tatsächliche Platzierungen basierend auf Scores
              const teamData = teams.map((t: any, idx: number) => ({
                team_index: t.team_index,
                captain_discord_id: String(t.captain_discord_id),
                member_discord_id: String(t.member_discord_id),
                score: Number(t.score ?? 0),
                original_placement: idx + 1,
              }));
              
              // Sortiere nach Score
              const sorted = [...teamData].sort((a, b) => b.score - a.score);
              
              // Berechne tatsächliche Platzierungen
              const placementMap = new Map<number, number>(); // team_index -> actual placement
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
              
              // Vergebe Platzierungen an Spieler
              for (const team of teamData) {
                const placement = placementMap.get(team.team_index) ?? team.original_placement;
                const captain = team.captain_discord_id;
                const member = team.member_discord_id;
                
                // Nur für Spieler im Top 100
                if (duoIds.includes(captain)) {
                  if (!playerPlacements[captain]) playerPlacements[captain] = [];
                  if (playerPlacements[captain].length < 5) {
                    playerPlacements[captain].push(placement);
                  }
                }
                
                if (duoIds.includes(member)) {
                  if (!playerPlacements[member]) playerPlacements[member] = [];
                  if (playerPlacements[member].length < 5) {
                    playerPlacements[member].push(placement);
                  }
                }
              }
            }

            console.log("Player placements:", playerPlacements);

            duoWithPlacements = duoTop100.map((p) => ({
              ...p,
              last5DuoPlacements: playerPlacements[p.discord_id] ?? [],
            }));
          }
        }

        if (!alive) return;
        setDuoLeaders(duoWithPlacements);

        // Mini tables: basieren auf ALLEN Spielern
        setMostGames([...mapped].sort((a, b) => b.gamesTotal - a.gamesTotal));
        setMostImpWins([...mapped].sort((a, b) => b.impWinsTotal - a.impWinsTotal));
        setMostCrewWins([...mapped].sort((a, b) => b.crewWinsTotal - a.crewWinsTotal));
      } catch (e: any) {
        if (!alive) return;
        setErr(String(e?.message ?? e));
      } finally {
        if (!alive) return;
        setLoading(false);
      }
    }

    load();
    return () => {
      alive = false;
    };
  }, []);

  // Suche:
  // - Wenn q leer: zeige Ranked-Liste (leaders)
  // - Wenn q != leer: suche in ALLEN Spielern (allPlayers)
  const filteredAll = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return leaders;

    return allPlayers.filter(
      (p) =>
        p.name.toLowerCase().includes(s) || p.discord_id.toLowerCase().includes(s)
    );
  }, [q, leaders, allPlayers]);

  const filteredVisible = useMemo(() => {
    // Bei Suche limitieren wir ebenfalls (damit UI nicht explodiert)
    return filteredAll.slice(0, Math.min(rankLimit, 200));
  }, [filteredAll, rankLimit]);

  const canShowMoreRanked = filteredAll.length > rankLimit && rankLimit < 200;
  const canShowLessRanked = rankLimit > 20;

  const canShowMoreMini = miniLimit < 100;
  const canShowLessMini = miniLimit > 10;

  const canShowMoreDuo = duoLimit < 100;
  const canShowLessDuo = duoLimit > 10;

  const isSearching = q.trim().length > 0;

  return (
    <div className="min-h-screen bg-black text-white">
      <div className="mx-auto max-w-4xl px-4 py-8">
        {/* Header */}
        <div className="mb-5 flex items-center gap-3">
          <img src="/logo.png" alt="Logo" className="h-14 w-14 object-contain" />
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Imposter Stats</h1>
            <p className="text-sm text-white/60">Ranked • Suche • Mini-Toplisten</p>
          </div>
        </div>

        {/* Search */}
        <div className="mb-4 rounded-xl border border-white/10 bg-white/5 p-2">
          <input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setRankLimit(20);
            }}
            placeholder="Spieler suchen… (Name oder Discord-ID)"
            className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-base text-white outline-none placeholder:text-white/40"
          />
        </div>

        {/* Ranked/Suche Liste */}
        <div className="rounded-2xl border border-blue-500/30 bg-gradient-to-br from-black via-blue-900/40 to-black shadow-lg shadow-blue-700/30">
          <div className="flex items-center justify-between px-3 py-2">
            <div>
              <div className="text-base font-semibold text-white/90">
                {isSearching ? "Suche" : "Ranked Leaderboard"}
              </div>
              <div className="text-sm text-white/60">
                {Math.min(rankLimit, 200)} / {Math.min(filteredAll.length, 200)}
                {isSearching ? " Treffer" : ""}
              </div>
            </div>

            <div className="hidden sm:block text-sm text-white/60">
              {isSearching ? "Auch Unranked sichtbar" : "Letzte 5 Rank Platzierungen"}
            </div>
          </div>

          {err && <div className="px-3 pb-3 text-sm text-red-300">Fehler: {err}</div>}
          {loading && <div className="px-3 pb-3 text-sm text-white/50">Lade…</div>}

          <div className="divide-y divide-white/10">
            {filteredVisible.map((p, idx) => {
              const r = getRankInfo(p.elo, p.gamesRanked);
              const qualified = p.gamesRanked >= 6;
              const badgeEffects = getBadgeEffects(r.tier);

              return (
                <Link
                  key={p.discord_id}
                  href={`/player/${encodeURIComponent(p.discord_id)}`}
                  className="block"
                >
                  <div className="flex items-center gap-2 px-3 py-2 hover:bg-white/5 cursor-pointer">
                    {/* Platz: nur in Ranked anzeigen */}
                    <div className="w-8 text-right text-sm text-white/55">
                      {isSearching ? "—" : idx + 1}
                    </div>

                    {/* Badge */}
                    <div 
                      className={`relative h-15 w-12 shrink-0 ${badgeEffects.className}`}
                      style={badgeEffects.style}
                    >
                      <img
                        src={r.badgePath}
                        alt={r.label}
                        className="absolute left-0 top-0 h-14 w-11 object-contain pointer-events-none [transform:translate(6px,6px)_scale(2.4)] [transform-origin:center]"
                      />
                      {(r.tier === "gold" || r.tier === "platin" || r.tier === "diamant" || r.tier === "master") && (
                        <div 
                          className="absolute left-0 top-0 h-14 w-11 pointer-events-none [transform:translate(6px,6px)_scale(2.4)] [transform-origin:center]"
                          style={{
                            background: 'linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.5) 50%, transparent 100%)',
                            backgroundSize: '200% 100%',
                            animation: 'light-reflection 10s ease-in-out infinite',
                            mixBlendMode: 'overlay',
                            maskImage: `url(${r.badgePath})`,
                            WebkitMaskImage: `url(${r.badgePath})`,
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

                    {/* Name + Rank */}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-base font-semibold text-white/90">
                        {p.name}
                      </div>

                      <div className="text-sm text-white/70">
                        <span className="text-white/85">{r.label}</span>{" "}
                        {/* Elo-Ziffern nur wenn qualified */}
                        {qualified && r.value !== null && (
                          <span className="font-semibold text-white">{r.value}</span>
                        )}
                        {!qualified && (
                          <span className="text-white/50">
                            • {6 - p.gamesRanked} Ranked bis sichtbar
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Letzte 5 Platzierungen: nur in Ranked */}
                    <div className="hidden sm:flex items-center gap-1">
                      {!isSearching ? (
                        <>
                          {(p.last5Placements ?? []).slice(0, 5).map((pl, i) => (
                            <PlacementPill key={i} p={pl} />
                          ))}
                          {(!p.last5Placements || p.last5Placements.length === 0) && (
                            <span className="text-sm text-white/40">—</span>
                          )}
                        </>
                      ) : (
                        <span className="text-sm text-white/40">—</span>
                      )}
                    </div>
                  </div>
                </Link>
              );
            })}

            {!loading && filteredVisible.length === 0 && (
              <div className="px-3 py-4 text-sm text-white/60">
                {isSearching
                  ? "Keine Spieler gefunden."
                  : "Keine ranked-qualifizierten Spieler vorhanden."}
              </div>
            )}
          </div>

          {/* Mehr/Weniger Buttons */}
          <div className="flex items-center justify-between px-3 py-3">
            <div className="text-sm text-white/60">Standard: Top 20 • Max: Top 200</div>
            <div className="flex gap-2">
              {canShowLessRanked && (
                <button
                  onClick={() => setRankLimit(20)}
                  className="rounded-lg border border-white/10 bg-black/30 px-3 py-1.5 text-sm text-white/80 hover:bg-black/40"
                >
                  Weniger
                </button>
              )}
              {canShowMoreRanked && (
                <button
                  onClick={() => setRankLimit((v) => Math.min(200, v + 20))}
                  className="rounded-lg border border-white/10 bg-black/30 px-3 py-1.5 text-sm text-white/80 hover:bg-black/40"
                >
                  Mehr anzeigen
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Duo Coin Leaderboard */}
        <div className="mt-4 rounded-2xl border border-orange-500/30 bg-gradient-to-br from-black via-orange-900/40 to-black shadow-lg shadow-orange-700/30">
          <div className="flex items-center justify-between px-3 py-2">
            <div>
              <div className="text-base font-semibold text-white/90">Duo Leaderboard</div>
              <div className="text-sm text-white/60">
                Top {duoLimit} • Duo Coins & letzte 5 Duo Platzierungen
              </div>
            </div>

            <div className="hidden sm:block text-sm text-white/60">Letzte 5 Duo Platzierungen</div>
          </div>

          {err && <div className="px-3 pb-3 text-sm text-red-300">Fehler: {err}</div>}
          {loading && <div className="px-3 pb-3 text-sm text-white/50">Lade…</div>}

          <div className="divide-y divide-white/10">
            {duoLeaders.slice(0, duoLimit).map((p, idx) => (
              <Link
                key={p.discord_id}
                href={`/player/${encodeURIComponent(p.discord_id)}`}
                className="block"
              >
                <div className="flex items-center gap-2 px-3 py-2 hover:bg-white/5 cursor-pointer">
                  {/* Platz */}
                  <div className="w-8 text-right text-sm text-white/55">{idx + 1}</div>

                  {/* Name */}
                  <div className="min-w-0 flex-1 truncate text-base font-semibold text-white/90">
                    {p.name}
                  </div>

                  {/* Duo Coins Anzahl (Gold) */}
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
                    {p.duoCoins}
                  </div>

                  {/* Duo Coin Badge - kompakte Größe */}
                  <div className="h-10 w-10 shrink-0 flex items-center justify-center">
                    <img
                      src="/badges/Duocoin.png"
                      alt="Duo Coin"
                      className="h-10 w-10 object-contain"
                    />
                  </div>

                  {/* Letzte 5 Duo Platzierungen */}
                  <div className="hidden sm:flex items-center gap-1">
                    {(p.last5DuoPlacements ?? []).slice(0, 5).map((pl, i) => (
                      <DuoPlacementPill key={i} p={pl} />
                    ))}
                    {(!p.last5DuoPlacements || p.last5DuoPlacements.length === 0) && (
                      <span className="text-sm text-white/40">—</span>
                    )}
                  </div>
                </div>
              </Link>
            ))}

            {!loading && duoLeaders.length === 0 && (
              <div className="px-3 py-4 text-sm text-white/60">Keine Duo Coins vorhanden.</div>
            )}
          </div>

          {/* Mehr/Weniger Buttons */}
          <div className="flex items-center justify-between px-3 py-3">
            <div className="text-sm text-white/60">Standard: Top 10 • Max: Top 100</div>
            <div className="flex gap-2">
              {canShowLessDuo && (
                <button
                  onClick={() => setDuoLimit(10)}
                  className="rounded-lg border border-white/10 bg-black/30 px-3 py-1.5 text-sm text-white/80 hover:bg-black/40"
                >
                  Top 10
                </button>
              )}
              {canShowMoreDuo && (
                <button
                  onClick={() => setDuoLimit(100)}
                  className="rounded-lg border border-white/10 bg-black/30 px-3 py-1.5 text-sm text-white/80 hover:bg-black/40"
                >
                  Top 100
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Mini Tabellen + Toggle */}
        <div className="mt-4 flex items-center justify-between">
          <div className="text-base font-semibold text-white/85">Weitere Top Listen</div>
          <div className="flex gap-2">
            {canShowLessMini && (
              <button
                onClick={() => setMiniLimit(10)}
                className="rounded-lg border border-white/10 bg-black/30 px-3 py-1.5 text-sm text-white/80 hover:bg-black/40"
              >
                Top 10
              </button>
            )}
            {canShowMoreMini && (
              <button
                onClick={() => setMiniLimit(100)}
                className="rounded-lg border border-white/10 bg-black/30 px-3 py-1.5 text-sm text-white/80 hover:bg-black/40"
              >
                Top 100
              </button>
            )}
          </div>
        </div>

        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <MiniTable
            title="Meiste Spiele (gesamt)"
            rows={mostGames}
            valueLabel="Spiele:"
            valueOf={(r) => r.gamesTotal}
            top={miniLimit}
          />
          <MiniTable
            title="Meiste Imposter-Siege"
            rows={mostImpWins}
            valueLabel="Siege:"
            valueOf={(r) => r.impWinsTotal}
            top={miniLimit}
          />
          <MiniTable
            title="Meiste Unschuldigen-Siege"
            rows={mostCrewWins}
            valueLabel="Siege:"
            valueOf={(r) => r.crewWinsTotal}
            top={miniLimit}
          />
        </div>
      </div>
    </div>
  );
}
