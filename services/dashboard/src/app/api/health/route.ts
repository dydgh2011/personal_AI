/** Liveness for Docker. Reveals nothing and does not call the controller. */
export function GET() {
  return Response.json({ status: 'ok' });
}
