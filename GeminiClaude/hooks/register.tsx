import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Run } from '../types'

const running = atom({ plugin: 'GeminiClaude', key: 'running' } as const, [])
/// Finished runs, newest first.
const recent = atom({ plugin: 'GeminiClaude', key: 'recent' } as const, [])
const isOpen = atom({ plugin: 'GeminiClaude', key: 'isOpen' } as const, false)
const isHidden = atom({ plugin: 'GeminiClaude', key: 'isHidden' } as const, false)
const stepsShown = atom({ plugin: 'GeminiClaude', key: 'stepsShown' } as const, true)

// Agent types a Gemini run can't stand in for: a fork needs this conversation,
// web-fetch stands in for the WebFetch tool.
const NEVER_ASK = new Set(['fork', 'web-fetch'])
// ponytail: favours the two families named when this was written; edit to taste.
const FAVOURITES = /hydrogen|argon/
// ponytail: streaming lifts $.process.run's ten-minute cap; this is a runaway guard, raise it if real tasks need more.
const MAX_RUN = 30 * 60_000
/// Tool steps kept per run; the band shows the last few, the pane all of them.
const MAX_STEPS = 25
const PANE = 'gemini-runs'
// Windows caps a command line at 32767 characters, and agy takes the prompt only as an argument.
const MAX_PROMPT = 30_000
// ponytail: a guess at what the plan's unpublished rate limit bears; raise it if runs don't get throttled.
const MAX_PARALLEL = 5
const MAX_RECENT = 5

/// Model slugs `agy models` listed at session start; empty when agy is missing.
let models: string[] = []
/// How to invoke agy: its name on PATH, or its full install path when PATH lacks it.
let agy = 'agy'
/// Numbers each run, so a finished one can be taken off the `running` list.
let seq = 0
/// Writes to `running` go through one queue: with streaming, agents patch the shared list at once, and an update is read-then-write.
let queue: Promise<unknown> = Promise.resolve()
const inOrder = <T,>(fn: () => Promise<T>): Promise<T> => {
  const next = queue.then(fn, fn)
  queue = next.catch(() => {})
  return next
}

type Task = { model?: string; description: string; prompt: string }
type Tier = 'S' | 'M' | 'L'
type Verdict = { tier: Tier; effort: 'low' | 'medium' | 'high'; reason: string }

