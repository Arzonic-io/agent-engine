import type { ReactNode } from "react";
import { LuInbox, LuLoaderCircle, LuTriangleAlert } from "react-icons/lu";

/**
 * Consistent empty / error / loading states, so failures stop surfacing as raw
 * server text and empty lists read as intentional. Centred block with an icon,
 * a title, an optional hint, and an optional action (retry / link).
 */

function Shell({
  icon,
  title,
  hint,
  action,
  tone = "dim",
}: {
  icon: ReactNode;
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
  tone?: "dim" | "error";
}) {
  return (
    <div className="flex w-full flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <div
        className={`flex h-12 w-12 items-center justify-center rounded-full border border-line bg-elev ${
          tone === "error" ? "text-error" : "text-dim"
        }`}
      >
        {icon}
      </div>
      <div>
        <p className="text-sm font-medium text-fg/90">{title}</p>
        {hint && <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-dim">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

/** A failed load / action. Pass a short human message; a raw server string is fine as `hint`. */
export function ErrorState({
  title = "Noget gik galt",
  hint,
  action,
}: {
  title?: string;
  hint?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Shell
      tone="error"
      icon={<LuTriangleAlert className="h-5 w-5" />}
      title={title}
      hint={hint}
      action={action}
    />
  );
}

/** Nothing here yet — an intentional empty list, not a failure. */
export function EmptyState({
  title,
  hint,
  action,
  icon,
}: {
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <Shell icon={icon ?? <LuInbox className="h-5 w-5" />} title={title} hint={hint} action={action} />
  );
}

/** Centred spinner for a whole-view load. */
export function LoadingState({ label }: { label?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-dim">
      <LuLoaderCircle className="h-5 w-5 animate-spin" />
      {label && <span className="text-xs">{label}</span>}
    </div>
  );
}
