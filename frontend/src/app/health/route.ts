/**
 * Liveness/readiness probe for the frontend container and the load balancer target group.
 * Answers without rendering, without touching the backend and without exposing configuration.
 */
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}

export function HEAD(): Response {
  return new Response(null, { status: 200, headers: { "Cache-Control": "no-store" } });
}
