"use client";

/**
 * useCountUpText — psychologically-retentive number reveal (§31 polish).
 *
 * Ref-driven: animates 0→target with ease-out cubic on requestAnimationFrame,
 * writing formatted text directly to the DOM node (no per-frame React
 * re-renders — cheaper and lint-clean under react-hooks/set-state-in-effect).
 *
 * - `format` runs every frame; pass iso(...) so Arabic-Indic digits work.
 * - `onUpdate` (optional) receives the raw eased value each frame — used to
 *   drive companion visuals (e.g. the readiness ring stroke) from one loop.
 * - Reduced-motion users skip straight to the final value.
 * - Live refetches animate from the currently displayed value, so the census
 *   "breathes" instead of snapping; re-renders re-sync the DOM node.
 */

import { useCallback, useEffect, useRef } from "react";
import { useReducedMotion } from "framer-motion";

export function useCountUpText<T extends HTMLElement = HTMLSpanElement>(
  target: number,
  format: (n: number) => string,
  options?: { durationMs?: number; onUpdate?: (v: number) => void },
): (el: T | null) => void {
  const reduceMotion = useReducedMotion();
  const durationMs = options?.durationMs ?? 900;
  const onUpdate = options?.onUpdate;

  const elRef = useRef<T | null>(null);
  const currentRef = useRef(0);
  const formatRef = useRef(format);
  const onUpdateRef = useRef(onUpdate);
  const animatingRef = useRef(false);
  const rafRef = useRef(0);

  const write = useCallback((v: number) => {
    const el = elRef.current;
    if (el) el.textContent = formatRef.current(v);
    onUpdateRef.current?.(v);
  }, []);

  // Attach: paint the current value immediately (no flash of empty text).
  const ref = useCallback(
    (el: T | null) => {
      elRef.current = el;
      if (el) write(currentRef.current);
    },
    [write],
  );

  // Every commit: latest format/onUpdate; re-sync the DOM when idle (covers
  // React re-render resets and locale switches).
  useEffect(() => {
    formatRef.current = format;
    onUpdateRef.current = onUpdate;
    if (!animatingRef.current) write(currentRef.current);
  });

  // Target/reduced-motion changes: run the animation loop.
  useEffect(() => {
    if (reduceMotion) {
      animatingRef.current = false;
      cancelAnimationFrame(rafRef.current);
      currentRef.current = target;
      write(target);
      return;
    }
    const from = currentRef.current;
    if (from === target) return;
    const t0 = performance.now();
    animatingRef.current = true;
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / durationMs);
      const eased = 1 - Math.pow(1 - p, 3);
      const v = from + (target - from) * eased;
      currentRef.current = v;
      write(v);
      if (p < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        currentRef.current = target;
        write(target);
        animatingRef.current = false;
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafRef.current);
      animatingRef.current = false;
    };
  }, [target, reduceMotion, durationMs, write]);

  return ref;
}
