/**
 * Money: integer fils only (AED × 100). NON-NEGOTIABLE: no floats on money paths.
 * Parsing rules per edge cases EC-B07/EC-G02/G-07 and normalisers §8.
 */

export type Fils = number; // integer; Number.isSafeInteger; AED × 100

const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
const PERSIAN_INDIC = "۰۱۲۳۴۵۶۷۸۹";

export interface ParsedAmount {
  fils: Fils | null;
  dq: "DQ-013" | null; // ambiguous / out of convention / >2 decimals
  negative: boolean;
}

/** Normalise Arabic-Indic / Persian digits and Arabic decimal/thousands separators to ASCII (EC-B06). */
export function normaliseDigits(s: string): string {
  let out = "";
  for (const ch of s) {
    const ai = ARABIC_INDIC.indexOf(ch);
    if (ai >= 0) { out += String(ai); continue; }
    const pi = PERSIAN_INDIC.indexOf(ch);
    if (pi >= 0) { out += String(pi); continue; }
    if (ch === "\u066B") { out += "."; continue; } // Arabic decimal separator ٫
    if (ch === "\u066C") { out += ","; continue; } // Arabic thousands separator ٬
    out += ch;
  }
  return out;
}

/**
 * Parse an amount string to integer fils.
 * decimalConvention per column: "dot" (1,234.56) | "comma" (1.234,56).
 * Parentheses or a trailing minus mean negative. Currency words/symbols are stripped.
 * Returns null when unparseable; dq=DQ-013 when ambiguous or more than 2 decimals.
 */
export function parseAmount(raw: string, decimalConvention: "dot" | "comma" = "dot"): ParsedAmount {
  const dq: "DQ-013" | null = null;
  let s = normaliseDigits(raw).trim();
  if (!s || s === "-" || s === "N/A" || s.toLowerCase() === "null") return { fils: null, dq: null, negative: false };
  let negative = false;
  // (1,200) → negative
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1).trim(); }
  // strip currency words and symbols
  s = s.replace(/AED|DHS?|DIRHAM(S)?|درهم|د\.إ|₹|\$|€|£/gi, "").trim();
  // scientific notation: 1.2e4
  const sci = /^([+-]?\d+(?:[.,]\d+)?)\s*[eE]\s*([+-]?\d+)$/.exec(s);
  if (sci) {
    const mantissa = sci[1]!.replace(decimalConvention === "dot" ? "," : ".", "");
    const value = Number(`${mantissa.replace(decimalConvention === "dot" ? "." : ",", ".")}e${sci[2]}`);
    if (!Number.isFinite(value)) return { fils: null, dq: "DQ-013", negative: false };
    const fils = Math.round(value * 100);
    return { fils: isSafeFils(fils) ? fils : null, dq: isSafeFils(fils) ? null : "DQ-013", negative: negative || value < 0 };
  }
  let negativeSuffix = false;
  if (s.endsWith("-")) { negativeSuffix = true; s = s.slice(0, -1).trim(); }
  if (s.startsWith("-")) { negative = true; s = s.slice(1).trim(); }
  // Decide separators. For "dot" convention: "," = thousands, "." = decimal. For "comma": vice versa.
  const thou = decimalConvention === "dot" ? "," : ".";
  const dec = decimalConvention === "dot" ? "." : ",";
  const parts = s.split(dec);
  let decimals = "";
  if (parts.length > 2) {
    // multiple decimal separators → ambiguous
    return { fils: null, dq: "DQ-013", negative };
  }
  if (parts.length === 2) {
    decimals = parts[1]!;
    if (decimals.length > 2) return { fils: null, dq: "DQ-013", negative };
    if (!/^\d{0,2}$/.test(decimals)) return { fils: null, dq: "DQ-013", negative };
  }
  const intPart = (parts[0] ?? "").replace(new RegExp(`\\${thou}`, "g"), "").replace(/\s/g, "");
  if (!/^\d+$/.test(intPart)) return { fils: null, dq: "DQ-013", negative };
  if (decimals && !/^\d{1,2}$/.test(decimals)) return { fils: null, dq: "DQ-013", negative };
  const intVal = parseInt(intPart, 10);
  const decVal = decimals ? parseInt(decimals.padEnd(2, "0"), 10) : 0;
  const filsVal = intVal * 100 + decVal;
  if (!isSafeFils(filsVal)) return { fils: null, dq: "DQ-013", negative };
  const isNegative = negative || negativeSuffix;
  return { fils: isNegative ? -filsVal : filsVal, dq: null, negative: isNegative };
}

export function isSafeFils(n: number): boolean {
  return Number.isSafeInteger(n) && Math.abs(n) <= 9_000_000_000_00; // AED 9bn guard
}

/**
 * Infer the decimal convention of a column from its values. A value with both
 * separators whose last separator has 1–2 trailing digits decides it; otherwise
 * dot (the pack convention) is the default and ambiguous values get DQ-013.
 */
export function inferDecimalConvention(values: string[]): "dot" | "comma" {
  let dot = 0;
  let comma = 0;
  for (const raw of values) {
    const s = normaliseDigits(raw).replace(/[^\d.,+\-()\s]/g, "").trim();
    if (!s) continue;
    const lastDot = s.lastIndexOf(".");
    const lastComma = s.lastIndexOf(",");
    if (lastDot >= 0 && lastComma >= 0) {
      if (lastComma > lastDot) comma++;
      else dot++;
      continue;
    }
    if (lastComma >= 0) {
      const after = s.length - lastComma - 1;
      if (after === 1 || after === 2) comma++;
      else if (after === 3 && s.split(",").length > 2) dot++;
    }
  }
  return comma > dot ? "comma" : "dot";
}

/** Group thousands with commas, independent of ICU/locale data (byte determinism). */
export function groupThousands(n: number): string {
  const s = String(Math.trunc(Math.abs(n)));
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ",";
    out += s[i];
  }
  return out;
}

/** Format fils as "14,500.00" (Western digits). */
export function formatAED(fils: Fils): string {
  const abs = Math.abs(fils);
  const whole = groupThousands(Math.floor(abs / 100));
  const frac = String(abs % 100).padStart(2, "0");
  return `${fils < 0 ? "-" : ""}${whole}.${frac}`;
}

/** AED display with currency, e.g. "AED 14,500.00". */
export function displayAED(fils: Fils): string {
  return `AED ${formatAED(fils)}`;
}
