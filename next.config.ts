import type { NextConfig } from 'next'

// The Agent SDK spawns a ~209MB per-platform native binary. Next's file tracer
// does not see it (it is resolved at runtime, not imported), so include it explicitly
// or the deployed function throws "Native CLI binary not found".
const nextConfig: NextConfig = {
  // Next 16 writes AGENTS.md/CLAUDE.md into the repo on every dev run. Not wanted here.
  agentRules: false,
  outputFileTracingIncludes: {
    '/api/**': ['./node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/**'],
  },
}

export default nextConfig
