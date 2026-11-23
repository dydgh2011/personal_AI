/**
 * Routing table. Callers ask for a purpose alias ("kelly", "kelly-aux", "batch", "private"),
 * never for a provider. Each alias is an ordered list of routes; the gateway takes the first
 * route that is allowed right now (free quota left, size fits, paid approved) and falls back
 * on errors. Owner decisions (2026-11-22):
 *   - ordinary data may go to free / data-sharing tiers (OpenAI "public" project, Gemini free, Groq free)
 *   - the OpenAI "private" project (paid, no data sharing) only when asked for explicitly
 *   - never fall back to a paid route without the owner's approval for that day
 */

export type ProviderId = 'openai-public' | 'openai-private' | 'gemini' | 'groq';

export interface ProviderDef {
  id: ProviderId;
  baseUrl: string;
  /** How this provider's account treats the data (shown in /usage). */
  data: 'shared-free' | 'private-paid' | 'free';
  /** Top-level request fields this provider accepts (others are dropped). */
  fields: readonly string[];
  /** Gemini needs a thought signature on every tool call in the history. */
  thoughtSignatures?: boolean;
}

const COMMON_FIELDS = [
  'messages', 'tools', 'tool_choice', 'temperature', 'top_p', 'max_tokens', 'stream', 'stream_options',
  'response_format', 'stop', 'seed', 'reasoning_effort', 'parallel_tool_calls', 'user', 'n',
] as const;

export const PROVIDERS: Record<ProviderId, ProviderDef> = {
  'openai-public': {
    id: 'openai-public', baseUrl: 'https://api.openai.com/v1', data: 'shared-free',
    fields: [...COMMON_FIELDS, 'max_completion_tokens', 'frequency_penalty', 'presence_penalty', 'logit_bias', 'prompt_cache_key', 'verbosity', 'service_tier'],
  },
  'openai-private': {
    id: 'openai-private', baseUrl: 'https://api.openai.com/v1', data: 'private-paid',
    fields: [...COMMON_FIELDS, 'max_completion_tokens', 'frequency_penalty', 'presence_penalty', 'logit_bias', 'prompt_cache_key', 'verbosity', 'service_tier'],
  },
  gemini: {
    id: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', data: 'free',
    fields: COMMON_FIELDS, thoughtSignatures: true,
  },
  groq: {
    id: 'groq', baseUrl: 'https://api.groq.com/openai/v1', data: 'free',
    fields: [...COMMON_FIELDS, 'max_completion_tokens', 'frequency_penalty', 'presence_penalty'],
  },
};

/** A free quota shared by several routes, counted by the gateway itself. */
export interface PoolDef {
  id: string;
  label: string;
  /** When the provider's day starts again. */
  resetTimeZone: 'UTC' | 'America/Los_Angeles';
  /** Hard daily limit of the provider (tokens or requests); null when not counted. */
  tokensPerDay: number | null;
  requestsPerDay: number | null;
  /** Stop using the pool at this share of the daily limit (a request that crosses OpenAI's limit is billed in full). */
  stopAt: number;
}

export const POOLS: Record<string, PoolDef> = {
  'openai-shared-small': {
    id: 'openai-shared-small', label: 'OpenAI 무료 (mini/nano)', resetTimeZone: 'UTC',
    tokensPerDay: 2_500_000, requestsPerDay: null, stopAt: 0.8,
  },
  'gemini-flash-lite': {
    id: 'gemini-flash-lite', label: 'Gemini 3.5 Flash-Lite 무료', resetTimeZone: 'America/Los_Angeles',
    tokensPerDay: null, requestsPerDay: 500, stopAt: 0.96,
  },
  'groq-gpt-oss-20b': {
    id: 'groq-gpt-oss-20b', label: 'Groq gpt-oss-20b 무료', resetTimeZone: 'UTC',
    tokensPerDay: 200_000, requestsPerDay: 1000, stopAt: 0.9,
  },
};

export interface RouteDef {
  provider: ProviderId;
  model: string;
  pool?: string;
  /** Billed at list price: used only with the owner's approval for the day (or via the explicit "private" alias). */
  paid?: boolean;
  /** Skip this route when the estimated prompt is larger (Groq free: 8k tokens per minute). */
  maxPromptTokens?: number;
}

export const ALIASES: Record<string, { description: string; routes: RouteDef[]; explicitPaid?: boolean }> = {
  kelly: {
    description: 'Kelly 대화와 도구 사용',
    routes: [
      { provider: 'openai-public', model: 'gpt-5.4-mini', pool: 'openai-shared-small' },
      { provider: 'gemini', model: 'gemini-3.5-flash-lite', pool: 'gemini-flash-lite' },
      { provider: 'openai-private', model: 'gpt-5.4-nano', paid: true },
    ],
  },
  'kelly-aux': {
    description: '제목, 대화 압축, 짧은 요약·분류',
    routes: [
      { provider: 'groq', model: 'openai/gpt-oss-20b', pool: 'groq-gpt-oss-20b', maxPromptTokens: 6000 },
      { provider: 'gemini', model: 'gemini-3.5-flash-lite', pool: 'gemini-flash-lite' },
      { provider: 'openai-public', model: 'gpt-5.4-nano', pool: 'openai-shared-small' },
    ],
  },
  batch: {
    description: '밤 정리, 문제 만들기 같은 백그라운드 작업 (대화용 OpenAI 무료 한도는 쓰지 않음)',
    routes: [
      { provider: 'gemini', model: 'gemini-3.5-flash-lite', pool: 'gemini-flash-lite' },
      { provider: 'groq', model: 'openai/gpt-oss-20b', pool: 'groq-gpt-oss-20b', maxPromptTokens: 6000 },
    ],
  },
  private: {
    description: '민감한 내용 (주인이 직접 고를 때만, OpenAI Private 유료)',
    routes: [{ provider: 'openai-private', model: 'gpt-5.4-nano', paid: true }],
    explicitPaid: true,
  },
};

/** USD per 1M tokens (OpenAI list prices, checked 2026-11-22). Free routes cost 0. */
export const PRICES: Record<string, { input: number; cached: number; output: number }> = {
  'gpt-5.4-mini': { input: 0.75, cached: 0.075, output: 4.5 },
  'gpt-5.4-nano': { input: 0.2, cached: 0.02, output: 1.25 },
};

export function listCost(model: string, prompt: number, cached: number, completion: number): number {
  const p = PRICES[model];
  if (!p) return 0;
  return ((prompt - cached) * p.input + cached * p.cached + completion * p.output) / 1_000_000;
}

export interface ClientDef {
  name: string;
  key: string;
  aliases: string[];
  /** May read /usage. */
  usage: boolean;
  /** May turn paid fallback on/off (/control/paid). */
  control: boolean;
}

/** Which aliases and rights each caller gets. */
export const CLIENT_RIGHTS: Record<string, Omit<ClientDef, 'name' | 'key'>> = {
  hermes: { aliases: ['kelly', 'kelly-aux', 'private'], usage: true, control: true },
  learning: { aliases: ['batch', 'kelly-aux'], usage: false, control: false },
  school: { aliases: ['kelly-aux', 'batch'], usage: false, control: false },
  dashboard: { aliases: [], usage: true, control: false },
  operator: { aliases: ['kelly', 'kelly-aux', 'batch'], usage: true, control: true },
};
