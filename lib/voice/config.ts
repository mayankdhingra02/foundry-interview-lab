export type VoiceConfig = {
  apiKey: string; sttUsdPerMinute: number; ttsUsdPerThousandChars: number;
  sessionMinutes: number; userDailyMinutes: number; globalDailyMinutes: number;
  sessionUsd: number; userDailyUsd: number; userMonthlyUsd: number; globalDailyUsd: number;
};

// These are admission ceilings, not a claim about an account's final invoice.
// Qualification requires an operator to verify their account and deployment.
export function voiceConfig(env: Record<string, string | undefined> = process.env): VoiceConfig | null {
  if (env.FEATURE_VOICE !== 'true' || env.VOICE_QUALIFIED !== 'true' || !env.DEEPGRAM_API_KEY?.trim()) return null;
  if (env.NODE_ENV === 'production' && !env.DATABASE_URL) return null;
  const positive = (name: string, min: number, max: number) => {
    const raw = env[name]; const value = raw?.trim() ? Number(raw) : NaN;
    return Number.isFinite(value) && value >= min && value <= max ? value : NaN;
  };
  const config: VoiceConfig = {
    apiKey: env.DEEPGRAM_API_KEY,
    sttUsdPerMinute: positive('VOICE_STT_USD_PER_MINUTE', 0.0043, 10),
    ttsUsdPerThousandChars: positive('VOICE_TTS_USD_PER_1K_CHARS', 0.03, 10),
    sessionMinutes: positive('VOICE_MAX_SESSION_MINUTES', 1, 180),
    userDailyMinutes: positive('VOICE_MAX_USER_DAILY_MINUTES', 1, 1440),
    globalDailyMinutes: positive('VOICE_MAX_GLOBAL_DAILY_MINUTES', 1, 1_000_000),
    sessionUsd: positive('MAX_SESSION_USD', 0.01, 100),
    userDailyUsd: positive('MAX_DAILY_USER_USD', 0.01, 10_000),
    userMonthlyUsd: positive('MAX_MONTHLY_USER_USD', 0.01, 1_000_000),
    globalDailyUsd: positive('VOICE_MAX_GLOBAL_DAILY_USD', 0.01, 100_000)
  };
  return Object.values(config).every(value => typeof value === 'string' || Number.isFinite(value)) ? config : null;
}

export function voiceAvailability() { return Boolean(voiceConfig()); }

export const MAX_CAPTURE_SECONDS = 60;
export const MAX_SPEAK_SECONDS = 120;
export const MAX_SPEAK_CHARACTERS = 1_500;
export const MAX_WAV_BYTES = 44 + MAX_CAPTURE_SECONDS * 32_000;
export const MAX_MULTIPART_BYTES = MAX_WAV_BYTES + 16_384;
