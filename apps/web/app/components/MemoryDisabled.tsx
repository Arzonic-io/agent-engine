import { LuBrain } from "react-icons/lu";

/**
 * Shown when the API reports project memory is off (missing SUPABASE_DB_URL /
 * MISTRAL_API_KEY). Without this the whole project flow 503'd raw, or worse fell
 * through to the create-form — which itself can't save. This names the exact
 * env vars to set instead.
 */
export function MemoryDisabled({ missions }: { missions: boolean }): React.ReactElement {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full border border-line bg-elev">
          <LuBrain className="h-6 w-6 text-dim" />
        </div>
        <h1 className="display text-2xl font-extrabold tracking-tight">
          Aktivér projekt-hukommelse
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-dim">
          Projekter, opgaver og missioner bygger på en database og en embeddings-model. Sæt disse
          i din <code className="rounded bg-elev px-1">.env</code> og genstart API'et:
        </p>
        <ul className="mt-4 space-y-1.5 text-left text-sm">
          <li className="flex items-center gap-2">
            <code className="rounded bg-elev px-1.5 py-0.5 text-xs">SUPABASE_DB_URL</code>
            <span className="text-dim">Postgres (pgvector) til projekter{missions ? " + missioner" : ""}</span>
          </li>
          <li className="flex items-center gap-2">
            <code className="rounded bg-elev px-1.5 py-0.5 text-xs">MISTRAL_API_KEY</code>
            <span className="text-dim">embeddings til hukommelsen</span>
          </li>
        </ul>
        <p className="mt-5 text-xs leading-relaxed text-dim">
          Se <code className="rounded bg-elev px-1">README.md</code> for docker-compose Postgres-opsætningen.
        </p>
      </div>
    </div>
  );
}
