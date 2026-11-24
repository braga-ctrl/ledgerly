export interface Env {
  DB: D1Database;
  ADMIN_TOKEN?: string;
  CURRENCY: string;
  REQUIRED_CLIENT_DOCS: string;
}

export interface Ctx {
  db: D1Database;
  orgId: string;
  env: Env;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export type Args = Record<string, unknown>;

export const uid = () => crypto.randomUUID();

export const today = () => new Date().toISOString().slice(0, 10);

export function addDays(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  const a = Date.parse(from + "T00:00:00Z");
  const b = Date.parse(to + "T00:00:00Z");
  return Math.floor((b - a) / 86_400_000);
}

/** Money crosses the API boundary as decimal major units and is stored as integer cents. */
export const toCents = (n: number) => Math.round(n * 100);
export const toMajor = (cents: number) => Math.round(cents) / 100;

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomKey(prefix = "lgk_"): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return prefix + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- argument validation -------------------------------------------------

const bad = (msg: string) => new HttpError(400, msg);

export function reqStr(a: Args, k: string): string {
  const v = a[k];
  if (typeof v !== "string" || !v.trim()) throw bad(`"${k}" is required and must be a non-empty string`);
  return v.trim();
}

export function optStr(a: Args, k: string): string | undefined {
  const v = a[k];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw bad(`"${k}" must be a string`);
  return v.trim();
}

export function reqInt(a: Args, k: string, min = 1): number {
  const v = a[k];
  if (typeof v !== "number" || !Number.isInteger(v) || v < min) throw bad(`"${k}" must be a whole number >= ${min}`);
  return v;
}

export function optInt(a: Args, k: string, min: number, dflt: number): number {
  if (a[k] === undefined || a[k] === null) return dflt;
  return reqInt(a, k, min);
}

export function reqMoney(a: Args, k: string, allowZero = false): number {
  const v = a[k];
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || (!allowZero && v === 0))
    throw bad(`"${k}" must be a ${allowZero ? "non-negative" : "positive"} number`);
  return toCents(v);
}

export function optMoney(a: Args, k: string, dflt = 0): number {
  if (a[k] === undefined || a[k] === null) return dflt;
  return reqMoney(a, k, true);
}

export function optDate(a: Args, k: string): string | undefined {
  const v = optStr(a, k);
  if (v === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw bad(`"${k}" must be a date like 2026-11-24`);
  return v;
}

export function reqArray(a: Args, k: string): Record<string, unknown>[] {
  const v = a[k];
  if (!Array.isArray(v) || v.length === 0) throw bad(`"${k}" must be a non-empty array`);
  for (const item of v) if (typeof item !== "object" || item === null) throw bad(`"${k}" items must be objects`);
  return v as Record<string, unknown>[];
}
