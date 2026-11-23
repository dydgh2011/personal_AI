import 'server-only';
import { readSecret } from './server';

/** What the LLM gateway reports at GET /usage (dashboard key: read-only, no control). */
export interface LlmUsage {
  localDay: string;
  pools: Array<{
    id: string;
    label: string;
    day: string;
    resetTimeZone: string;
    tokens: number;
    requests: number;
    tokensPerDay: number | null;
    requestsPerDay: number | null;
    stopAt: number;
    usedShare: number;
  }>;
  paid: { approvedToday: boolean; approvedAt: string | null; spentTodayUsd: number; dailyCapUsd: number };
  totalSpentUsd: number;
  aliases: Record<string, { description: string; routes: string[] }>;
  daily: Array<{
    day: string;
    alias: string;
    provider: string;
    model: string;
    calls: number;
    ok: number;
    prompt_tokens: number;
    cached_tokens: number;
    completion_tokens: number;
    cost_usd: number;
    list_cost_usd: number;
  }>;
  recentErrors: Array<{ at: string; client: string; alias: string; provider: string; model: string; status: number; error: string | null }>;
}

const settings = {
  url: (process.env.LLM_GATEWAY_URL?.trim() || 'http://llm-gateway:8094').replace(/\/+$/, ''),
  keyFile: process.env.LLM_GATEWAY_KEY_FILE?.trim() || '/run/secrets/llm_key',
};

/** Server side only: the gateway key never reaches the browser. */
export async function llmUsage(days = 14): Promise<LlmUsage> {
  let key: string;
  try {
    key = readSecret(settings.keyFile);
  } catch {
    throw new Error('LLM gateway key is not configured (compose.llm.yaml)');
  }
  let res: Response;
  try {
    res = await fetch(`${settings.url}/usage?days=${days}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new Error('LLM gateway unreachable');
  }
  if (!res.ok) throw new Error(`LLM gateway answered ${res.status}`);
  return (await res.json()) as LlmUsage;
}
