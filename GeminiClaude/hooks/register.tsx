import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Run } from '../types'

const running = atom({ plugin: 'GeminiClaude', key: 'running' } as const, [])
const last = atom({ plugin: 'GeminiClaude', key: 'last' } as const, null)
const isHidden = atom({ plugin: 'GeminiClaude', key: 'isHidden' } as const, false)

// Agent types a Gemini run can't stand in for: a fork needs this conversation,
// web-fetch stands in for the WebFetch tool.
const NEVER_ASK = new Set(['fork', 'web-fetch'])
// ponytail: favours the two families named when this was written; edit to taste.
const FAVOURITES = /hydrogen|argon/
const TEN_MINUTES = 600_000
// Windows caps a command line at 32767 characters, and agy takes the prompt only as an argument.
const MAX_PROMPT = 30_000
// ponytail: a guess at what the plan's unpublished rate limit bears; raise it if runs don't get throttled.
const MAX_PARALLEL = 5

/// Model slugs `agy models` listed at session start; empty when agy is missing.
let models: string[] = []
/// How to invoke agy: its name on PATH, or its full install path when PATH lacks it.
let agy = 'agy'
/// Numbers each run, so a finished one can be taken off the `running` list.
let seq = 0

type Task = { model: string; description: string; prompt: string }

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    // A reload mid-run would otherwise leave the band stuck on "running".
    await update($, running, () => [])
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
        `Models: ${models.join(', ')}.`,
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
                model: { type: 'string', enum: models, description: 'The Gemini model slug' },
                description: { type: 'string', description: 'A short (3-5 word) description of the task' },
                prompt: { type: 'string', description: 'The complete brief for the Gemini agent' },
              },
              required: ['model', 'description', 'prompt'],
            },
          },
        },
        required: ['tasks'],
      },
      isDeferred: false,
    })
    return next(e)
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
      'conversation-dependent work. If the user names a Gemini model (hydrogen, argon, flash), use it. ' +
      `To have several Gemini agents work at once, list them as \`tasks\` in one call (up to ${MAX_PARALLEL}): ` +
      'they run in parallel, while separate calls run one after another.'
    return { sections: [...out.sections, { id: 'GeminiClaude:delegate', text, scope: 'session' }] }
  })

  on('tool.call', { tool: 'mcp__GeminiClaude__delegate' }, async ($, e) => {
    const { tasks } = e as unknown as { tasks?: Task[] }
    if (!Array.isArray(tasks) || tasks.length === 0 || tasks.length > MAX_PARALLEL)
      return { result: `Give 1 to ${MAX_PARALLEL} tasks in \`tasks\`, each with model, description and prompt.` }
    const unknown = tasks.find(t => !models.includes(t.model))
    if (unknown) return { result: `Unknown model "${unknown.model}". Available: ${models.join(', ')}` }
    // The engine runs this tool's calls one at a time, so the fan-out happens here, inside one call.
    const replies = await Promise.all(tasks.map(t => runAgy($, t.model, t.prompt, t.description)))
    if (replies.length === 1) return { result: replies[0] }
    const sections = replies.map((text, i) => `## ${i + 1}. ${tasks[i]!.description} (${tasks[i]!.model})\n\n${text}`)
    return { result: sections.join('\n\n') }
  })

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const type = e.subagent_type ?? 'general-purpose'
    // Ask only for the main thread's own spawns, never a subagent's.
    // Off unless the user opts in: Claude picks Gemini itself, guided by the prompt.compose section.
    if (options.askOnSpawn !== true || models.length === 0 || e.agentId !== undefined || NEVER_ASK.has(type))
      return next(e)

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
    const done = await read($, last)
    const now = runs[runs.length - 1] // the latest-started run still in flight
    const shown: Run | null = now ?? done
    if (e.props.hasSurvey || models.length === 0 || (await read($, isHidden))) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const below = await next(e) // other mods' bands stack under this one
    const tokens = shown?.tokens ? ` · ${shown.tokens.toLocaleString()} tokens` : ''
    const status =
      shown === null
        ? `ready · ${models.length} models`
        : runs.length > 1
          ? `${runs.length} agents`
          : now
            ? `${shown.model} · ${shown.label}…`
            : `${shown.model} · ${shown.label} · ${shown.seconds}s${tokens}`
    const mark = shown === null || now ? null : shown.ok === false ? '✗' : '✓'
    return (
      <Box flexDirection="column" rowGap={e.surface === 'terminal' ? 0 : 1}>
        <Box flexDirection="column" borderStyle="round" borderColor="promptBorder" paddingX={1}>
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Text color="suggestion">✦</Text>
            <Text weight="semibold">Gemini</Text>
            {now && <Text color="suggestion">running</Text>}
            {mark && <Text color={mark === '✓' ? 'success' : 'error'}>{mark}</Text>}
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Text dimColor wrap="truncate-end">{status}</Text>
            </Box>
            <Button key="hide" plain label="Hide" onPress={() => update($, isHidden, () => true)} />
          </Box>
          {/* One row per agent still in flight; a finished one drops off. */}
          {runs.length > 1 &&
            runs.map(r => (
              <Box key={String(r.id)} flexDirection="row" gap={1}>
                <Text color="suggestion">›</Text>
                <Box flexGrow={1} flexShrink={1} minWidth={0}>
                  <Text wrap="truncate-end">{r.label}</Text>
                </Box>
                <Text dimColor>{r.model}</Text>
              </Box>
            ))}
        </Box>
        {below}
      </Box>
    )
  })
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
  let out: { text: string; ok: boolean; tokens?: number } = { text: '', ok: false }
  try {
    await update($, running, runs => [...runs, { id, model, label }])
    await update($, isHidden, () => false)
    out = await callAgy($, model, prompt)
    return out.text
  } finally {
    const seconds = Math.round((Date.now() - started) / 100) / 10
    // `last` first, so the band never draws the previous result between the two writes.
    await update($, last, () => ({ model, label, seconds, tokens: out.tokens, ok: out.ok }))
    await update($, running, runs => runs.filter(r => r.id !== id))
  }
}

