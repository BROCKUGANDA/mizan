"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { useTheme } from "next-themes";

/**
 * Theme provider (next-themes) + projector theme toggle (§15).
 * Kept tiny so views stay presentational.
 */

type ThemeMode = "light" | "dark" | "system" | "projector";

interface ThemeCtx {
  mode: ThemeMode;
  setMode: (m: ThemeMode) => void;
}

const Ctx = createContext<ThemeCtx>({ mode: "system", setMode: () => undefined });

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>("system");
  const { setTheme } = useTheme();

  useEffect(() => {
    const saved = window.localStorage.getItem("mizan-theme") as ThemeMode | null;
    if (saved) {
      queueMicrotask(() => {
        setMode(saved);
        apply(saved, setTheme);
      });
    }
  }, [setTheme]);

  const switchTo = (m: ThemeMode) => {
    setMode(m);
    apply(m, setTheme);
    window.localStorage.setItem("mizan-theme", m);
  };

  return <Ctx.Provider value={{ mode, setMode: switchTo }}>{children}</Ctx.Provider>;
}

function apply(mode: ThemeMode, setTheme: (t: string) => void): void {
  document.documentElement.classList.toggle("theme-projector", mode === "projector");
  setTheme(mode === "projector" ? "light" : mode);
}

export const useMizanTheme = (): ThemeCtx => useContext(Ctx);