const AUTO = 'auto'
// arne's judge prompt (arne/hooks/backends.ts SYSTEM), kept equal by hand: a plugin can't import another's code.
const JUDGE = `You route a coding-assistant prompt to a model tier. Reply with JSON only:
{"tier":"S|M|L","effort":"low|medium|high","reason":"<6 words>"}
S = trivial lookup or edit, or a search, read or list (a subagent's brief to find or map code is S).
M = normal coding, including multi-step or multi-file chores: edits, re-renders, commits, running tools.
L = only when the hard part is the thinking: architecture, a race or subtle bug, a security review.
Many steps is not L: the model hands searches and grunt work to cheap subagents. When unsure, pick M.
Effort is high when the prompt asks to think hard or be careful, or touches security.`
// ponytail: arne's tiers onto Gemini families, Hydrogen as the Haiku stand-in; edit if Argon turns out weaker.
const FAMILY: Record<Tier, string> = { S: 'hydrogen', M: 'argon', L: 'argon' }

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    // A reload mid-run would otherwise leave the band stuck on "running".
    await update($, running, () => [])
    await $.command.register({ name: 'gemini', description: 'Open the Gemini agent runs pane: tools, tokens and thinking per agent' })
    models = await listModels($)
    if (models.length === 0) {
      $.ui.status('gemini: agy not found or signed out')
      return next(e)
    }
    await $.tool.register({
      name: 'delegate',
      description:
        'Run tasks on Google Gemini models through the Antigravity CLI (agy), as subagents. ' +
        'Whenever you consider spawning a subagent with the Agent tool, weigh this as an alternative: ' +
        'Gemini models are cheaper on Claude usage and suit routine coding, search and review. ' +
        'Each run starts cold in the session working directory with no memory of this conversation, ' +
        'so give it a complete brief. Its edits land in the working tree: review the diff before relying on it. ' +
        `Takes 1 to ${MAX_PARALLEL} tasks: several tasks run in parallel, one agy process each, and their replies ` +
        'come back together. Separate calls to this tool run one after another, so put work that should happen ' +
        'at once in one call, and give parallel tasks files that do not overlap. ' +
        `Models: ${models.join(', ')}. Leave model out (or "${AUTO}") to have the arne judge pick the model and effort from the brief.`,
      inputSchema: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_PARALLEL,
            description: 'The tasks to run, in parallel when there are several',
            items: {
              type: 'object',
              properties: {
                model: {
                  type: 'string',
                  enum: [AUTO, ...models],
                  description: `The Gemini model slug, or "${AUTO}" (the default) to let the arne judge pick model and effort`,
                },
                description: { type: 'string', description: 'A short (3-5 word) description of the task' },
                prompt: { type: 'string', description: 'The complete brief for the Gemini agent' },
              },
              required: ['description', 'prompt'],
            },
          },
        },
        required: ['tasks'],
      },
      isDeferred: false,
    })
    return next(e)
  })

  on('command.run', { command: 'gemini' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Gemini agents' })
    return { text: 'Gemini agents pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const runs = await read($, running)
    const done = await read($, recent)
    const show = await read($, stepsShown)
    const one = (r: Run, live: boolean) => (
      <Box key={`${live ? 'r' : 'd'}-${r.id ?? r.label}-${r.started ?? ''}`} flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text color={live ? 'suggestion' : r.ok === false ? 'error' : 'success'}>{live ? '›' : r.ok === false ? '✗' : '✓'}</Text>
          <Text weight="semibold" wrap="truncate-end">{r.label}</Text>
        </Box>
        <Box paddingLeft={2}>
          <Text dimColor>
            {r.model}
            {r.seconds !== undefined ? ` · ${r.seconds}s` : r.started ? ` · since ${new Date(r.started).toLocaleTimeString()}` : ''}
            {r.tokens ? ` · ${r.tokens.toLocaleString()} tokens` : ''}
            {r.thinking ? ` · ${r.thinking.toLocaleString()} thinking` : ''}
            {r.tools ? ` · ${r.tools} tool calls` : ''}
          </Text>
        </Box>
        {show && (r.steps ?? []).map((s, i) => (
          <Box key={`${r.id}-${i}`} paddingLeft={2}>
            <Text dimColor={!(live && s === r.activity)} wrap="truncate-end">{live && s === r.activity ? '▸' : '✓'} {s}</Text>
          </Box>
        ))}
        {show && live && r.activity && !(r.steps ?? []).includes(r.activity) && (
          <Box paddingLeft={2}>
            <Text color="suggestion">▸ {r.activity}</Text>
          </Box>
        )}
      </Box>
    )
    return (
      <Box flexDirection="column" rowGap={1}>
        {runs.length === 0 && done.length === 0 && <Text dimColor>No Gemini runs yet.</Text>}
        <Button key="steps" plain label={show ? '▴ collapse steps' : '▾ expand steps'} onPress={() => update($, stepsShown, s => !s)} />
        {runs.map(r => one(r, true))}
        {done.map(r => one(r, false))}
      </Box>
    )
  })

  // Tells Claude, in plain words, that Gemini subagents exist; the tool schema alone is easy to overlook.
  on('prompt.compose', async ($, e, next) => {
    const out = await next(e)
    if (models.length === 0) return out
    const text =
      'Gemini subagents: the user has Gemini models available through the Antigravity CLI. ' +
      'For routine, self-contained work (searching, reading many files, simple edits, first-pass review), ' +
      'consider the mcp__GeminiClaude__delegate tool instead of a Claude subagent: write a complete brief, ' +
      'since it starts with no context, and review any diff it leaves. Prefer Claude for design-heavy or ' +
      'conversation-dependent work. If the user names a Gemini model (hydrogen, argon, flash), use it; otherwise leave model out and the arne judge picks model and effort. ' +
      `To have several Gemini agents work at once, list them as \`tasks\` in one call (up to ${MAX_PARALLEL}): ` +
      'they run in parallel, while separate calls run one after another.'
    return { sections: [...out.sections, { id: 'GeminiClaude:delegate', text, scope: 'session' }] }
  })

  on('tool.call', { tool: 'mcp__GeminiClaude__delegate' }, async ($, e) => {
    const { tasks } = e as unknown as { tasks?: Task[] }
    if (!Array.isArray(tasks) || tasks.length === 0 || tasks.length > MAX_PARALLEL)
      return { result: `Give 1 to ${MAX_PARALLEL} tasks in \`tasks\`, each with model, description and prompt.` }
    const unknown = tasks.find(t => t.model !== undefined && t.model !== AUTO && !models.includes(t.model))
    if (unknown) return { result: `Unknown model "${unknown.model}". Available: ${AUTO}, ${models.join(', ')}` }
    // The engine runs this tool's calls one at a time, so the fan-out happens here, inside one call.
    const replies = await Promise.all(
      tasks.map(async t => {
        if (t.model !== undefined && t.model !== AUTO) return { model: t.model, text: await runAgy($, t.model, t.prompt, t.description) }
        const v = await judge($, t.prompt)
        const model = slugFor(v, models)
        const text = await runAgy($, model, t.prompt, t.description)
        return { model, text: `[arne: ${model}, ${v ? `${v.tier} · ${v.effort} · ${v.reason}` : 'judge gave no verdict, default'}]\n\n${text}` }
      }),
    )
    if (replies.length === 1) return { result: replies[0]!.text }
    const sections = replies.map((r, i) => `## ${i + 1}. ${tasks[i]!.description} (${r.model})\n\n${r.text}`)
    return { result: sections.join('\n\n') }
  })

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const type = e.subagent_type ?? 'general-purpose'
    // Only the main thread's own spawns, never a subagent's.
    if (e.agentId !== undefined || NEVER_ASK.has(type)) return next(e)
    // autoHaiku: the arne judge reads the brief, and a trivial one runs on Haiku. A model Claude named stands.
    if (options.autoHaiku === true && e.model === undefined && (await judge($, e.prompt))?.tier === 'S')
      return next({ ...e, model: 'haiku' })
    // Asking is off unless the user opts in: Claude picks Gemini itself, guided by the prompt.compose section.
    if (options.askOnSpawn !== true || models.length === 0) return next(e)

    const picks = [...models.filter(m => FAVOURITES.test(m)), ...models.filter(m => !FAVOURITES.test(m))].slice(0, 3)
    const claude = `Claude (${type})`
    let answer: string
    try {
      answer = await $.ui.ask(`Which model should run "${e.description}"?`, {
        header: 'Subagent',
        options: [claude, ...picks],
      })
    } catch {
      return next(e) // dismissed, or nobody to ask
    }
    const model = answer.trim()
    if (!models.includes(model)) return next(e)

    const started = Date.now()
    const text = await runAgy($, model, e.prompt, e.description)
    return {
      result: {
        status: 'completed',
        agentId: `gemini-${e.tool_use_id}`,
        agentType: type,
        resolvedModel: model,
        prompt: e.prompt,
        content: [{ type: 'text', text: `[ran on ${model} via agy, picked by the user]\n\n${text}` }],
        totalToolUseCount: 0,
        totalDurationMs: Date.now() - started,
        totalTokens: 0,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
          server_tool_use: null,
          service_tier: null,
          cache_creation: null,
        },
        canContinueAgent: false,
      },
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const runs = await read($, running)
    const done = await read($, recent)
    const open = await read($, isOpen)
    const now = runs[runs.length - 1] // the latest-started run still in flight
    const shown: Run | null = now ?? done[0] ?? null
    if (e.props.hasSurvey || models.length === 0 || (await read($, isHidden))) return next(e)
    const ui = e.surface === 'terminal' ? { ...$.ui.resolve(e), Svg: undefined } : $.ui.resolve(e) // the terminal answers Svg with an empty Box
    const { Box, Button, Text } = ui
    const below = await next(e) // other mods' bands stack under this one
    const tokens = shown?.tokens ? ` · ${shown.tokens.toLocaleString()} tokens` : ''
    const status =
      shown === null
        ? `ready · ${models.length} models`
        : runs.length > 1
          ? `${runs.length} agents`
          : now
            ? `${shown.model} · ${shown.label}${shown.activity ? ` · ${shown.activity}` : ""}${live(shown)}`
            : `${shown.model} · ${shown.label} · ${shown.seconds}s${tokens}${shown.tools ? ` · ${shown.tools} tools` : ''}`
    const mark = shown === null || now ? null : shown.ok === false ? '✗' : '✓'
    return (
      <Box flexDirection="column" rowGap={e.surface === 'terminal' ? 0 : 1}>
        {/* The apps draw their own panel behind the band, so a box of the mod's would be a box in a box: only the terminal gets the outline. */}
        <Box flexDirection="column" borderStyle={e.surface === 'terminal' ? 'round' : undefined} borderColor="promptBorder" paddingX={1}>
          <Box flexDirection="row" alignItems="center" gap={1}>
            {icon(ui, 'sparkles', 'accent', 16)}
            <Text weight="semibold">Gemini</Text>
            {now && icon(ui, 'running', 'accent')}{now && <Text color="suggestion">running</Text>}
            {mark && icon(ui, mark === '✓' ? 'check' : 'x', mark === '✓' ? 'ok' : 'error')}
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Text dimColor wrap="truncate-end">{status}</Text>
            </Box>
            <Button key="details" plain label="Details" onPress={() => $.ui.open({ id: PANE, title: 'Gemini agents' })} />
            {icon(ui, open ? 'up' : 'down')}
            <Button key="agents" plain label="agents" onPress={() => update($, isOpen, o => !o)} />
            <Button key="hide" plain label="Hide" onPress={() => update($, isHidden, () => true)} />
          </Box>
          {/* One row per agent still in flight; a finished one drops off. */}
          {(open || runs.length > 1) &&
            runs.map(r => (
              <Box key={String(r.id)} flexDirection="column">
                <Box flexDirection="row" gap={1}>
                  {icon(ui, 'running', 'accent')}
                  <Box flexGrow={1} flexShrink={1} minWidth={0}>
                    <Text wrap="truncate-end">{r.label}</Text>
                  </Box>
                  {/* ponytail: start time, not a live counter; tick an atom with $.clock.every if one is wanted. */}
                  <Text dimColor>{r.model}{open && r.started ? ` · since ${new Date(r.started).toLocaleTimeString()}` : ''}{live(r)}</Text>
                </Box>
                {/* What the agent is doing now, and the steps before it. */}
                {(open ? (r.steps ?? []).filter(s => s !== r.activity).slice(-4) : []).map((s, i) => (
                  <Box key={`${r.id}-s${i}`} paddingLeft={2}>
                    <Text dimColor wrap="truncate-end">✓ {s}</Text>
                  </Box>
                ))}
                {r.activity && (
                  <Box paddingLeft={2}>
                    <Text color="suggestion" wrap="truncate-end">▸ {r.activity}</Text>
                  </Box>
                )}
              </Box>
            ))}
          {open && runs.length === 0 && <Text dimColor>no agents running</Text>}
          {open &&
            done.map((r, i) => (
              <Box key={`done-${i}`} flexDirection="row" gap={1}>
                {icon(ui, r.ok === false ? 'x' : 'check', r.ok === false ? 'error' : 'ok')}
                <Box flexGrow={1} flexShrink={1} minWidth={0}>
                  <Text dimColor wrap="truncate-end">{r.label}</Text>
                </Box>
                <Text dimColor>{r.model} · {r.seconds}s{r.tokens ? ` · ${r.tokens.toLocaleString()} tokens` : ''}</Text>
              </Box>
            ))}
        </Box>
        {below}
      </Box>
    )
  })
}

