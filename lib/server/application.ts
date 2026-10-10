import { dirname, resolve } from 'node:path';
import { getScenario } from '../content/scenarios';
import { FilePracticeStore } from './store';
import { SessionService } from './session-service';
import { HttpError } from './http';
import { capabilities } from './config';
import { inferenceReservations } from '../ai/policy';
import { getBillingService } from '../billing/application';
import { rolloutAdmissionPolicy } from './rollout';
import { admissionLimitsFromEnvironment } from '../interview-practice/admission';

let service: Promise<SessionService> | undefined;
export function getService(): Promise<SessionService> {
  service ??= (async () => {
    let store;
    if (process.env.DATABASE_URL) {
      const { PostgresPracticeStore } = await import('./postgres-store');
      store = new PostgresPracticeStore(process.env.DATABASE_URL);
    } else {
      if (process.env.NODE_ENV === 'production') throw new HttpError(503, 'storage_unconfigured', 'Hosted practice requires PostgreSQL. Local file storage is development-only.');
      const path = process.env.PRACTICE_DATA_PATH || './data/practice.json';
      store = new FilePracticeStore(dirname(resolve(path)));
    }
    const caps = capabilities();
    const reservations = caps.ai ? inferenceReservations() : { interviewer: 0, coach: 0, assistant: 0.08 };
    if (!caps.coaching) reservations.coach = 0;
    const billing = getBillingService();
    return new SessionService(store, getScenario, {
      admissionLimits: admissionLimitsFromEnvironment(process.env),
      maxSessionUsd: Number(process.env.MAX_SESSION_USD || 1),
      maxDailyUsd: Number(process.env.MAX_DAILY_USER_USD || 5),
      maxMonthlyUsd: Number(process.env.MAX_MONTHLY_USER_USD || 50),
      maxGlobalDailyUsd: Number(process.env.MAX_GLOBAL_DAILY_USD || 50),
      reservations,
      admissionPolicy: rolloutAdmissionPolicy(billing && 'currentTransactionClient' in store ? billing.admissionPolicy(store) : undefined)
    });
  })();
  return service.catch(error => { service = undefined; throw error; });
}
