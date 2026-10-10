export function enabled(name: string, fallback = false): boolean {
  const value = process.env[name];
  return value === undefined ? fallback : value === 'true';
}

export function authMode(): 'local' | 'supabase' | 'unconfigured' {
  if (process.env.AUTH_MODE === 'local' && process.env.NODE_ENV !== 'production') return 'local';
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) return 'supabase';
  return 'unconfigured';
}

export function capabilities() {
  const ai = enabled('FEATURE_AI_INTERVIEW', true) && Boolean(process.env.OPENAI_API_KEY);
  const runnerMode = process.env.RUNNER_MODE || 'docker';
  const runner = enabled('FEATURE_EXECUTION', true) && (runnerMode === 'docker' ||
    (runnerMode === 'remote' && Boolean(process.env.RUNNER_URL && process.env.RUNNER_AUTH_TOKEN)));
  return {
    ai, interviewer: ai, assistant: ai, runner, accounts: authMode() === 'supabase',
    voice: enabled('FEATURE_VOICE') && Boolean(process.env.DEEPGRAM_API_KEY),
    billing: enabled('FEATURE_BILLING') && Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID),
    authMode: authMode(),
    details: {
      ai: ai ? 'Configured model inference. Quality qualification is tracked separately.' : 'Authored questions and observation-only reports; AI assistance is unavailable.',
      runner: runner ? `${runnerMode} execution adapter configured. Runtime health is checked on each run.` : 'Execution is unavailable. Saved work remains accessible.',
      voice: 'Optional voice uses confirmed transcript turns. Text participation is always available.'
    }
  };
}

export function applicationOrigin(): string {
  const url = process.env.APP_URL || (process.env.NODE_ENV !== 'production' ? 'http://127.0.0.1:3000' : '');
  if (!url) throw new Error('APP_URL must be configured.');
  return new URL(url).origin;
}