// Lucide icons (ISC licence), 24px viewBox, as inner SVG markup.
const ICONS = {
  sparkles: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4M22 5h-4M4 17v2M5 18H3"/>',
  running: '<path d="M21 12a9 9 0 1 1-6.219-8.56"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/></path>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  up: '<path d="m18 15-6-6-6 6"/>',
} as const
// Colourblind-safe: blue for ok/accent, orange for failure (not green/red).
const TONE = { accent: '#58a6ff', ok: '#58a6ff', error: '#f0883e', dim: '#8b949e' } as const
const GLYPH = { sparkles: '✦', running: '›', check: '✓', x: '✗', down: '▾', up: '▴' } as const
const COLOR = { accent: 'suggestion', ok: 'success', error: 'error', dim: undefined } as const

/// A Lucide icon where the surface can draw SVG, the old glyph in the terminal.
function icon(ui: any, name: keyof typeof ICONS, tone: keyof typeof TONE = 'dim', size = 14) {
  const { Svg, Text } = ui
  if (!Svg) return <Text color={COLOR[tone]}>{GLYPH[name]}</Text>
  const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="${TONE[tone]}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`
  return <Svg source={source} alt={name} width={size} height={size} isInteractive={name === 'running'} />
}

/// The live counters of a run in flight, as a suffix: " · 3 tools · 120 thinking".
function live(r: Run): string {
  return `${r.tools ? ` · ${r.tools} tools` : ''}${r.thinking ? ` · ${r.thinking.toLocaleString()} thinking` : ''}`
}