async function callAgy($: EngineInterface, model: string, prompt: string): Promise<{ text: string; ok: boolean; tokens?: number }> {
  if (prompt.length > MAX_PROMPT)
    return {
      text: `The brief is ${prompt.length} characters, over the ${MAX_PROMPT} limit. Write the long part to a file in the working directory and name that file in a shorter brief.`,
      ok: false,
    }
  try {
    // ponytail: $.process.run caps a run at ten minutes; stream with $.process.spawn if tasks run longer.
    const run = await $.process.run([agy, '-p', prompt, '--model', model, '--output-format', 'json'], {
      timeoutMs: TEN_MINUTES,
    })
    let reply: { response?: string; error?: unknown; status?: string; usage?: { total_tokens?: number } } = {}
    try {
      reply = JSON.parse(run.stdout) ?? {}
    } catch {
      return { text: run.stdout.trim() || `agy exited ${run.exitCode}: ${run.stderr.trim()}`, ok: false }
    }
    const tokens = reply.usage?.total_tokens
    if (reply.error || run.exitCode !== 0) {
      const why = reply.error ? (typeof reply.error === 'string' ? reply.error : JSON.stringify(reply.error)) : run.stderr.trim()
      return { text: `agy failed (${reply.status ?? `exit ${run.exitCode}`}): ${why}`, ok: false, tokens }
    }
    const denied = run.stderr.trim() ? `\n\nagy notices (soft-denied actions show here):\n${run.stderr.trim()}` : ''
    return { text: `${reply.response ?? ''}${denied}`, ok: true, tokens }
  } catch (err) {
    return { text: `agy did not finish: ${String(err)}`, ok: false }
  }
}
