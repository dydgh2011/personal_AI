import { learning, LearningError } from '@/lib/learning';
import { audit, currentSession } from '@/lib/server';

/** JSON export download (owner session required; read-only, so no CSRF token). */
export async function GET() {
  const session = await currentSession();
  if (!session) return Response.json({ message: 'Not logged in' }, { status: 401 });
  try {
    const data = await learning.export(session.user);
    await audit({ event: 'learning.export', user: session.user });
    const name = `learning-export-${new Date().toISOString().slice(0, 10)}.json`;
    return new Response(JSON.stringify(data, null, 2), {
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const e = error as LearningError;
    return Response.json({ message: e.message, code: e.code }, { status: 502 });
  }
}
