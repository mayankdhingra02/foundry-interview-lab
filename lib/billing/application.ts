import { Pool } from 'pg';
import { billingConfiguration } from './config';
import { StripeBillingGateway } from './stripe';
import { BillingService } from './service';
let service: BillingService | undefined;
export function getBillingService(): BillingService | null {
  const configuration = billingConfiguration();
  if (!configuration) return null;
  service ??= new BillingService(new Pool({ connectionString: configuration.databaseUrl, max: 5, connectionTimeoutMillis: 5000 }), configuration, new StripeBillingGateway(configuration));
  return service;
}
