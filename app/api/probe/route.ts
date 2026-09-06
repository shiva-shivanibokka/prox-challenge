import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'

export const maxDuration = 120

// Deployment probe. Answers one question: can the Agent SDK spawn its native
// binary and complete a tool-using turn in this runtime? Reports the furthest
// stage reached so an auth failure (fine) is distinguishable from a spawn
// failure (fatal for this host).
export async function GET() {
  const diag: Record<string, unknown> = {
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY),
    stage: 'start',
  }

  try {
    const req = createRequire(import.meta.url)
    const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
    const dir = req.resolve(`${pkg}/package.json`).replace(/package\.json$/, '')
    diag.binaryPackage = pkg
    diag.binaryPresent = existsSync(dir + 'claude') || existsSync(dir + 'claude.exe')
  } catch (e) {
    diag.binaryPackage = `unresolved: ${(e as Error).message}`
  }
  diag.stage = 'binary-resolved'

  const echo = tool('echo', 'Echo a word back', { word: z.string() }, async ({ word }) => ({
    content: [{ type: 'text' as const, text: `echoed:${word}` }],
  }))

  const messages: string[] = []
  try {
    const q = query({
      prompt: 'Call the echo tool with the word "alive", then reply with exactly the tool output.',
      options: {
        model: process.env.MODEL ?? 'claude-haiku-4-5',
        systemPrompt: { type: 'custom' as const, prompt: 'You are a probe. Be terse.' },
        tools: [], // drop every built-in tool; only our in-process MCP tools remain
        mcpServers: { probe: createSdkMcpServer({ name: 'probe', version: '1.0.0', tools: [echo] }) },
        allowedTools: ['mcp__probe__echo'],
        settingSources: [],
        maxTurns: 3,
        // Vercel's filesystem is read-only except /tmp; the harness wants a writable home.
        env: (process.env.VERCEL
          ? { ...process.env, HOME: '/tmp', CLAUDE_CONFIG_DIR: '/tmp/.claude' }
          : { ...process.env }) as Record<string, string>,
      },
    })
    diag.stage = 'query-created'

    for await (const m of q) {
      messages.push(m.type)
      if (m.type === 'system') diag.stage = 'harness-booted'
      if (m.type === 'assistant') diag.stage = 'model-responded'
      if (m.type === 'result') {
        diag.stage = m.subtype === 'success' ? 'complete' : `result:${m.subtype}`
        diag.isError = m.is_error
        diag.apiErrorStatus = 'api_error_status' in m ? m.api_error_status : undefined
        diag.result = 'result' in m ? String(m.result).slice(0, 400) : undefined
        diag.costUsd = 'total_cost_usd' in m ? m.total_cost_usd : undefined
        diag.modelUsage = 'modelUsage' in m ? m.modelUsage : undefined
      }
    }
  } catch (e) {
    diag.error = (e as Error).message?.slice(0, 600)
    diag.errorName = (e as Error).name
  }

  diag.messageTypes = messages
  // Infra is proven the moment the harness boots; auth is a separate concern.
  diag.harnessRuns = messages.includes('system') || messages.includes('result')
  return Response.json(diag, { status: 200 })
}
