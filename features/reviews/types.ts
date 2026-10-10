import type { ReviewCase } from '@/lib/interview-practice/types';
import type { ReviewService } from '@/lib/server/review-service';

export type OwnerCase = Omit<ReviewCase, 'ownerId'>;
export type CaseMetadata = Awaited<ReturnType<ReviewService['listCases']>>[number];
export type StaffStatus = Awaited<ReturnType<ReviewService['status']>>;
export type Inspection = Awaited<ReturnType<ReviewService['inspect']>>;
export type ScenarioPreview = Awaited<ReturnType<ReviewService['previewScenario']>>;
export type DeletionStatus = Awaited<ReturnType<ReviewService['deletionStatus']>>[number];

export function permissionActive(item: { consentExpiresAt: string | null; inspectionConsent: boolean; supportActionsConsent: boolean }, kind: 'inspection' | 'actions') {
  return Boolean((kind === 'inspection' ? item.inspectionConsent : item.supportActionsConsent) && item.consentExpiresAt && Date.parse(item.consentExpiresAt) > Date.now());
}
