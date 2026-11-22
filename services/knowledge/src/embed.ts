/** Embeddings for semantic search, from Ollama on the owner's PC (bge-m3 by default). */

export interface Embedder {
  readonly model: string;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export class EmbedError extends Error {
  /** true = the embedding server could not be reached (retry later, do not mark items failed). */
  constructor(message: string, readonly unreachable: boolean) {
    super(message);
  }
}

const MAX_INPUT_CHARS = 2000;

export function normalize(vector: ArrayLike<number>): Float32Array {
  const out = Float32Array.from(vector);
  let norm = 0;
  for (const v of out) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export function ollamaEmbedder(url: string, model: string, timeoutMs = 60_000): Embedder {
  return {
    model,
    async embed(texts: string[]): Promise<Float32Array[]> {
      let response: Response;
      try {
        response = await fetch(`${url}/api/embed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, input: texts.map((t) => t.slice(0, MAX_INPUT_CHARS)), truncate: true }),
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new EmbedError(`Ollama unreachable (${(error as Error).name})`, true);
      }
      if (!response.ok) {
        const text = (await response.text().catch(() => '')).slice(0, 200);
        throw new EmbedError(`Ollama answered ${response.status}: ${text}`, response.status >= 500 || response.status === 404);
      }
      const body = (await response.json()) as { embeddings?: number[][] };
      if (!Array.isArray(body.embeddings) || body.embeddings.length !== texts.length) throw new EmbedError('Ollama returned no embeddings', false);
      return body.embeddings.map((e) => normalize(e));
    },
  };
}
