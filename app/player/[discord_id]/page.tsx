import PlayerClient from "./PlayerClient";

type PageProps = {
  params: Promise<{ discord_id: string }>;
};

export default async function PlayerPage({ params }: PageProps) {
  const { discord_id } = await params;
  const discordId = decodeURIComponent(String(discord_id ?? "")).trim();

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="mx-auto w-full max-w-5xl px-4 py-8">
        <PlayerClient discordId={discordId} />
      </div>
    </main>
  );
}
