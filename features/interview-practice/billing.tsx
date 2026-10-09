"use client";

import { useEffect, useRef, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { ErrorNotice, Loading } from "@/components/ui";
import type { AuthResponse } from "./contracts";
import { humanize, requestId } from "./client";
import { parseBillingStatus, stripeDestination } from "./billing-contract";

export function BillingSettings({ enabled, auth }: { enabled: boolean | undefined; auth: AuthResponse | null }) {
  if (enabled === undefined || !auth) return <section className="settings-section wide"><h2>Billing and practice allowance</h2><p className="muted">Checking availability…</p></section>;
  if (!enabled) return <section className="settings-section wide"><h2>Billing and practice allowance</h2><p className="muted">Billing is not enabled for this deployment.</p></section>;
  if (!auth.user || auth.user.local) return <section className="settings-section wide"><h2>Billing and practice allowance</h2><p className="muted">{auth.user?.local ? "Billing requires a verified Engineering Foundry account. Local development accounts do not use checkout." : "Sign in to your Engineering Foundry account to view your practice allowance."}</p></section>;
  return <ConfiguredBilling key={auth.user.id} />;
}

function ConfiguredBilling() {
  const [status, setStatus] = useState<ReturnType<typeof parseBillingStatus> | null>(null);
  const [loading, setLoading] = useState(true); const [error, setError] = useState(""); const [busy, setBusy] = useState<"checkout" | "portal" | "">("");
  const pending = useRef(false); const keys = useRef<Partial<Record<"checkout" | "portal", string>>>({});
  function load(signal?: AbortSignal) {
    return fetch("/api/billing", { cache: "no-store", signal }).then(async response => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message || "Your practice allowance could not be loaded.");
      return parseBillingStatus(result);
    }).then(result => { if (!signal?.aborted) setStatus(result); })
      .catch((e: Error) => { if (e.name !== "AbortError") { setStatus(null); setError(e.message); } })
      .finally(() => { if (!signal?.aborted) setLoading(false); });
  }
  function refresh() { setLoading(true); setError(""); void load(); }
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, []);
  async function openBilling(action: "checkout" | "portal") {
    if (pending.current) return; pending.current = true; setBusy(action); setError("");
    const key = keys.current[action] || (keys.current[action] = requestId());
    try {
      const response = await fetch(`/api/billing/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: key }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message || "Billing could not be opened. Retry the same action.");
      window.location.assign(stripeDestination(result.url, action));
    } catch (e) { setError((e as Error).message); }
    finally { pending.current = false; setBusy(""); }
  }
  const canCheckout = status?.enabled && !status.blocked && ["none", "canceled", "incomplete_expired"].includes(status.subscriptionStatus);
  return <section className="settings-section wide" aria-labelledby="billing-heading"><h2 id="billing-heading">Billing and practice allowance</h2>{loading ? <Loading>Loading your practice allowance…</Loading> : <>{error && <ErrorNotice message={error} />}{status?.enabled ? <><dl className="capability-list billing-allowance"><div><dt>Practice sessions available</dt><dd>{status.remaining}</dd></div><div><dt>Free sessions remaining</dt><dd>{status.freeRemaining}</dd></div><div><dt>Paid sessions remaining</dt><dd>{status.paidRemaining}</dd></div><div><dt>Subscription</dt><dd>{status.subscriptionStatus === "none" ? "No subscription" : humanize(status.subscriptionStatus)}</dd></div>{status.periodEnd && <div><dt>Subscription period end</dt><dd>{new Date(status.periodEnd).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</dd></div>}</dl>{status.blocked && <p className="error-text" role="status">Billing needs attention before a new subscription can be opened. Your existing saved work remains available.</p>}<p className="muted">A new practice attempt uses one session from your available allowance. Deleting its private content does not restore that allowance.</p><div className="settings-data-actions">{canCheckout && <button className="button primary" disabled={Boolean(busy)} onClick={() => openBilling("checkout")}><ExternalLink size={16} aria-hidden="true" />{busy === "checkout" ? "Opening checkout…" : "Review subscription"}</button>}{status.hasCustomer && <button className="button" disabled={Boolean(busy)} onClick={() => openBilling("portal")}><ExternalLink size={16} aria-hidden="true" />{busy === "portal" ? "Opening billing…" : "Manage billing"}</button>}<button className="button" disabled={Boolean(busy)} onClick={() => refresh()}><RefreshCw size={16} aria-hidden="true" />Refresh allowance</button></div><p className="muted">Review price and payment terms in Stripe before purchasing. Payment confirmation can take a moment; refresh your allowance after returning.</p></> : status ? <p className="muted">Billing is not enabled for this deployment.</p> : <button className="button" onClick={() => refresh()}>Retry allowance</button>}</>}</section>;
}
