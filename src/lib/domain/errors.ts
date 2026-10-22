/**
 * Typed errors: every error carries an MZ- code and a retryable flag (NON-NEGOTIABLE #16).
 * RFC 9457 problem+json shape on the wire. Lint forbids empty catch blocks.
 */

export type MzCode =
  | "MZ-AUTH-401"
  | "MZ-AUTH-403"
  | "MZ-AUTH-403-COI"
  | "MZ-RULE-403-SELF"
  | "MZ-VAL-422"
  | "MZ-DS-413"
  | "MZ-DS-415"
  | "MZ-DS-422"
  | "MZ-RULE-422"
  | "MZ-IDEM-409"
  | "MZ-IDEM-422"
  | "MZ-CONC-428"
  | "MZ-CONC-409"
  | "MZ-RUN-423"
  | "MZ-BULK-422"
  | "MZ-RATE-429"
  | "MZ-MODE-503"
  | "MZ-DEP-502"
  | "MZ-DEP-503"
  | "MZ-DEP-504"
  | "MZ-INT-500";

interface MzMeta {
  http: number;
  title: string;
  retryable: boolean;
}

export const MZ_CODES: Record<MzCode, MzMeta> = {
  "MZ-AUTH-401": { http: 401, title: "Not signed in or session expired", retryable: false },
  "MZ-AUTH-403": { http: 403, title: "Role or scope does not allow this", retryable: false },
  "MZ-AUTH-403-COI": { http: 403, title: "You are the requester, an approver or the beneficiary of this transaction", retryable: false },
  "MZ-RULE-403-SELF": { http: 403, title: "The author cannot approve their own rule version", retryable: false },
  "MZ-VAL-422": { http: 422, title: "Input failed validation", retryable: false },
  "MZ-DS-413": { http: 413, title: "File larger than 50 MB", retryable: false },
  "MZ-DS-415": { http: 415, title: "Not CSV or Markdown", retryable: false },
  "MZ-DS-422": { http: 422, title: "Required columns missing after mapping", retryable: false },
  "MZ-RULE-422": { http: 422, title: "RuleSpec invalid against the fact catalogue", retryable: false },
  "MZ-IDEM-409": { http: 409, title: "Same idempotency key still in progress", retryable: true },
  "MZ-IDEM-422": { http: 422, title: "Idempotency key reused with a different body", retryable: false },
  "MZ-CONC-428": { http: 428, title: "If-Match missing on a state change", retryable: false },
  "MZ-CONC-409": { http: 409, title: "This record changed since you opened it", retryable: false },
  "MZ-RUN-423": { http: 423, title: "Runs locked by safe halt", retryable: false },
  "MZ-BULK-422": { http: 422, title: "Bulk action violates the bulk limits", retryable: false },
  "MZ-RATE-429": { http: 429, title: "Rate limited", retryable: true },
  "MZ-MODE-503": { http: 503, title: "Read-only or maintenance mode", retryable: true },
  "MZ-DEP-502": { http: 502, title: "Dependency failed", retryable: true },
  "MZ-DEP-503": { http: 503, title: "Dependency unavailable", retryable: true },
  "MZ-DEP-504": { http: 504, title: "Dependency timed out", retryable: true },
  "MZ-INT-500": { http: 500, title: "Invariant violated; integrity incident opened", retryable: false },
};

export class MzError extends Error {
  readonly code: MzCode;
  readonly retryable: boolean;
  readonly status: number;
  readonly detail: string;
  readonly correlationId: string;
  readonly extra: Record<string, unknown>;

  constructor(code: MzCode, detail?: string, extra?: Record<string, unknown>) {
    const meta = MZ_CODES[code];
    super(meta.title);
    this.name = "MzError";
    this.code = code;
    this.status = meta.http;
    this.retryable = meta.retryable;
    this.detail = detail ?? meta.title;
    this.correlationId = generateCorrelationId();
    this.extra = extra ?? {};
  }

  toProblem(): Record<string, unknown> {
    return {
      type: `https://mizan.local/errors/${this.code}`,
      title: MZ_CODES[this.code].title,
      status: this.status,
      code: this.code,
      detail: this.detail,
      correlationId: this.correlationId,
      retryable: this.retryable,
      ...this.extra,
    };
  }
}

/** Short deterministic-ish correlation id for the sandbox (uses crypto when available). */
export function generateCorrelationId(): string {
  try {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch (e) {
    throw new MzError("MZ-INT-500", `entropy unavailable: ${String(e)}`);
  }
}

export function isMzError(e: unknown): e is MzError {
  return e instanceof MzError;
}

/** Wrap unknown errors; never leak internals. */
export function toMzError(e: unknown): MzError {
  if (isMzError(e)) return e;
  return new MzError("MZ-INT-500", e instanceof Error ? e.message : "Unknown error");
}
