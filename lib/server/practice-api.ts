import { InteractionService } from './interactions';
import { createPracticeApi } from './practice-dispatcher';
import { listPracticeScenarios } from '../content/scenarios';
import { requireActor } from './auth';
import { applicationOrigin, capabilities } from './config';
import { getService } from './application';
import { kickLocalWorker } from './worker';
import { handleVoiceRequest } from '../voice/api';
import { executionAdmissionOpen } from './operations';
import { ownerReviews, ownerReviewConsent } from './review-api';
import { getReviewService } from './review-service';
import { admittedScenarios } from './rollout';
import { withFoundryNavigation } from './foundry-navigation';
import { emitMutationTelemetry, emitTelemetry } from './telemetry';

/** Standalone composition retains its existing account, capability and worker policies. */
export const practiceApi = createPracticeApi({
  resolveActor: requireActor,
  getService, capabilities, origin: applicationOrigin,
  listScenarios: listPracticeScenarios, admittedScenarios,
  withNavigation: withFoundryNavigation,
  executionAdmissionOpen, notifyWorkAvailable: kickLocalWorker,
  interact: (service, ownerId, sessionId, input) => new InteractionService(service.store).interact(ownerId, sessionId, input),
  ownerReviews: (request, _ownerId, sessionId) => ownerReviews(request, sessionId),
  ownerReviewConsent: (request, _ownerId, caseId) => ownerReviewConsent(request, caseId),
  exportReviews: async (ownerId, sessionId) => (await getReviewService()).exportOwner(ownerId, sessionId),
  handleVoiceRequest, emitMutationTelemetry, emitTelemetry,
});
