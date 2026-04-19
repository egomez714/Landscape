"use client";

import { useEffect, useState } from "react";

type Health = {
  status: string;
  hd_key_loaded: boolean;
  gemini_key_loaded: boolean;
};

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

export default function Home() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API_BASE}/health`)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json();
      })
      .then(setHealth)
      .catch((e: Error) => setError(e.message));
  }, []);

  // TODO(hours 13-19): replace this with the Cytoscape graph component + search bar.
  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-8 gap-6">
      <h1 className="text-3xl font-semibold tracking-tight">Landscape</h1>
      <p className="text-sm text-[#8892b0]">Backend health check</p>
      <pre className="rounded-lg border border-white/10 bg-white/[0.04] px-5 py-4 text-sm font-mono">
        {error
          ? `error: ${error}`
          : health
            ? JSON.stringify(health, null, 2)
            : "loading…"}
      </pre>
    </main>
  );
}
