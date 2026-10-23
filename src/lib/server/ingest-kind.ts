export { MAX_FILE_BYTES } from "./ingest";
import { MzError } from "../domain/errors";

export type UploadKind = "transactions" | "employees" | "policy" | "finding_format";

/** Header-driven type detection with an explicit override. */
export function detectKind(requested: string, filename: string, buffer: Uint8Array): UploadKind {
  if (requested !== "auto") {
    if (!["transactions", "employees", "policy", "finding_format"].includes(requested)) throw new MzError("MZ-VAL-422", `Unknown dataset kind ${requested}.`);
    return requested as UploadKind;
  }
  if (filename.toLowerCase().endsWith(".md")) return "policy";
  const head = new TextDecoder("utf-8").decode(buffer.subarray(0, 2048)).toLowerCase();
  if (head.includes("finding_id") && head.includes("transaction_id") && head.includes("rule_id")) return "finding_format";
  if (head.includes("employee_id") && !head.includes("txn_id") && !head.includes("transaction_id")) return "employees";
  return "transactions";
}
