/**
 * The agent endpoint. Streams Server-Sent Events to the chat UI.
 *
 * Deliberately stateless: each request replays the transcript as the prompt rather
 * than resuming an SDK session. Sessions are persisted to the harness's home
 * directory, which on Vercel is a per-instance /tmp that the next request may not
 * land on. Replaying costs nothing extra because the 37k-token knowledge prefix is
 * identical every turn and therefore served from the prompt cache.
 */
import { createSdkMcpServer, query } from '@anthropic-ai/claude-agent-sdk'
import { SYSTEM_PROMPT, cite, figure } from '@/lib/kb'
import { TOOLS } from '@/lib/tools'
import { verify } from '@/lib/verify'

export const maxDuration = 300

type Msg = { role: 'user' | 'assistant'; content: string }

export async function POST(req: Request) {
  const { messages } = (await req.json()) as { messages: Msg[] }

  // Bring-your-own-key. The hosted demo carries no key of its own, so the browser
  // sends one per request. It is used for this call and discarded: never logged,
  // never written to disk, never returned in a response. Locally, .env supplies it
  // and the header is unnecessary.
  const supplied = req.headers.get('x-anthropic-key')?.trim()
  const apiKey = supplied && /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(supplied)
    ? supplied
    : process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return Response.json(
      {
        needsKey: true,
        error: supplied
          ? "That doesn't look like an Anthropic API key. They start with sk-ant-."
          : 'This demo runs on your own Anthropic key. Add one to start.',
      },
      { status: 401 },
    )
  }

  const prompt = messages
    .map((m) => (m.role === 'user' ? `User: ${m.content}` : `You previously answered: ${m.content}`))
    .join('\n\n')

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))

      let answer = ''
      const toolOutput: string[] = []
      const shown = new Set<string>()  // a component rendered twice is a UI bug, not an answer

      try {
        const q = query({
          prompt,
          options: {
            model: process.env.MODEL ?? 'claude-sonnet-5',
            systemPrompt: { type: 'custom', prompt: SYSTEM_PROMPT },
            mcpServers: {
              omnipro: createSdkMcpServer({
                name: 'omnipro',
                version: '1.0.0',
                tools: TOOLS,
                // Without this the harness defers MCP tools behind its ToolSearch tool,
                // and the model -- which cannot see them -- writes show_component(...)
                // into its prose as if it had called it. Also makes startup wait for the
                // server to connect, so the tools exist when the turn-1 prompt is built.
                alwaysLoad: true,
              }),
            },
            // Getting the tool surface right took several attempts, so the reasoning is
            // worth recording. `tools: []` looks like the way to drop the built-ins, but
            // it removes the MCP tools too: the harness reports tools=[] and the model
            // quietly answers from the prefix, doing the duty-cycle arithmetic it was
            // told never to do. What works is to strike the built-ins out by name and
            // whitelist ours, which also auto-approves them -- without allowedTools the
            // harness has no one to ask for permission in a headless service, so every
            // call comes back denied and the model apologises about permissions in the
            // answer. The agent's entire world is the committed index: no Bash, no
            // filesystem, no web.
            allowedTools: TOOLS.map((t) => `mcp__omnipro__${t.name}`),
            disallowedTools: [
              'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
              'Task', 'TodoWrite', 'NotebookEdit', 'ToolSearch', 'Skill', 'Workflow',
              'Monitor', 'SendMessage', 'ListAgents', 'PushNotification', 'ReportFindings',
              'ScheduleWakeup', 'TaskOutput', 'TaskStop', 'DesignSync', 'PowerShell',
              'CronCreate', 'CronDelete', 'CronList', 'EnterWorktree', 'ExitWorktree',
            ],
            settingSources: [],
            includePartialMessages: true,
            maxTurns: 14,
            // The hosted demo is a public URL spending a real key. A single question
            // costs $0.02-0.06; this caps a runaway loop without ever binding a
            // legitimate answer.
            maxBudgetUsd: Number(process.env.MAX_BUDGET_USD ?? 0.5),
            // ENABLE_TOOL_SEARCH=0: with six tools and no built-ins, tool search only
            // defers them behind an extra discovery round-trip.
            // HOME=/tmp on Vercel: the filesystem is read-only everywhere else and the
            // harness wants a writable home.
            env: {
              ...process.env,
              ANTHROPIC_API_KEY: apiKey,
              ENABLE_TOOL_SEARCH: '0',
              ...(process.env.VERCEL ? { HOME: '/tmp', CLAUDE_CONFIG_DIR: '/tmp/.claude' } : {}),
            } as Record<string, string>,
          },
        })

        for await (const m of q) {
          if (process.env.SDK_DEBUG) {
            const extra =
              m.type === 'assistant'
                ? m.message.content.map((b) => b.type + (b.type === 'tool_use' ? ':' + b.name : '')).join(',')
                : m.type === 'system' && 'tools' in m
                  ? `tools=${JSON.stringify((m as { tools?: string[] }).tools)} mcp=${JSON.stringify((m as { mcp_servers?: unknown }).mcp_servers)}`
                  : ''
            if (m.type !== 'stream_event') console.log('[sdk]', m.type, extra)
          }
          if (m.type === 'stream_event') {
            const e = m.event
            if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') {
              answer += e.delta.text
              send({ type: 'text', delta: e.delta.text })
            }
            continue
          }

          if (m.type === 'assistant') {
            for (const block of m.message.content) {
              if (block.type !== 'tool_use') continue
              const name = block.name.replace('mcp__omnipro__', '')
              const input = block.input as Record<string, unknown>
              send({ type: 'tool', name, input })

              // Tool calls that exist to put something on screen are mirrored to the
              // UI here, off the tool_use block, so the handler stays a pure function.
              if (name === 'get_figure') {
                const f = figure(String(input.id))
                if (f && !shown.has(f.id)) {
                  shown.add(f.id)
                  send({
                    type: 'figure', id: f.id, url: `/kb/figures/${f.id}.webp`,
                    title: f.caption.title, page: cite(f.doc, f.page),
                  })
                }
              }
              if (name === 'get_page') {
                const doc = String(input.doc)
                const page = Number(input.page)
                send({
                  type: 'figure',
                  id: `${doc}-p${page}`,
                  url: `/kb/pages/${doc}-p${String(page).padStart(2, '0')}.webp`,
                  title: `Full page`, page: cite(doc, page),
                })
              }
              if (name === 'show_component') {
                const { component, ...props } = input
                if (!shown.has(String(component))) {
                  shown.add(String(component))
                  send({ type: 'component', component, props })
                }
              }
              if (name === 'render_diagram') {
                send({ type: 'diagram', title: input.title, svg: input.svg })
              }
            }
          }

          if (m.type === 'user') {
            // Tool results come back as a synthetic user turn. Capture their text as
            // evidence for the grounding check.
            const content = m.message.content
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'tool_result' && Array.isArray(block.content)) {
                  for (const c of block.content) {
                    if (c.type === 'text') toolOutput.push(c.text)
                  }
                }
              }
            }
          }

          if (m.type === 'result') {
            send({
              type: 'done',
              verdict: verify(answer, toolOutput),
              costUsd: 'total_cost_usd' in m ? m.total_cost_usd : 0,
              usage: 'modelUsage' in m ? m.modelUsage : {},
              error: m.subtype !== 'success' ? m.subtype : undefined,
            })
          }
        }
      } catch (e) {
        send({ type: 'error', message: (e as Error).message?.slice(0, 500) })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  })
}