/// arne's Haiku judge on a brief: tier and effort, or undefined when it doesn't answer in time or in shape.
async function judge($: EngineInterface, brief: string): Promise<Verdict | undefined> {
  try {
    const r = await $.model.complete({ model: 'haiku', prompt: brief.slice(0, 4000), system: JUDGE, effort: 'low', timeoutMs: 3000 })
    const m = r.isAnswered ? r.text.match(/\{[\s\S]*\}/) : null
    const v = m ? JSON.parse(m[0]) : undefined
    if (!['S', 'M', 'L'].includes(v?.tier) || !['low', 'medium', 'high'].includes(v?.effort)) return undefined
    return { tier: v.tier, effort: v.effort, reason: String(v.reason ?? '').slice(0, 80) }
  } catch {
    return undefined
  }
}

/// A verdict to an agy slug: the tier's family at the verdict's effort (L at high), else the nearest that exists.
function slugFor(v: Verdict | undefined, slugs: string[]): string {
  const { tier, effort } = v ?? { tier: 'M' as Tier, effort: 'medium' }
  const family = slugs.filter(s => s.includes(FAMILY[tier]))
  const want = tier === 'L' ? 'high' : effort
  return (
    family.find(s => s.endsWith(`-${want}`)) ??
    family.find(s => s.endsWith('-medium')) ??
    family[0] ??
    slugs.find(s => FAVOURITES.test(s)) ??
    slugs[0]!
  )
}

