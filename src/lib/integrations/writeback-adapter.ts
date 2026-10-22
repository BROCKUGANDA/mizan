/**
 * Write-back adapter — seam for returning verified corrections to source
 * systems. This is the "changing transactions automatically" area, and it is
 * INTENTIONALLY a stub that cannot act on its own.
 *
 * Red-line alignment (hard constraints, not comments):
 *  1. MIZAN never changes a transaction automatically. Every write-back is a
 *     PROPOSAL produced from a human-verified closure (status CLOSED with a
 *     source-system reference recorded by the analyst).
 *  2. The default transport is "proposals only": it renders a correction
 *     bundle and requires a human operator in the TARGET system to apply it.
 *  3. Even the future machine write-back (MIZAN_WRITEBACK=live) requires
 *     BOTH a proposal signed by the exception owner AND a countersignature,
 *     plus an idempotency key; there is no code path that bypasses humans.
 */

export type WritebackTransport = "proposals_only" | "human_approved_api";

export interface ProposedCorrection {
  proposalId: string;
  exceptionKey: string;
  targetSystem: string;
  targetEntity: string;
  /** Rendered, reviewable change: field, from → to, with the evidence hash that justifies it. */
  changes: { field: string; from: string; to: string; evidenceHash: string }[];
  createdBy: string;      // analyst who verified the fix
  verifiedBy: string;     // second pair of eyes (countersign for High/Critical)
  createdAt: string;
  status: "PENDING_HUMAN_ACTION" | "QUEUED_FOR_API" | "APPLIED_BY_TARGET" | "REJECTED_BY_TARGET";
}

export interface WritebackRequest {
  exceptionKey: string;
  targetSystem: string;
  targetEntity: string;
  changes: { field: string; from: string; to: string; evidenceHash: string }[];
  createdBy: string;
  verifiedBy: string;
  idempotencyKey: string;
}

export interface WritebackHealth {
  ok: boolean;
  transport: WritebackTransport;
  detail: string;
}

export interface WritebackAdapter {
  readonly id: "writeback";
  readonly label: string;
  health(): Promise<WritebackHealth>;
  /**
   * Turns a human-verified closure into a correction PROPOSAL. Never mutates
   * the target system. `proposals_only` returns the bundle for a human to
   * execute; `human_approved_api` would enqueue an outbox message that still
   * requires the target system's own approval workflow to accept it.
   */
  propose(req: WritebackRequest): Promise<ProposedCorrection>;
}

class WritebackStubAdapter implements WritebackAdapter {
  readonly id = "writeback" as const;
  readonly label = "Write-back — correction proposals (stub, humans apply)";

  private readonly proposals = new Map<string, ProposedCorrection>();

  async health(): Promise<WritebackHealth> {
    const transport = this.transport();
    return {
      ok: true,
      transport,
      detail:
        transport === "proposals_only"
          ? "stub: corrections are rendered as reviewable proposals; a human applies them in the target system. No automatic mutation is possible in any mode."
          : "human_approved_api: outbound messages carry the approver records and the target system's own workflow must accept them",
    };
  }

  async propose(req: WritebackRequest): Promise<ProposedCorrection> {
    if (req.changes.length === 0) {
      throw new Error("MZ-VAL-422: a write-back proposal needs at least one change");
    }
    if (req.createdBy === req.verifiedBy) {
      // Mirrors the countersign red line: no self-verification on write-backs.
      throw new Error("MZ-AUTH-403: the proposer and the verifier must be different people");
    }
    const proposalId = `WB-${Math.abs(hashStr(req.idempotencyKey)).toString(36).toUpperCase().slice(0, 10)}`;
    const existing = this.proposals.get(proposalId);
    if (existing) return existing; // idempotent
    const proposal: ProposedCorrection = {
      proposalId,
      exceptionKey: req.exceptionKey,
      targetSystem: req.targetSystem,
      targetEntity: req.targetEntity,
      changes: req.changes,
      createdBy: req.createdBy,
      verifiedBy: req.verifiedBy,
      createdAt: new Date().toISOString(),
      status: this.transport() === "proposals_only" ? "PENDING_HUMAN_ACTION" : "QUEUED_FOR_API",
    };
    this.proposals.set(proposalId, proposal);
    return proposal;
  }

  private transport(): WritebackTransport {
    return process.env.MIZAN_WRITEBACK === "human_approved_api" ? "human_approved_api" : "proposals_only";
  }
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

export const writebackAdapter: WritebackAdapter = new WritebackStubAdapter();
