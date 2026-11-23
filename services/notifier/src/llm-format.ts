import { ValidationError } from './format.js';

/** Events from the LLM gateway (free quota switch, paid approval needed, paid daily cap). */
export type LlmEvent =
  | { kind: 'free_switch'; pool: string; label: string; used: number; limit: number; unit: 'tokens' | 'requests' }
  | { kind: 'paid_needed'; alias: string; capUsd: number }
  | { kind: 'paid_cap'; spentUsd: number; capUsd: number };

function obj(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ValidationError(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function only(o: Record<string, unknown>, allowed: string[]): void {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length) throw new ValidationError(`llm: unexpected fields ${extra.join(', ')}`);
}

function id(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) throw new ValidationError(`${field} must be a short id`);
  return value;
}

function label(value: unknown): string {
  if (typeof value !== 'string' || value.length > 60 || /[`<>@\n]/.test(value)) throw new ValidationError('label must be plain text up to 60 characters');
  return value;
}

function amount(value: unknown, field: string, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) throw new ValidationError(`${field} must be a number 0-${max}`);
  return value;
}

export function parseLlm(value: unknown): LlmEvent {
  const o = obj(value, 'llm');
  if (o.kind === 'free_switch') {
    only(o, ['kind', 'pool', 'label', 'used', 'limit', 'unit']);
    if (o.unit !== 'tokens' && o.unit !== 'requests') throw new ValidationError('unit must be tokens or requests');
    return { kind: 'free_switch', pool: id(o.pool, 'pool'), label: label(o.label), used: amount(o.used, 'used', 1e12), limit: amount(o.limit, 'limit', 1e12), unit: o.unit };
  }
  if (o.kind === 'paid_needed') {
    only(o, ['kind', 'alias', 'capUsd']);
    return { kind: 'paid_needed', alias: id(o.alias, 'alias'), capUsd: amount(o.capUsd, 'capUsd', 100) };
  }
  if (o.kind === 'paid_cap') {
    only(o, ['kind', 'spentUsd', 'capUsd']);
    return { kind: 'paid_cap', spentUsd: amount(o.spentUsd, 'spentUsd', 1000), capUsd: amount(o.capUsd, 'capUsd', 100) };
  }
  throw new ValidationError('llm.kind must be free_switch, paid_needed or paid_cap');
}

function short(n: number, unit: 'tokens' | 'requests'): string {
  if (unit === 'requests') return `${Math.round(n)}회`;
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : `${Math.round(n / 1000)}K`;
}

export function formatLlm(e: LlmEvent, mentionUserId: string | null): string {
  const mention = mentionUserId ? `<@${mentionUserId}> ` : '';
  if (e.kind === 'free_switch') {
    return `**🤖 ${e.label} 오늘 한도에 가까워요** (${short(e.used, e.unit)} / ${short(e.limit, e.unit)})\n다음 무료 경로로 넘어가요. 유료로는 넘어가지 않아요.`;
  }
  if (e.kind === 'paid_needed') {
    return `${mention}**🤖 오늘 무료 AI 한도가 모두 찼어요**\nKelly가 답하려면 유료(OpenAI Private nano)가 필요해요. 하루 최대 $${e.capUsd.toFixed(2)}, 자정까지만.\n허용: Discord에서 \`/ai-paid on\` · 그대로 두면 무료 한도가 다시 열릴 때까지 쉬어요.`;
  }
  return `${mention}**🤖 오늘 유료 AI 상한에 닿았어요** ($${e.spentUsd.toFixed(2)} / $${e.capUsd.toFixed(2)})\n내일 무료 한도가 다시 열릴 때까지 Kelly는 쉬어요.`;
}