/// The model slugs agy offers this account, read off `agy models`. Also settles `agy`:
/// an app launched before agy's installer edited PATH can't find it by name, so fall
/// back to the installer's own location.
async function listModels($: EngineInterface): Promise<string[]> {
  const local = await $.env.get('LOCALAPPDATA')
  const candidates = ['agy', ...(local ? [`${local}\\agy\\bin\\agy.exe`] : [])]
  for (const bin of candidates) {
    try {
      const { exitCode, stdout } = await $.process.run([bin, 'models'])
      if (exitCode !== 0) continue
      agy = bin
      // ponytail: takes each line's first token that looks like a slug; adjust if agy's table changes.
      return stdout
        .split('\n')
        .map(line => line.trim().split(/\s+/)[0] ?? '')
        .filter(slug => /^[a-z][a-z0-9.-]*-[a-z0-9.-]+$/.test(slug))
    } catch {
      // not runnable at this path; try the next
    }
  }
  return []
}

/// Runs one headless agy task and answers its reply, or why it failed. The band above the prompt follows it.
async function runAgy($: EngineInterface, model: string, prompt: string, label: string): Promise<string> {
  const started = Date.now()
  const id = ++seq
  let out: { text: string; ok: boolean; tokens?: number; thinking?: number; tools?: number; steps?: string[] } = { text: '', ok: false }
  const patch = (p: Partial<Run>) => inOrder(() => update($, running, runs => runs.map(r => (r.id === id ? { ...r, ...p } : r))))
  try {
    await inOrder(() => update($, running, runs => [...runs, { id, model, label, started, activity: 'starting…' }]))
    await update($, isHidden, () => false)
    out = await callAgy($, model, prompt, patch)
    return out.text
  } finally {
    const seconds = Math.round((Date.now() - started) / 100) / 10
    // `recent` first, so the band never draws the previous result between the two writes.
    await update($, recent, rs =>
      [{ model, label, seconds, tokens: out.tokens, thinking: out.thinking, tools: out.tools, steps: out.steps, ok: out.ok }, ...rs].slice(0, MAX_RECENT),
    )
    await inOrder(() => update($, running, runs => runs.filter(r => r.id !== id)))
  }
}

