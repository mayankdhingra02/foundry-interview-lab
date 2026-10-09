import { dirname, resolve } from 'node:path';
import { getScenario } from '../content/scenarios';
import { FilePracticeStore } from './store';
import { SessionService } from './session-service';
import { HttpError } from './http';
import { capabilities } from './config';
import { inferenceReservations } from '../ai/policy';

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
    const ai = capabilities().ai;
    return new SessionService(store, getScenario, {
      maxSessionUsd: Number(process.env.MAX_SESSION_USD || 1),
      maxDailyUsd: Number(process.env.MAX_DAILY_USER_USD || 5),
      maxMonthlyUsd: Number(process.env.MAX_MONTHLY_USER_USD || 50),
      maxGlobalDailyUsd: Number(process.env.MAX_GLOBAL_DAILY_USD || 50),
      reservations: ai ? inferenceReservations() : { interviewer: 0, coach: 0, assistant: 0.08 }
    });
  })();
  return service.catch(error => { service = undefined; throw error; });
}
