import { learning, LearningError } from '@/lib/learning';
import { LEARNING_FILE_CSP } from '@/lib/learning-file-csp.mjs';
import { LEARNING_UUID } from '@/lib/learning-view';
import { currentSession } from '@/lib/server';

const INLINE_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * A submitted file, for the owner's session only (read-only, so no CSRF token). The learning
 * service decided the media type from the bytes; here it is narrowed further:
 * - PNG/JPEG/GIF/WebP are shown inline (so photo submissions can be previewed)
 * - text and code are shown as text/plain (never as HTML or script)
 * - anything else (PDF) is a download
 * The response is sandboxed by CSP and never sniffed, so a file cannot run as a page.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ submissionId: string; fileId: string }> }) {
  const session = await currentSession();
  if (!session) return Response.json({ message: 'Not logged in' }, { status: 401 });
  const { submissionId, fileId } = await params;
  if (!LEARNING_UUID.test(submissionId) || !LEARNING_UUID.test(fileId)) return Response.json({ message: 'Not found' }, { status: 404 });
  try {
    const file = await learning.submissionFile(submissionId, fileId);
    const bytes = Buffer.from(file.contentBase64, 'base64');
    const image = INLINE_IMAGES.has(file.mediaType);
    const textFile = file.category === 'text';
    const type = image ? file.mediaType : textFile ? 'text/plain; charset=utf-8' : 'application/octet-stream';
    const ascii = file.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    const utf8Name = encodeURIComponent(Buffer.from(file.name).toString('utf8'))
      .replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    const disposition = `${image || textFile ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${utf8Name}`;
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': type,
        'Content-Length': String(bytes.length),
        'Content-Disposition': disposition,
        'Content-Security-Policy': LEARNING_FILE_CSP,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    const e = error as LearningError;
    return Response.json({ message: e.status === 404 ? 'Not found' : 'Learning service error' }, { status: e.status === 404 ? 404 : 502 });
  }
}
