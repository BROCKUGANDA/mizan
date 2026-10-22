"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes";

/**
 * Theme provider (next-themes) + projector theme toggle (§15) + accent packs
 * (Emirates vibe). Mode = light/dark/system/projector; accent = brand family
 * (emirates/oasis/pearl/dawn/majlis/saffron) applied as data-accent on <html>
 * so the Sadu strips, gold rules and brand marks all re-theme together.
 * Kept tiny so views stay presentational.
 */

type ThemeMode = "light" | "dark" | "system" | "projector";
export type Accent = "emirates" | "oasis" | "pearl" | "dawn" | "majlis" | "saffron";

export const ACCENTS: Accent[] = ["emirates", "oasis", "pearl", "dawn", "majlis", "saffron"];

interface ThemeCtx {
  mode: ThemeMode;
  setMode: (m: ThemeMode) => void;
  accent: Accent;
  setAccent: (a: Accent) => void;
}

const Ctx = createContext<ThemeCtx>({ mode: "system", setMode: () => undefined, accent: "emirates", setAccent: () => undefined });

/**
 * Mounts next-themes (attribute="class") around the MIZAN theme context so
 * setTheme actually lands on <html class="dark">. Without this wrapper the
 * useTheme() context is a no-op and dark mode silently does nothing.
 */
export function MizanThemeProviders({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <ThemeProvider>{children}</ThemeProvider>
    </NextThemesProvider>
  );
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>("system");
  const [accent, setAccent] = useState<Accent>("emirates");
  const { setTheme } = useTheme();

  useEffect(() => {
    const saved = window.localStorage.getItem("mizan-theme") as ThemeMode | null;
    const savedAccent = window.localStorage.getItem("mizan-accent") as Accent | null;
    queueMicrotask(() => {
      if (saved) {
        setMode(saved);
        applyMode(saved, setTheme);
      }
      if (savedAccent && ACCENTS.includes(savedAccent)) {
        setAccent(savedAccent);
        applyAccent(savedAccent);
      }
    });
  }, [setTheme]);

  const switchMode = (m: ThemeMode) => {
    setMode(m);
    applyMode(m, setTheme);
    window.localStorage.setItem("mizan-theme", m);
  };

  const switchAccent = (a: Accent) => {
    setAccent(a);
    applyAccent(a);
    window.localStorage.setItem("mizan-accent", a);
  };

  return <Ctx.Provider value={{ mode, setMode: switchMode, accent, setAccent: switchAccent }}>{children}</Ctx.Provider>;
}

function applyMode(mode: ThemeMode, setTheme: (t: string) => void): void {
  document.documentElement.classList.toggle("theme-projector", mode === "projector");
  setTheme(mode === "projector" ? "light" : mode);
}

function applyAccent(accent: Accent): void {
  if (accent === "emirates") {
    delete document.documentElement.dataset.accent;
  } else {
    document.documentElement.dataset.accent = accent;
  }
}

export const useMizanTheme = (): ThemeCtx => useContext(Ctx);
