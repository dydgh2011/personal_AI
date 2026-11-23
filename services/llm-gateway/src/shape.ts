import type { ProviderDef } from './config.js';

/** Secrets never leave for a provider (same patterns as the knowledge store's redaction). */
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['discord-webhook', /https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+/g],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  [
    'api-key',
    /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|gsk_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|GOCSPX-[A-Za-z0-9_-]{10,})/g,
  ],
  ['bearer', /\bbearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi],
];
// JS \b only knows ASCII word characters, so Korean words need a Unicode lookbehind.
const PASSWORD = /(?<![\p{L}\p{N}_])(password|passwd|비밀번호|패스워드)(\s*[:=]\s*)\S+/giu;
// Card numbers: 15-16 digits starting 3-6 (plain or in groups), Luhn-valid. Shorter/longer runs
// (timestamps, 17-19 digit Discord ids) are left alone.
const CARD = /\b[3-6]\d{3}(?:[ -]?\d{4}){2}[ -]?\d{3,4}\b/g;

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

export function redact(text: string): { text: string; hits: number } {
  let hits = 0;
  let out = text;
  for (const [label, pattern] of SECRET_PATTERNS) {
    out = out.replace(pattern, () => {
      hits++;
      return `[redacted:${label}]`;
    });
  }
  out = out.replace(PASSWORD, (_m, word: string, sep: string) => {
    hits++;
    return `${word}${sep}[redacted:password]`;
  });
  out = out.replace(CARD, (m) => {
    const digits = m.replace(/\D/g, '');
    if (digits.length < 15 || digits.length > 16 || !luhn(digits)) return m;
    hits++;
    return '[redacted:card-number]';
  });
  return { text: out, hits };
}

type Json = Record<string, unknown>;

function redactContent(content: unknown, count: { hits: number }): unknown {
  if (typeof content === 'string') {
    const r = redact(content);
    count.hits += r.hits;
    return r.text;
  }
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (part && typeof part === 'object' && (part as Json).type === 'text' && typeof (part as Json).text === 'string') {
        const r = redact((part as Json).text as string);
        count.hits += r.hits;
        return { ...(part as Json), text: r.text };
      }
      return part;
    });
  }
  return content;
}

const MESSAGE_FIELDS = new Set(['role', 'content', 'name', 'tool_calls', 'tool_call_id']);
/** Accepted by Gemini's OpenAI endpoint as "skip the signature check" for tool calls made elsewhere. */
export const DUMMY_SIGNATURE = 'skip_thought_signature_validator';

/**
 * Builds the upstream body: only fields the provider accepts, the route's model, messages reduced
 * to the standard shape (plus Gemini's thought signatures), secrets redacted, usage requested on streams.
 */
export function shapeBody(body: Json, provider: ProviderDef, model: string, options: { redact: boolean }): { body: Json; redactions: number } {
  const out: Json = { model };
  for (const field of provider.fields) {
    if (field in body && body[field] !== undefined) out[field] = body[field];
  }
  if (!provider.fields.includes('max_completion_tokens') && typeof body.max_completion_tokens === 'number' && out.max_tokens === undefined) {
    out.max_tokens = body.max_completion_tokens;
  }
  if (out.stream === true) {
    const so = out.stream_options && typeof out.stream_options === 'object' ? (out.stream_options as Json) : {};
    out.stream_options = { ...so, include_usage: true };
  } else {
    delete out.stream_options;
  }
  const hasTools = Array.isArray(out.tools) && out.tools.length > 0;
  if (provider.id.startsWith('openai') && hasTools) {
    // gpt-5.4 mini/nano on /v1/chat/completions: "Function tools with reasoning_effort are not
    // supported ... set reasoning_effort to 'none'" (verified 2026-11-23).
    out.reasoning_effort = 'none';
  } else if (!provider.id.startsWith('openai') && out.reasoning_effort !== undefined) {
    // Gemini and Groq take low/medium/high only.
    const e = String(out.reasoning_effort);
    if (!['low', 'medium', 'high'].includes(e)) delete out.reasoning_effort;
  }
  const count = { hits: 0 };
  const messages = Array.isArray(body.messages) ? body.messages : [];
  out.messages = messages.map((raw) => {
    const m = raw as Json;
    const msg: Json = {};
    for (const [k, v] of Object.entries(m)) if (MESSAGE_FIELDS.has(k)) msg[k] = v;
    if (options.redact && (m.role === 'user' || m.role === 'tool' || m.role === 'system' || m.role === 'developer')) {
      msg.content = redactContent(msg.content, count);
    }
    if (m.role === 'developer' && !provider.id.startsWith('openai')) msg.role = 'system';
    if (Array.isArray(m.tool_calls)) {
      msg.tool_calls = (m.tool_calls as Json[]).map((tc) => {
        const fn = (tc.function ?? {}) as Json;
        const call: Json = { id: tc.id, type: tc.type ?? 'function', function: { name: fn.name, arguments: fn.arguments ?? '{}' } };
        if (provider.thoughtSignatures) {
          const sig = ((tc.extra_content as Json | undefined)?.google as Json | undefined)?.thought_signature;
          call.extra_content = { google: { thought_signature: typeof sig === 'string' && sig ? sig : DUMMY_SIGNATURE } };
        }
        return call;
      });
    }
    if (provider.thoughtSignatures && m.role === 'assistant') {
      const sig = ((m.extra_content as Json | undefined)?.google as Json | undefined)?.thought_signature;
      if (typeof sig === 'string' && sig) msg.extra_content = { google: { thought_signature: sig } };
    }
    return msg;
  });
  return { body: out, redactions: count.hits };
}

/** Rough prompt size: UTF-8 bytes / 3.5 (Korean ~1 token per 3 bytes, English ~4 bytes). Errs high. */
export function estimatePromptTokens(body: Json): number {
  const text = JSON.stringify({ m: body.messages ?? [], t: body.tools ?? [] });
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3.5);
}
