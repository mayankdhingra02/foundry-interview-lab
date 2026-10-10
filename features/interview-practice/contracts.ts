import type { PublicScenario, SessionView } from "@/lib/interview-practice/types";
export type Capabilities = { ai: boolean; coaching: boolean; runner: boolean; voice: boolean; billing: boolean; accounts: boolean; telemetry?: boolean; details?: Record<string, string> };
export type ScenarioResponse = { scenarios: PublicScenario[]; capabilities: Capabilities };
export type SessionResponse = { session: SessionView; scenario?: PublicScenario; capabilities?: Capabilities; job?: { id: string } };
export type HistoryResponse = { sessions: SessionView[] };
export type AuthResponse = { user: { id: string; email?: string; local: boolean } | null; authMode: "local" | "supabase" | "unconfigured" };
