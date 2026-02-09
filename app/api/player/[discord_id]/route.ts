import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

type Context = {
  params: Promise<{
    discord_id: string;
  }>;
};

export async function GET(req: Request, context: Context) {
  try {
    const { discord_id } = await context.params;

    if (!discord_id) {
      return NextResponse.json(
        { ok: false, error: "missing_discord_id" },
        { status: 400 }
      );
    }

    const { data: player, error } = await supabaseAdmin
      .from("players")
      .select("*")
      .eq("discord_id", discord_id)
      .single();

    if (error || !player) {
      return NextResponse.json(
        { ok: false, error: "player_not_found" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      ok: true,
      player,
    });
  } catch (err: any) {
    console.error("GET /api/player error:", err);
    return NextResponse.json(
      { ok: false, error: "internal_error" },
      { status: 500 }
    );
  }
}
