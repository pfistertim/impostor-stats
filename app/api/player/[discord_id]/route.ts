import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { discord_id: string } }
) {
  return NextResponse.json({
    ok: true,
    message: "PLAYER ROUTE IS WORKING",
    discord_id: params.discord_id,
  });
}
