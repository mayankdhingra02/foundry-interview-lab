/** Additive workspace policy, not part of historical authored scenario packages. */
export const LEARNER_CHECK_POLICY = { workspaceVersion: 1, executionVersion: 1, path: 'learner_checks.py', testId: 'learner-regression-v1', maxSourceBytes: 8_000, timeoutSeconds: 3 } as const;
export type RunSelection = 'authored' | 'learner';
export type LearnerCheckBinding = { workspacePolicyVersion: 1; executionPolicyVersion: 1; path: 'learner_checks.py'; sourceSha256: string };
