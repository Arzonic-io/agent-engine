"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { LuCircleCheck, LuCircleX } from "react-icons/lu";

type Tone = "success" | "error";
interface Toast {
  id: number;
  message: string;
  tone: Tone;
}

const ToastContext = createContext<(message: string, tone?: Tone) => void>(() => {});

/** Fire a transient confirmation toast. `useToast()(message)` — top-right, auto-dismiss. */
export function useToast(): (message: string, tone?: Tone) => void {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  const push = useCallback((message: string, tone: Tone = "success") => {
    const id = ++seq.current;
    setToasts((prev) => [...prev, { id, message, tone }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3200);
  }, []);

  const value = useMemo(() => push, [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed right-4 top-4 z-[100] flex w-72 flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="rise pointer-events-auto flex items-center gap-2.5 rounded-box border border-line bg-elev px-3.5 py-2.5 text-sm shadow-xl shadow-black/40"
          >
            {t.tone === "success" ? (
              <LuCircleCheck className="h-4 w-4 shrink-0 text-success" />
            ) : (
              <LuCircleX className="h-4 w-4 shrink-0 text-error" />
            )}
            <span className="text-fg/90">{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
