export const APP_CONFIG = Symbol('APP_CONFIG');

/**
 * AI provider settings. Everything is optional: until the owner sets provider, model, key and a
 * monthly budget (with prices to compute cost), AI generation is refused (PROVIDER_NOT_CONFIGURED)
 * and the rest of the service works normally.
 */
export interface AiConfig {
  /** gemini: Google API directly. gateway: the Personal AI LLM gateway (OpenAI-compatible, model = purpose alias). */
  provider: 'none' | 'gemini' | 'gateway';
  model: string | null;
  keyFile: string | null;
  apiUrl: string;
  monthlyBudgetUsd: number | null;
  inputUsdPerMTok: number | null;
  outputUsdPerMTok: number | null;
  timeoutMs: number;
}

export interface AppConfig {
  host: string;
  port: number;
  databasePath: string;
  /** Admin Dashboard server token (owner role). */
  dashboardToken: string;
  ai: AiConfig;
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const problems: string[] = [];
  const dashboardToken = env.LEARNING_DASHBOARD_TOKEN?.trim() ?? '';
  if (dashboardToken.length < 32) problems.push('LEARNING_DASHBOARD_TOKEN is required (>= 32 characters)');

  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push('PORT must be 1-65535');

  const provider = (env.LEARNING_AI_PROVIDER?.trim() || 'none') as AiConfig['provider'];
  if (provider !== 'none' && provider !== 'gemini' && provider !== 'gateway') problems.push('LEARNING_AI_PROVIDER must be none, gemini or gateway');
  const num = (name: string): number | null => {
    const raw = env[name]?.trim();
    if (!raw) return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      problems.push(`${name} must be a non-negative number`);
      return null;
    }
    return value;
  };
  const timeout = num('LEARNING_AI_TIMEOUT_SECONDS') ?? 30;
  const defaultUrl = provider === 'gateway' ? 'http://llm-gateway:8094/v1' : 'https://generativelanguage.googleapis.com/v1beta';
  const apiUrl = (env.LEARNING_AI_API_URL?.trim() || defaultUrl).replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+/.test(apiUrl)) problems.push('LEARNING_AI_API_URL must be an http(s) URL');
  const model = env.LEARNING_AI_MODEL?.trim() || null;
  if (model && !/^[A-Za-z0-9._-]{1,100}$/.test(model)) problems.push('LEARNING_AI_MODEL contains unexpected characters');

  if (problems.length) throw new ConfigError(`Invalid learning service configuration:\n - ${problems.join('\n - ')}`);
  return {
    host: env.HOST?.trim() || '0.0.0.0',
    port,
    databasePath: env.LEARNING_DB_PATH?.trim() || './data/learning.db',
    dashboardToken,
    ai: {
      provider,
      model,
      keyFile: env.LEARNING_AI_KEY_FILE?.trim() || null,
      apiUrl,
      monthlyBudgetUsd: num('LEARNING_AI_MONTHLY_BUDGET_USD'),
      inputUsdPerMTok: num('LEARNING_AI_INPUT_USD_PER_MTOK'),
      outputUsdPerMTok: num('LEARNING_AI_OUTPUT_USD_PER_MTOK'),
      timeoutMs: Math.min(Math.max(timeout, 5), 120) * 1000,
    },
  };
}
