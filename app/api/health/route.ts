/**
 * Tells the client whether this deployment carries its own key.
 *
 * Locally it does (from .env) and the chat just works. The hosted demo deliberately
 * does not, so the browser supplies one per session. Returns a boolean and nothing
 * else -- never the key, never a prefix of it.
 */
export const dynamic = 'force-dynamic'

export function GET() {
  return Response.json({ serverKey: Boolean(process.env.ANTHROPIC_API_KEY) })
}
