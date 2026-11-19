// Liveness and readiness for the container. It deliberately does not call the API.
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ status: "ok" });
}
