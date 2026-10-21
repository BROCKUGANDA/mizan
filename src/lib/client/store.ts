"use client";

/**
 * Client API + app state: actor switcher, view router (single-page shell),
 * locale, notifications. TanStack Query wraps server state in views.
 */

import { create } from "zustand";

export type ViewKey = "overview" | "queue" | "runs" | "rules" | "patterns" | "audit" | "settings";

export interface AppState {
  view: ViewKey;
  setView: (v: ViewKey) => void;
  actor: string;
  setActor: (a: string) => void;
  selectedExceptionKey: string | null;
  setSelectedException: (k: string | null) => void;
  queueIndex: number;
  setQueueIndex: (i: number) => void;
  commandOpen: boolean;
  setCommandOpen: (v: boolean) => void;
  shortcutsOpen: boolean;
  setShortcutsOpen: (v: boolean) => void;
  notificationsOpen: boolean;
  setNotificationsOpen: (v: boolean) => void;
}

export const useAppStore = create<AppState>((set) => ({
  view: "overview",
  setView: (view) => set({ view }),
  actor: "analyst-a",
  setActor: (actor) => set({ actor }),
  selectedExceptionKey: null,
  setSelectedException: (selectedExceptionKey) => set({ selectedExceptionKey }),
  queueIndex: 0,
  setQueueIndex: (queueIndex) => set({ queueIndex }),
  commandOpen: false,
  setCommandOpen: (commandOpen) => set({ commandOpen }),
  shortcutsOpen: false,
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  notificationsOpen: false,
  setNotificationsOpen: (notificationsOpen) => set({ notificationsOpen }),
}));

export class ApiError extends Error {
  code: string;
  status: number;
  extra: Record<string, unknown>;
  constructor(code: string, status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

export async function api<T>(
  path: string,
  init?: Omit<RequestInit, "body"> & { actor?: string; body?: unknown; headers?: Record<string, string> }
): Promise<T> {
  const actor = init?.actor ?? useAppStore.getState().actor;
  const headers: Record<string, string> = { "x-mizan-actor": actor };
  let body = init?.body;
  if (body !== undefined && !(body instanceof FormData)) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(body);
  }
  const res = await fetch(path, {
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
    body: body as BodyInit | undefined,
  });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const problem = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
    throw new ApiError(
      String(problem.code ?? `HTTP-${res.status}`),
      res.status,
      String(problem.detail ?? problem.title ?? `Request failed (${res.status})`),
      problem
    );
  }
  return data as T;
}

/** Build an absolute API path under /api/v1. */
export const v1 = (p: string): string => `/api/v1${p}`;
