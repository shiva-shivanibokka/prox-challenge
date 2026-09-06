/**
 * The agent's tools, served in-process over the Agent SDK's MCP transport.
 *
 * Six tools, split along one line: the deterministic ones own the facts, the
 * generative one owns the pictures nobody drew in advance.
 */
import { tool } from '@anthropic-ai/claude-agent-sdk'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { dutyCycle } from './duty'
import { catalogue, cite, figure, pageText, tables } from './kb'

const KB = path.join(process.cwd(), 'public', 'kb')
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })

async function image(rel: string) {
  return {
    type: 'image' as const,
    data: (await readFile(path.join(KB, rel))).toString('base64'),
    mimeType: 'image/webp',
  }
}

/* ------------------------------------------------------------------ figures */

export const getFigure = tool(
  'get_figure',
  'Return an actual figure from the manuals as an image, with its caption and page. ' +
    'Use the id from the figure catalogue in the system prompt.',
  { id: z.string().describe('figure id, e.g. manual-p14-f1') },
  async ({ id }) => {
    const f = figure(id)
    if (!f) {
      const near = catalogue
        .filter((c) => c.id.startsWith(id.split('-').slice(0, 2).join('-')))
        .map((c) => c.id)
      return text(
        `No figure "${id}". ${near.length ? `On that page: ${near.join(', ')}.` : ''} ` +
          `Pick an id that appears in the catalogue.`,
      )
    }
    return {
      content: [
        await image(`figures/${id}.webp`),
        {
          type: 'text' as const,
          text: `${f.caption.title} [${cite(f.doc, f.page)}]\n${f.caption.summary}`,
        },
      ],
    }
  },
  { annotations: { readOnlyHint: true }, alwaysLoad: true },
)

export const getPage = tool(
  'get_page',
  'Return a whole page as an image plus its text. Use when someone wants to see the ' +
    'page itself, or when a figure crop lacks surrounding context.',
  {
    doc: z.enum(['manual', 'quickstart', 'chart', 'door']),
    page: z.number().int().positive(),
  },
  async ({ doc, page }) => {
    const body = pageText(doc, page)
    if (!body && doc !== 'chart') return text(`No page ${page} in ${doc}.`)
    return {
      content: [
        await image(`pages/${doc}-p${String(page).padStart(2, '0')}.webp`),
        { type: 'text' as const, text: `[${cite(doc, page)}]\n${body}` },
      ],
    }
  },
  { annotations: { readOnlyHint: true }, alwaysLoad: true },
)

/* ------------------------------------------------------------------- tables */

export const getTable = tool(
  'get_table',
  `Return a verified structured table. Available: ${Object.keys(tables).join(', ')}. ` +
    'These are the authority for facts -- always prefer them over figure captions.',
  { name: z.string() },
  async ({ name }) => {
    const t = tables[name]
    if (!t) return text(`No table "${name}". Available: ${Object.keys(tables).join(', ')}.`)
    return text(`sources: ${t.sources.join(', ')}\n${JSON.stringify(t.data, null, 1)}`)
  },
  { annotations: { readOnlyHint: true }, alwaysLoad: true },
)

/* -------------------------------------------------------------- duty cycle */

export const computeDutyCycle = tool(
  'compute_duty_cycle',
  'Look up the rated duty cycle for a process at a given input voltage and welding ' +
    'current. Always use this instead of doing the arithmetic yourself. It reads the ' +
    'verified specification matrix and will say when the manual does not specify.',
  {
    process: z.enum(['MIG', 'TIG', 'Stick']),
    input_volts: z.union([z.literal(120), z.literal(240)]),
    amps: z.number().positive(),
  },
  async ({ process, input_volts, amps }) =>
    text(JSON.stringify(dutyCycle(process, input_volts, amps), null, 1)),
  { annotations: { readOnlyHint: true }, alwaysLoad: true },
)

/* ------------------------------------------------------------------- visual */

