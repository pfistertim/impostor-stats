import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ discord_id: string }> }
) {
  const { discord_id } = await params;

  if (!discord_id) {
    return NextResponse.json(
      { ok: false, message: "discord_id fehlt" },
      { status: 400 }
    );
  }

  return NextResponse.json({
    ok: true,
    discord_id,
    message: "Route funktioniert",
  });
}
