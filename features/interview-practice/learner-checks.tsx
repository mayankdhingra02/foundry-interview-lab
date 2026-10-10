"use client";

import { useEffect, useRef, useState } from "react";
import { Play } from "lucide-react";
import { ErrorNotice } from "@/components/ui";
import { LEARNER_CHECK_POLICY as policy } from "@/lib/interview-practice/check-policy";
import type { TestRun } from "@/lib/interview-practice/types";
import "./learner-checks.css";

const starter = `import unittest\n\nclass RegressionChecks(unittest.TestCase):\n    def test_regression(self):\n        # Import your implementation and assert its intended behavior.\n        self.fail("Replace this placeholder with a regression assertion.")\n`;

function useSourceDigest(source: string) {
  const [result, setResult] = useState<{ source: string; sha256: string | null } | null>(null);
  useEffect(() => {
    let current = true;
    void Promise.resolve().then(async () => {
      const bytes = new TextEncoder().encode(source);
      const hash = await crypto.subtle.digest("SHA-256", bytes);
      const sha256 = [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, "0")).join("");
      if (current) setResult({ source, sha256 });
    }).catch(() => { if (current) setResult({ source, sha256: null }); });
    return () => { current = false; };
  }, [source]);
  return result?.source === source ? result : null;
}

export function LearnerChecksPanel({ source, savedSource, supported, readOnly, pending, retryPending, runner, latestRun, onChange, onSave, onRun }: {
  source?: string; savedSource?: string; supported: boolean; readOnly: boolean; pending: boolean; retryPending: boolean; runner: boolean; latestRun?: TestRun;
  onChange: (source: string) => void; onSave: () => Promise<unknown>; onRun: () => Promise<unknown>;
}) {
  const [error, setError] = useState(""); const editor = useRef<HTMLTextAreaElement>(null);
  const value = source ?? ""; const bytes = new TextEncoder().encode(value).length; const sourceDigest = useSourceDigest(value);
  const invalid = bytes > policy.maxSourceBytes || value.includes("\0");
  const saved = source !== undefined && source === savedSource;
  async function action(kind: "save" | "run") {
    if (readOnly || pending || invalid || (kind === "run" && retryPending)) return;
    setError("");
    try { await (kind === "save" ? onSave() : onRun()); } catch (e) { setError(e instanceof Error ? e.message : "The check action could not finish. Your source is retained."); }
  }
  return <details className="learner-checks-panel" aria-live="off">
    <summary>Your regression check</summary>
    {!supported ? <p>This saved authored package reserves the learner-check slot. Its original files and contracts are preserved; a separate learner check is unavailable.</p> : <>
      <p>Write Python <code>unittest.TestCase</code> checks in <code>{policy.path}</code>. This separate run uses only your check. The default Run tests button runs the authored scenario checks, including protected contracts.</p>
      <label htmlFor="learner-check-source">Your regression-check source</label>
      <textarea ref={editor} id="learner-check-source" value={value} onChange={event => { setError(""); onChange(event.target.value); }} readOnly={readOnly || pending} spellCheck={false} autoCapitalize="off" autoCorrect="off" wrap="off" rows={8} aria-describedby="learner-check-help learner-check-save" />
      <p id="learner-check-help">{bytes.toLocaleString()} / {policy.maxSourceBytes.toLocaleString()} UTF-8 bytes · {policy.timeoutSeconds} second check timeout · Tab moves to the next control. Define discovered unittest cases; printing a success message does not pass a check.</p>
      <p id="learner-check-save" role="status">{readOnly ? "This workspace is read only. Saved checks remain available for review." : source === undefined ? "Optional file not added. Nothing runs automatically." : saved ? "Check source matches the saved workspace." : "Unsaved regression-check changes. Run saves the full workspace before recording its snapshot."}</p>
      {invalid && <ErrorNotice message={value.includes("\0") ? "Remove the null character before saving or running this check. Your local source is retained." : `This source exceeds ${policy.maxSourceBytes.toLocaleString()} UTF-8 bytes. Shorten it before saving or running; your local source is retained.`} />}
      {error && <ErrorNotice message={error} />}
      {retryPending && <p>A learner run lost its response. Use Recover learner checks above to confirm its original result before starting another run. Later source edits remain separate.</p>}
      {!runner && <p>Saving remains available. A configured code runner is required to verify this check.</p>}
      <div className="learner-check-actions">
        {!value && <button className="button small" disabled={readOnly || pending} onClick={() => { setError(""); onChange(starter); editor.current?.focus(); }}>Insert failing unittest starter</button>}
        <button className="button small" disabled={readOnly || pending || invalid || saved || source === undefined} onClick={() => void action("save")}>Save check source</button>
        <button className="button small" disabled={readOnly || pending || retryPending || invalid || !runner || !value.trim()} onClick={() => void action("run")}><Play size={14} />Run my regression check</button>
      </div>
      {latestRun?.learnerCheck && <div className="learner-check-binding">
        <p>Latest learner run · Snapshot <code>{latestRun.snapshotSha256.slice(0, 12)}</code> · Source SHA-256 <code>{latestRun.learnerCheck.sourceSha256.slice(0, 12)}</code></p>
        <p>{sourceDigest === null ? "Comparing the check source with the recorded run…" : sourceDigest.sha256 === null ? "Source comparison is unavailable in this browser. Use the recorded source and snapshot references." : sourceDigest.sha256 === latestRun.learnerCheck.sourceSha256 ? "The check source matches that run. Other implementation files may have changed." : "The current check source differs from that run. Its result belongs to the recorded source and snapshot."}</p>
      </div>}
    </>}
  </details>;
}

export function CheckRunResults({ run }: { run: TestRun }) {
  const learner = Boolean(run.learnerCheck);
  return <section className="check-run-results" aria-label={learner ? "Learner-authored check result" : "Authored scenario check result"}>
    <h3>{learner ? "Your regression-check result" : "Authored scenario checks"}</h3>
    <div className="run-summary"><strong>{run.status === "infrastructure_error" ? "Execution unavailable" : run.status === "timeout" ? "Execution timed out" : `${run.tests.filter(test => test.status === "passed").length} / ${run.tests.length} ${learner ? "learner-authored " : "authored "}checks passed`}</strong><span>{(run.durationMs / 1000).toFixed(2)}s · {run.status.replaceAll("_", " ")}</span></div>
    {learner && <p>This run selected only your regression check. It does not establish that authored or protected scenario checks passed.</p>}
    {learner && run.tests.filter(test => test.status === "error" && test.detail).map(test => <ErrorNotice key={`error-${test.id}`} message={test.detail!} />)}
    {run.tests.map(test => <details className={`test-result ${test.status}`} key={test.id}><summary><span>{test.status === "passed" ? "✓" : test.status === "failed" ? "×" : "—"}</span>{test.title}<span className="muted">{test.status}</span></summary>{test.detail && <pre>{test.detail}</pre>}</details>)}
    {(run.stdout || run.stderr) && <details><summary>Execution logs</summary><pre>{run.stdout}{run.stderr ? `\n${run.stderr}` : ""}</pre></details>}
    <p className="run-reference">Run {run.id.slice(0, 8)} · Snapshot {run.snapshotSha256.slice(0, 12)}{run.learnerCheck && <> · Source SHA-256 {run.learnerCheck.sourceSha256.slice(0, 12)} · Learner policy {run.learnerCheck.executionPolicyVersion}</>}</p>
  </section>;
}
