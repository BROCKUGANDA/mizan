/**
 * Finance/ERP adapter — seam for Emirates' transaction systems of record
 * (SAP FI / Oracle Fusion class). STUB in the sandbox.
 *
 * Purpose: pull the transaction feed (expense claims, approvals, movements)
 * that the engine evaluates. Read-only: MIZAN never originates financial
 * postings; it observes and proposes.
 *
 * Red-line alignment:
 *  - Synthetic-only: the stub serves the same shape as the seeded dataset.
 *  - Amount semantics: fils-integer amounts cross this seam (floating-point
 *    money never enters the engine).
 */

export interface ErpTransaction {
  txnId: string;
  type: string;
  employeeId: string;
  amountFils: number;
  currency: "AED";
  effectiveDate: string;
  submittedAt: string;
  requesterId: string | null;
  approvals: { approverId: string; at: string; order: number }[];
  documents: { kind: string; sha256: string }[];
}

export interface ErpPage {
  transactions: ErpTransaction[];
  nextCursor: string | null;
  sourceHash: string;
}

export interface ErpHealth {
  ok: boolean;
  mode: "stub" | "live";
  detail: string;
}

export interface ErpAdapter {
  readonly id: "finance";
  readonly label: string;
  health(): Promise<ErpHealth>;
  listTransactions(opts?: { cursor?: string; limit?: number; businessDay?: string }): Promise<ErpPage>;
}

function seeded(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

const TYPES = ["EXPENSE_CLAIM", "ADVANCE", "ALLOWANCE", "ENTERTAINMENT", "TRAVEL", "PROCUREMENT"];

/**
 * STUB transport: deterministic synthetic transaction slice in the exact
 * canonical shape the engine ingests. Production: IDoc/OData pull with
 * watermark cursoring, signature-verified payloads, exactly-once inbox
 * dedup on txnId (see reliability NON-NEGOTIABLE #17).
 */
export class ErpStubAdapter implements ErpAdapter {
  readonly id = "finance" as const;
  readonly label = "Finance ERP — transaction feed (stub)";

  async health(): Promise<ErpHealth> {
    return {
      ok: true,
      mode: "stub",
      detail: process.env.MIZAN_ERP_URL
        ? "URL configured but MIZAN_ERP_MODE is not 'live' — serving synthetic shapes from the stub"
        : "stub: no MIZAN_ERP_URL configured; set MIZAN_ERP_MODE=live + MIZAN_ERP_URL + vault secret to integrate",
    };
  }

  async listTransactions(opts?: { cursor?: string; limit?: number; businessDay?: string }): Promise<ErpPage> {
    const limit = Math.min(Math.max(opts?.limit ?? 25, 1), 500);
    const offset = Number(opts?.cursor ?? "0") || 0;
    const day = opts?.businessDay ?? "2025-06-02";
    const rand = seeded(`erp-${day}-${offset}`);
    const transactions: ErpTransaction[] = [];
    for (let i = 0; i < limit; i++) {
      const n = offset + i;
      const amountDirhams = 50 + Math.floor(rand() * 20000);
      const approverCount = rand() > 0.7 ? 2 : 1;
      const hour = 7 + Math.floor(rand() * 11);
      const minute = Math.floor(rand() * 60);
      transactions.push({
        txnId: `TXN-${day.replaceAll("-", "")}-${String(n + 1).padStart(5, "0")}`,
        type: TYPES[Math.floor(rand() * TYPES.length)] ?? "EXPENSE_CLAIM",
        employeeId: `EMP-${String(100000 + Math.floor(rand() * 2000) * 37).padStart(6, "0")}`,
        amountFils: amountDirhams * 100,
        currency: "AED",
        effectiveDate: day,
        submittedAt: `${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+04:00`,
        requesterId: null,
        approvals: Array.from({ length: approverCount }).map((_, k) => ({
          approverId: `EMP-${String(100000 + Math.floor(rand() * 2000) * 37).padStart(6, "0")}`,
          at: `${day}T${String(hour + k).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+04:00`,
          order: k + 1,
        })),
        documents: rand() > 0.3 ? [{ kind: "receipt", sha256: `stub${Math.floor(rand() * 0xffffffff).toString(16)}` }] : [],
      });
    }
    return {
      transactions,
      nextCursor: offset + limit < 5000 ? String(offset + limit) : null,
      sourceHash: `stub-${day}-${(offset * 17 + limit).toString(16).padStart(8, "0")}`,
    };
  }
}

/** Production seam — implement against SAP FI / Oracle Fusion and register in registry.ts. */
export class ErpLiveAdapter implements ErpAdapter {
  readonly id = "finance" as const;
  readonly label = "Finance ERP — transaction feed (live)";
  constructor(private readonly baseUrl: string) {
    if (!/^https:\/\//.test(baseUrl)) throw new Error("MIZAN_ERP_URL must be https");
  }
  async health(): Promise<ErpHealth> {
    return { ok: false, mode: "live", detail: "live transport not provisioned in this environment" };
  }
  async listTransactions(): Promise<ErpPage> {
    throw new Error("MZ-DEP-503: ERP live transport is an integration point, not provisioned in the sandbox");
  }
}

export function getErpAdapter(): ErpAdapter {
  if (process.env.MIZAN_ERP_MODE === "live" && process.env.MIZAN_ERP_URL) {
    return new ErpLiveAdapter(process.env.MIZAN_ERP_URL);
  }
  return new ErpStubAdapter();
}