export const COMPONENTS = [
  'duty_cycle_calculator',
  'polarity_diagram',
  'troubleshooting_flowchart',
  'process_selector',
  'settings_configurator',
  'setup_walkthrough',
] as const

// The seed values are flat, named and optional rather than a freeform props object.
// That is not only clearer for the model: a z.record(...) schema here failed to
// convert, and one unconvertible tool takes down the whole MCP server's tool list --
// the server still reports "connected" while exposing nothing, so the model quietly
// answers without tools. Four tools worked, the fifth broke all six.
export const showComponent = tool(
  'show_component',
  'Render an interactive component in the chat, driven by the verified tables so its ' +
    'contents are always correct. duty_cycle_calculator (seed with process, ' +
    'input_volts, amps) · polarity_diagram (seed with process) · ' +
    'troubleshooting_flowchart (seed with problem -- use this after diagnosing a weld ' +
    'photo) · process_selector (no seeds) · ' +
    'settings_configurator (seed with process, input_volts, thickness) for "how do I ' +
    'set this up for X material at Y thickness" · setup_walkthrough (seed with ' +
    'process, step) for "walk me through setting this up" -- the manual procedure one ' +
    'step at a time, with the page on every step. ' +
    'Prefer showing one of these over describing the same thing in prose.',
  {
    component: z.enum(COMPONENTS),
    process: z.string().optional().describe('MIG, Flux-Cored, TIG or Stick'),
    input_volts: z.number().optional().describe('120 or 240'),
    amps: z.number().optional(),
    problem: z.string().optional().describe('symptom to preselect in the flowchart'),
    thickness: z.string().optional().describe('material thickness, e.g. "18 gauge" or "1/4 in"'),
    step: z.number().int().min(1).optional().describe('which walkthrough step to open on'),
  },
  async ({ component }) =>
    text(`Rendered ${component} for the user. Do not repeat its contents in prose; ` +
      `add only what it does not show.`),
  { annotations: { readOnlyHint: true }, alwaysLoad: true },
)

export const renderDiagram = tool(
  'render_diagram',
  'Draw your own diagram as inline SVG when no manual figure and no built-in component ' +
    'fits. Use for spatial or procedural things words handle badly. Keep it to plain ' +
    'SVG shapes and text, viewBox set, no scripts, no external references.',
  {
    title: z.string(),
    svg: z.string().describe('a complete <svg>...</svg> element'),
  },
  async ({ title }) => text(`Rendered diagram "${title}" for the user.`),
  { annotations: { readOnlyHint: true }, alwaysLoad: true },
)

/**
 * The user's own photograph, handed to the model as a tool result.
 *
 * Streaming-input image blocks did not reach the model through the harness -- it kept
 * replying that no photo was attached -- but images returned from a tool do, which
 * get_figure already proves several times a session. So the upload is bound to a
 * per-request tool instead. That turns out to be the better shape anyway: looking at
 * the photo becomes an explicit, visible step in the transcript rather than something
 * that silently happened in the prompt.
 */
export type Photo = { mediaType: string; data: string }

export function viewPhoto(photos: Photo[]) {
  return tool(
    'view_photo',
    'Look at a photograph the user attached to this message. Call this first whenever ' +
      'a photo is attached -- you cannot answer about an image you have not opened.',
    { index: z.number().int().min(1).optional().describe('which photo, 1-based; defaults to 1') },
    async ({ index }) => {
      const i = (index ?? 1) - 1
      const p = photos[i]
      if (!p) return text(`No photo ${i + 1}. The user attached ${photos.length}.`)
      return {
        content: [
          { type: 'image' as const, data: p.data, mimeType: p.mediaType },
          { type: 'text' as const, text: `The user's photo ${i + 1} of ${photos.length}.` },
        ],
      }
    },
    { annotations: { readOnlyHint: true }, alwaysLoad: true },
  )
}

export const TOOLS = [
  getFigure, getPage, getTable, computeDutyCycle, showComponent, renderDiagram,
]