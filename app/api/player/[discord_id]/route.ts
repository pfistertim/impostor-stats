import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY! // wichtig!
);

export async function GET(
  req: Request,
  { params }: { params: { discord_id: string } }
) {
  const discord_id = params.discord_id;

  if (!discord_id) {
    return NextResponse.json(
      { ok: false, error: "discord_id fehlt" },
      { status: 400 }
    );
  }

  const { data: player, error } = await supabase
    .from("players")
    .select("*")
    .eq("discord_id", discord_id)
    .single();

  // 🆕 Spieler existiert noch nicht
  if (!player) {
    return NextResponse.json({
      ok: true,
      player: {
        discord_id,
        elo_ranked: 1000,
        games_casual: 0,
        games_ranked: 0,
        rank_label: "Unranked",
        is_ranked_qualified: false,
      },
      is_new: true,
    });
  }

  // ✅ Spieler existiert
  return NextResponse.json({
    ok: true,
    player,
  });
}
