"use client";

export class ApiError extends Error {
  constructor(message: string, public status: number, public detail?: unknown) { super(message); }
}

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api/interview-practice${path}`, {
    credentials: "same-origin", cache: "no-store", ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(typeof data.error === "string" ? data.error : data.error?.message || data.message || "The request could not be completed.", response.status, data);
  return data as T;
}

export const requestId = () => crypto.randomUUID();
export async function ensureIdentity() {
  const response = await fetch("/api/auth/session", { cache: "no-store" });
  const auth = await response.json();
  if (auth.user) return auth;
  if (auth.authMode === "local") {
    const created = await fetch("/api/auth/local", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    if (created.ok) return created.json();
  }
  throw new Error(auth.authMode === "supabase" ? "Sign in to save a private practice session. Account access is available in Settings." : "Accounts are not configured for this deployment. Ask the operator to configure an account provider.");
}
export function formatDate(value: string) { return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); }
export function humanize(value: string) { return value.replaceAll("_", " ").replaceAll("-", " ").replace(/\b\w/g, (c) => c.toUpperCase()); }
export function downloadJson(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click(); URL.revokeObjectURL(url);
}
