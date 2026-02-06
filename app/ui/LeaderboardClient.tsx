"use client";

import { useMemo, useState } from "react";

export type LeaderboardEntry = {
  discord_id: string;
  name: string;
  elo: number;
  last5Placements: number[];
};

type RankInfo = {
  label: string;
  min: number;
  badgePath: string;
  isMaster?: boolean;
};

const RANKS: RankInfo[] = [
  { label: "Eisen I", min: 300, badgePath: "/badges/eisen1.png" },
  { label: "Eisen II", min: 400, badgePath: "/badges/eisen2.png" },
  { label: "Eisen III", min: 500, badgePath: "/badges/eisen3.png" },

  { label: "Bronze I", min: 600, badgePath: "/badges/bronze1.png" },
  { label: "Bronze II", min: 700, badgePath: "/badges/bronze2.png" },
  { label: "Bronze III", min: 800, badgePath: "/badges/bronze3.png" },

  { label: "Silber I", min: 900, badgePath: "/badges/silber1.png" },
  { label: "Silber II", min: 1000, badgePath: "/badges/silber2.png" },
  { label: "Silber III", min: 1100, badgePath: "/badges/silber3.png" },

  { label: "Gold I", min: 1200, badgePath: "/badges/gold1.png" },
  { label: "Gold II", min: 1300, badgePath: "/badges/gold2.png" },
  { label: "Gold III", min: 1400, badgePath: "/badges/gold3.png" },

  { label: "Platin I", min: 1500, badgePath: "/badges/platin1.png" },
  { label: "Platin II", min: 1600, badgePath: "/badges/platin2.png" },
  { label: "Platin III", min: 1700, badgePath: "/badges/platin3.png" },

  { label: "Diamant I", min: 1800, badgePath: "/badges/diamant1.png" },
  { label: "Diamant II", min: 1900, badgePath: "/badges/diamant2.png" },
  { label: "Diamant III", min: 2000, badgePath: "/badges/diamant3.png" },

  { label: "Master", min: 2100, badgePath: "/badges/master.png", isMaster: true },
];

function getRankInfo(elo: number) {
  let best = RANKS[0];
  for (const r of RANKS) {
    if (elo >= r.min) best = r;
  }

  // Rank-Punkte:
  // - bis unter Master: “letzte zwei Ziffern” (0–99)
  // - ab Master: Abstand zu 2100
  const rankPoints = best.isMaster ? Math.max(0, elo - 2100) : ((elo % 100) + 100) % 100;

  return { ...best, rankPoints };
}

function PlacementPill({ p }: { p: number }) {
  // Farben wie gewünscht:
  // 1 dunkelgrün, 2 hellgrün, 3 hellrot, 4 dunkelrot
  const cls =
    p === 1
      ? "bg-green-900/70 text-green-50 border-green-700/50"
      : p === 2
      ? "bg-green-700/50 text-green-50 border-green-500/40"
      : p === 3
      ? "bg-red-700/40 text-red-50 border-red-500/40"
      : "bg-red-900/70 text-red-50 border-red-700/50";

  return (
    <span className={`inline-flex h-7 w-7 items-center justify-center rounded-md border text-xs font-semibold ${cls}`}>
      {p}
    </span>
  );
}

export default function LeaderboardClient({ initial }: { initial: LeaderboardEntry[] }) {
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return initial;
    return initial.filter((p) => p.name.toLowerCase().includes(s) || p.discord_id.toLowerCase().includes(s));
  }, [q, initial]);

  return (
    <div className="space-y-6">
      {/* Search */}
      <div className="rounded-2xl border border-white/10 bg-white/5 p-4 shadow-sm">
        <label className="mb-2 block text-sm font-medium text-white/70">Spieler suchen</label>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Name oder Discord ID…"
          className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-white outline-none placeholder:text-white/40 focus:border-white/20"
        />
      </div>

      {/* Leaderboard */}
      <div className="rounded-2xl border border-white/10 bg-white/5 shadow-sm">
        <div className="flex items-center justify-between px-4 py-4">
          <div>
            <h2 className="text-lg font-semibold">Ranked Leaderboard</h2>
            <p className="text-sm text-white/60">Top 50 • Badge + Rank-Punkte • letzte 5 Platzierungen</p>
          </div>
          <div className="text-sm text-white/60">{filtered.length} Spieler</div>
        </div>

        <div className="divide-y divide-white/10">
          {filtered.map((p, idx) => {
            const r = getRankInfo(p.elo);
            return (
              <a
                key={p.discord_id}
                href={`/player/${encodeURIComponent(p.discord_id)}`}
                className="group flex items-center gap-4 px-4 py-3 hover:bg-white/5"
              >
                {/* Rank number */}
                <div className="w-8 text-right text-sm font-semibold text-white/60">{idx + 1}</div>

                {/* Badge */}
                <img
                  src={r.badgePath}
                  alt={r.label}
                  className="h-10 w-10 rounded-xl object-contain bg-black/40 p-1 border border-white/10"
                />

                {/* Name + Rank */}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-base font-semibold">{p.name}</div>
                  <div className="text-sm text-white/60">
                    <span className="font-medium text-white/80">{r.label}</span>
                    <span className="mx-2 text-white/30">•</span>
                    <span className="text-white/70">Punkte: </span>
                    <span className="font-semibold text-white">{r.rankPoints}</span>
                  </div>
                </div>

                {/* Last 5 placements */}
                <div className="hidden sm:flex items-center gap-1">
                  {(p.last5Placements ?? []).slice(0, 5).map((pl, i) => (
                    <PlacementPill key={i} p={pl} />
                  ))}
                  {(!p.last5Placements || p.last5Placements.length === 0) && (
                    <span className="text-xs text-white/40">keine Ranked Games</span>
                  )}
                </div>

                {/* Arrow */}
                <div className="text-white/30 group-hover:text-white/60">›</div>
              </a>
            );
          })}
        </div>
      </div>
    </div>
  );
}
