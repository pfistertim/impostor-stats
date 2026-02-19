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
    };
  }

  let best = RANKS[0];
  for (const r of RANKS) if (elo >= r.min) best = r;

  const value = best.isMaster ? Math.max(0, elo - 2100) : ((elo % 100) + 100) % 100;
  return { ...best, value };
}

function PlacementPill({ p }: { p: number }) {
  const cls =
    p === 1
      ? "bg-green-900/70 text-green-50 border-green-700/50"
      : p === 2
      ? "bg-green-700/50 text-green-50 border-green-500/40"
      : p === 3
      ? "bg-red-700/40 text-red-50 border-red-500/40"
      : "bg-red-900/70 text-red-50 border-red-700/50";

  return (
    <span
      className={[
        "inline-flex items-center justify-center rounded-md border font-semibold",
        "h-8 w-8 text-xs",
        cls,
      ].join(" ")}
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
    <div className="rounded-xl border border-white/10 bg-white/5">
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

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // Für Ranked-Liste (nur qualified)
  const [leaders, setLeaders] = useState<LeaderRow[]>([]);

  // Für Suche (alle Spieler)
  const [allPlayers, setAllPlayers] = useState<LeaderRow[]>([]);

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
            "discord_id,last_name,elo_ranked,games_ranked,games_casual,wins_imposter_ranked,wins_imposter_casual,wins_crew_ranked,wins_crew_casual"
          )
          .limit(5000);

        if (error) throw new Error(error.message);

        const mapped: LeaderRow[] = (data ?? []).map((p: PlayerRow) => {
          const gamesRanked = Number(p.games_ranked ?? 0);
          const gamesCasual = Number(p.games_casual ?? 0);

          const gamesTotal = gamesRanked + gamesCasual;

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
            .select("discord_id,placement,matches!inner(started_at,mode)")
            .in("discord_id", ids)
            .eq("matches.mode", "ranked")
            .order("started_at", { foreignTable: "matches", ascending: false })
            .limit(4000);

          if (rErr) throw new Error(rErr.message);

          const byPlayer: Record<string, number[]> = {};
          for (const row of results ?? []) {
            const did = String((row as any).discord_id);
            const placement = Number((row as any).placement);
            if (!byPlayer[did]) byPlayer[did] = [];
            if (byPlayer[did].length < 5) byPlayer[did].push(placement);
          }

          rankedWithPlacements = rankedTop200.map((p) => ({
            ...p,
            last5Placements: byPlayer[p.discord_id] ?? [],
          }));
        }

        if (!alive) return;

        setLeaders(rankedWithPlacements);

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
        <div className="rounded-2xl border border-white/10 bg-white/5">
          <div className="flex items-center justify-between px-3 py-2">
            <div>
              <div className="text-base font-semibold text-white/90">
                {isSearching ? "Suche" : "Ranked"}
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
                    <div className="relative h-15 w-12 shrink-0">
                      <img
                        src={r.badgePath}
                        alt={r.label}
                        className="absolute left-0 top-0 h-14 w-11 object-contain pointer-events-none [transform:translate(6px,6px)_scale(2.4)] [transform-origin:center]"
                      />
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

        {/* Mini Tabellen + Toggle */}
        <div className="mt-4 flex items-center justify-between">
          <div className="text-base font-semibold text-white/85">Mini-Toplisten</div>
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