/// One line for a tool step: its name and the first string argument (a command, a path, a query).
function describe(s: { tool_name?: string; tool_info?: { parameters?: Record<string, unknown> } }): string {
  const arg = Object.values(s.tool_info?.parameters ?? {}).find(v => typeof v === 'string') as string | undefined
  const one = (arg ?? '').replace(/\s+/g, ' ').trim()
  return `${s.tool_name ?? 'tool'}${one ? ` ${one.length > 70 ? `${one.slice(0, 70)}…` : one}` : ''}`
}

/// Runs agy with `--output-format stream-json` and feeds each event to `patch`, so the band shows
/// the tool it is on, a token and thinking count, and the last few steps. Resolves with the final reply.
async function callAgy(
  $: EngineInterface,
  model: string,
  prompt: string,
  patch: (p: Partial<Run>) => Promise<unknown>,
): Promise<{ text: string; ok: boolean; tokens?: number; thinking?: number; tools?: number; steps?: string[] }> {
  if (prompt.length > MAX_PROMPT)
    return {
      text: `The brief is ${prompt.length} characters, over the ${MAX_PROMPT} limit. Write the long part to a file in the working directory and name that file in a shorter brief.`,
      ok: false,
    }
  let buf = ''
  let err = ''
  let reply = ''
  let writing = false
  let steps: string[] = []
  let tokens = 0
  let thinking = 0
  let tools = 0
  let final: { status?: string; response?: string; error?: unknown; usage?: { total_tokens?: number; thinking_tokens?: number } } | undefined
  const handle = async (line: string) => {
    let ev: any
    try {
      ev = JSON.parse(line)
    } catch {
      return
    }
    if (ev?.event === 'result') {
      final = ev.result ?? {}
      return
    }
    const s = ev?.step_update
    if (ev?.event !== 'step_update' || !s) return
    if (s.step_type === 'tool' && s.state === 'ACTIVE') {
      writing = false
      tools++
      const now = describe(s)
      steps = [...steps, now].slice(-MAX_STEPS)
      await patch({ activity: now, steps, tools })
    } else if (s.step_type === 'agent_response') {
      if (typeof s.text_delta === 'string') {
        reply += s.text_delta
        // Once per stretch of writing, not per delta, so the band doesn't redraw on every word.
        if (!writing) {
          writing = true
          await patch({ activity: 'writing reply…' })
        }
      }
      if (s.usage) {
        tokens += s.usage.total_tokens ?? 0
        thinking += s.usage.thinking_tokens ?? 0
        await patch({ tokens, thinking })
      }
    }
  }
  let code: number | null = null
  try {
    const proc = $.process.spawn({ argv: [agy, '-p', prompt, '--model', model, '--output-format', 'stream-json'] })
    // ponytail: the cap is checked when output arrives, so a silent hang is not cut; kill it from the band if that bites.
    const deadline = Date.now() + MAX_RUN
    await patch({ activity: 'thinking…' })
    for (;;) {
      const n = await proc.next()
      if (n.done) {
        code = n.value.code
        break
      }
      if (n.value.stream === 'stderr') {
        err += n.value.text
        continue
      }
      buf += n.value.text
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) await handle(line)
      if (Date.now() > deadline) {
        await proc.return(undefined as never) // ends the loop, which kills the child
        return { text: `agy was stopped after ${MAX_RUN / 60_000} minutes.`, ok: false, tokens, thinking, tools, steps }
      }
    }
    if (buf.trim()) await handle(buf)
  } catch (err2) {
    return { text: `agy did not finish: ${String(err2)}`, ok: false, tokens, thinking, tools, steps }
  }
  const total = final?.usage?.total_tokens ?? tokens
  const think = final?.usage?.thinking_tokens ?? thinking
  if (!final)
    return { text: reply.trim() || `agy exited ${code}: ${err.trim()}`, ok: false, tokens: total, thinking: think, tools, steps }
  if (final.error || (code !== null && code !== 0)) {
    const why = final.error ? (typeof final.error === 'string' ? final.error : JSON.stringify(final.error)) : err.trim()
    return { text: `agy failed (${final.status ?? `exit ${code}`}): ${why}`, ok: false, tokens: total, thinking: think, tools, steps }
  }
  const denied = err.trim() ? `\n\nagy notices (soft-denied actions show here):\n${err.trim()}` : ''
  return { text: `${final.response ?? reply}${denied}`, ok: true, tokens: total, thinking: think, tools, steps }
}
