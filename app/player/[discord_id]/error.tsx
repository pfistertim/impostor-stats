"use client";

export default function Error({ error }: { error: Error }) {
  return (
    <div className="p-6 text-red-200">
      <div className="font-semibold">Profil-Fehler</div>
      <pre className="mt-3 whitespace-pre-wrap text-sm opacity-80">
        {error.message}
      </pre>
    </div>
  );
}
