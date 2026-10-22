/**
 * HRMS adapter — seam for Emirates' HR system of record (SAP SuccessFactors /
 * Oracle HCM class). STUB in the sandbox; production swaps the transport.
 *
 * Purpose: pull the employee master (grades, org placement, role attributes)
 * that rule evaluation joins against. MIZAN never writes back to the HRMS.
 *
 * Red-line alignment:
 *  - Synthetic-only: the stub serves the same shape as the seeded synthetic
 *    dataset. Live mode is disabled unless MIZAN_HRMS_MODE=live AND the
 *    tenant holder explicitly opts in (integration space, off by default).
 *  - Least data: only rule-relevant attributes are requested — never
 *    nationality, salary bank details, or free-text HR notes.
 */

export interface HrmsEmployee {
  employeeId: string;
  gradeRaw: string;
  gradeOrdinal: number | null;
  department: string;
  location: string;
  managerId: string | null;
  hireDate: string;
  exitDate: string | null;
  status: "ACTIVE" | "ON_LEAVE" | "EXITED";
  roles: string[];
}

export interface HrmsPage {
  employees: HrmsEmployee[];
  nextCursor: string | null;
  sourceHash: string;
}

export interface HrmsHealth {
  ok: boolean;
  mode: "stub" | "live";
  detail: string;
}

export interface HrmsAdapter {
  readonly id: "hrms";
  readonly label: string;
  health(): Promise<HrmsHealth>;
  listEmployees(opts?: { cursor?: string; limit?: number }): Promise<HrmsPage>;
}

/** Deterministic pseudo-random from a string seed (stable across calls). */
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

const GRADES = ["G1", "G2", "G3", "G4", "G5", "G6", "G7", "C1", "C2", "S1"];
const DEPTS = ["Cabin Crew", "Flight Ops", "Ground Services", "Engineering", "Commercial", "Finance", "Procurement", "HR"];
const LOCS = ["DXB-HQ", "DXB-T3", "Al Maktoum", "Sharjah", "Abu Dhabi", "Jebel Ali"];

/**
 * STUB transport: generates a deterministic synthetic slice of the employee
 * master. Production: OAuth2 client-credentials to the HRMS OData/REST API
 * with per-environment secrets from the vault, paged OData $skiptoken walks.
 */
export class HrmsStubAdapter implements HrmsAdapter {
  readonly id = "hrms" as const;
  readonly label = "HRMS — employee master (stub)";

  async health(): Promise<HrmsHealth> {
    return {
      ok: true,
      mode: "stub",
      detail: process.env.MIZAN_HRMS_URL
        ? "URL configured but MIZAN_HRMS_MODE is not 'live' — serving synthetic shapes from the stub"
        : "stub: no MIZAN_HRMS_URL configured; set MIZAN_HRMS_MODE=live + MIZAN_HRMS_URL + vault secret to integrate",
    };
  }

  async listEmployees(opts?: { cursor?: string; limit?: number }): Promise<HrmsPage> {
    const limit = Math.min(Math.max(opts?.limit ?? 25, 1), 200);
    const offset = Number(opts?.cursor ?? "0") || 0;
    const rand = seeded(`hrms-page-${offset}`);
    const employees: HrmsEmployee[] = [];
    for (let i = 0; i < limit; i++) {
      const n = offset + i;
      const gradeOrdinal = 1 + Math.floor(rand() * GRADES.length);
      const employeeId = `EMP-${String(100000 + n * 37).padStart(6, "0")}`;
      const hireYear = 2010 + Math.floor(rand() * 15);
      employees.push({
        employeeId,
        gradeRaw: GRADES[gradeOrdinal - 1] ?? "G1",
        gradeOrdinal,
        department: DEPTS[Math.floor(rand() * DEPTS.length)] ?? "Finance",
        location: LOCS[Math.floor(rand() * LOCS.length)] ?? "DXB-HQ",
        managerId: rand() > 0.2 ? `EMP-${String(100000 + Math.floor(rand() * 5000) * 37).padStart(6, "0")}` : null,
        hireDate: `${hireYear}-${String(1 + Math.floor(rand() * 12)).padStart(2, "0")}-${String(1 + Math.floor(rand() * 28)).padStart(2, "0")}`,
        exitDate: null,
        status: "ACTIVE",
        roles: rand() > 0.85 ? ["approver"] : ["requester"],
      });
    }
    const sourceHash = `stub-${(offset * 31 + limit).toString(16).padStart(8, "0")}`;
    return {
      employees,
      nextCursor: offset + limit < 2000 ? String(offset + limit) : null,
      sourceHash,
    };
  }
}

/** Production seam — implement against the real HRMS and register in registry.ts. */
export class HrmsLiveAdapter implements HrmsAdapter {
  readonly id = "hrms" as const;
  readonly label = "HRMS — employee master (live)";
  constructor(private readonly baseUrl: string) {
    if (!/^https:\/\//.test(baseUrl)) throw new Error("MIZAN_HRMS_URL must be https");
  }
  async health(): Promise<HrmsHealth> {
    // Not wired in the sandbox: outbound calls go through the retry helper +
    // breaker (NON-NEGOTIABLE #15/#17) and the model gateway de-identification pass.
    return { ok: false, mode: "live", detail: "live transport not provisioned in this environment" };
  }
  async listEmployees(): Promise<HrmsPage> {
    throw new Error("MZ-DEP-503: HRMS live transport is an integration point, not provisioned in the sandbox");
  }
}

export function getHrmsAdapter(): HrmsAdapter {
  if (process.env.MIZAN_HRMS_MODE === "live" && process.env.MIZAN_HRMS_URL) {
    return new HrmsLiveAdapter(process.env.MIZAN_HRMS_URL);
  }
  return new HrmsStubAdapter();
}
