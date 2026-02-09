import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const token = process.env.BOT_INGEST_TOKEN ?? "";

  return NextResponse.json({
    ok: true,
    has_bot_ingest_token: token.length > 0,
    bot_ingest_token_length: token.length, // verrät NICHT den Token
    node_env: process.env.NODE_ENV ?? null,
  });
}
