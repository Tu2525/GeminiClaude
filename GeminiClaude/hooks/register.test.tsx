import { expect, test } from 'claude-code/testing'

// The test runner has timers; the mod's own type-check config (no DOM, no node types) does not declare them.
declare const setTimeout: (fn: (value?: unknown) => void, ms: number) => unknown

const MODELS = `Fetching available models...
gemini-4-argon-medium\tGemini 4 Argon (Medium)
gemini-4-argon-high\tGemini 4 Argon (High)
gemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)
gemini-pro-orchestrator-g1-pro\tOrchestrator (Argon)
gemini-3.8-flash-low\tGemini 3.8 Flash (Low)
claude-opus-5-5-low\tClaude Opus 5.5 (Low)
gpt-oss-120b-medium\tGPT-OSS 120B (Medium)
`
const SLUGS = [
  'gemini-4-argon-medium',
  'gemini-4-argon-high',
  'gemini-4-hydrogen-low',
  'gemini-pro-orchestrator-g1-pro',
  'gemini-3.8-flash-low',
  'claude-opus-5-5-low',
  'gpt-oss-120b-medium',
]
const OK = {
  exitCode: 0,
  stderr: '',
  stdout:
    '{"conversation_id":"cbb68b52","status":"SUCCESS","response":"pong\\n","duration_seconds":2.57,"num_turns":1,"usage":{"input_tokens":12263,"output_tokens":1,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":12264}}',
}
const FAIL = {
  exitCode: 1,
  stderr: 'error: boom happened',
  stdout:
    '{"conversation_id":"","status":"ERROR","response":"","error":"boom happened","duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0},"finished_reason":"error"}',
}
type Run = { exitCode: number; stdout: string; stderr: string }
const MODEL = 'gemini-3.8-flash-low'
const LOCAL = 'C:\\L'
const BAND = (surface: 'terminal' | 'desktop') =>
  ({
    plugin: 'GeminiClaude',
    component: 'AbovePrompt',
    surface,
    props: {
      hasSurvey: false,
      isCollapsed: false,
      isWorking: false,
      maxRows: 20,
      bodyColumns: 80,
      scroll: { offset: 0, bodyRows: 20 },
      view: {},
    },
  }) as const

/** Installs engine stubs and starts the session. `agyRun` answers `-p` runs; every argv is recorded. */
async function boot(
  $: any,
  on: any,
  agyRun: (argv: string[]) => Run | Promise<Run> = () => OK,
  models: Run | 'missing' = { exitCode: 0, stdout: MODELS, stderr: '' },
) {
  const argvs: string[][] = []
  const tools: any[] = []
  const status: (string | undefined)[] = []
  on('env.get', () => ({ value: LOCAL }))
  const store = new Map<string, unknown>()
  on('store.get', (_: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_: any, e: any) => (store.set(e.key, e.value), { value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('tool.register', (_: any, e: any) => {
    tools.push(e)
    return { value: { tool: e.name } }
  })
  on('ui.status', (_: any, e: any) => {
    status.push(e.text)
    return { value: undefined }
  })
  on('process.run', async (_: any, e: any) => {
    argvs.push([...e.argv])
    if (models === 'missing') throw new Error('ENOENT')
    return { value: models }
  })
  // agyRun still answers with the old one-shot envelope; the stub replays it as agy's stream: the envelope as the `result` event.
  on('process.spawn', async function* (_: any, e: any) {
    argvs.push([...e.argv])
    const r = await agyRun([...e.argv])
    let env: any
    try {
      env = JSON.parse(r.stdout)
    } catch {}
    if (env && typeof env === 'object') yield { stream: 'stdout', text: JSON.stringify({ event: 'result', result: env }) + '\n' }
    else if (r.stdout.trim()) yield { stream: 'stdout', text: r.stdout }
    if (r.stderr) yield { stream: 'stderr', text: r.stderr }
    return { value: { code: r.exitCode, signal: null } }
  })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const delegate = (model: string, prompt: string, description = 'd') =>
    $.tool.call({ tool: 'mcp__GeminiClaude__delegate', tasks: [{ model, description, prompt }] })
  const batch = (tasks: { model: string; description: string; prompt: string }[]) =>
    $.tool.call({ tool: 'mcp__GeminiClaude__delegate', tasks })
  const runs = () => argvs.filter(a => a[1] === '-p')
  return { argvs, tools, status, delegate, batch, runs }
}
const text = (r: any): string => String(r?.result?.result ?? r?.result ?? '')

test('1 model enum is the 7 slugs in order', async ($, on) => {
  const t = await boot($, on)
  expect(t.tools.length).toBe(1)
  expect(t.tools[0].name).toBe('delegate')
  expect(t.tools[0].inputSchema.properties.tasks.items.properties.model.enum).toEqual(['auto', ...SLUGS])
})

test('2 agy missing: no tool, status says so', async ($, on) => {
  const t = await boot($, on, undefined, 'missing')
  expect(t.tools.length).toBe(0)
  expect(t.status.some(s => s?.includes('agy not found'))).toBe(true)
})

test('3 success returns pong with exact argv', async ($, on) => {
  const t = await boot($, on)
  const r = text(await t.delegate(MODEL, 'say pong'))
  expect(r.startsWith('pong')).toBe(true)
  expect(t.runs()).toEqual([['agy', '-p', 'say pong', '--model', MODEL, '--output-format', 'stream-json']])
})

test('4 unknown model is refused without running', async ($, on) => {
  const t = await boot($, on)
  const r = text(await t.delegate('hydrogen', 'x'))
  expect(r).toContain('Unknown model "hydrogen"')
  for (const s of SLUGS) expect(r).toContain(s)
  expect(t.runs().length).toBe(0)
})

test('5 error envelope: reason once, no soft-denied', async ($, on) => {
  const t = await boot($, on, () => FAIL)
  const r = text(await t.delegate(MODEL, 'x'))
  expect(r).toContain('agy failed (ERROR)')
  expect(r.split('boom happened').length - 1).toBe(1)
  expect(r).not.toContain('soft-denied')
})

test('6 non-zero exit without error field is a failure', async ($, on) => {
  const t = await boot($, on, () => ({ exitCode: 3, stdout: '{"status":"SUCCESS","response":""}', stderr: 'disk full' }))
  const r = text(await t.delegate(MODEL, 'x'))
  expect(r).toContain('agy failed')
  expect(r).toContain('disk full')
})

test('7 unparseable output reports exit code and stderr', async ($, on) => {
  const t = await boot($, on, () => ({ exitCode: 2, stdout: '\n', stderr: 'crashed\n' }))
  const r = text(await t.delegate(MODEL, 'x'))
  expect(r).toContain('agy exited 2')
  expect(r).toContain('crashed')
})

test('8 null JSON does not throw', async ($, on) => {
  const t = await boot($, on, () => ({ exitCode: 0, stdout: 'null', stderr: '' }))
  const r = await t.delegate(MODEL, 'x')
  expect(typeof (r.result?.result ?? r.result)).toBe('string')
})

test('9 prompt limit: 30001 refused, 30000 runs', async ($, on) => {
  const t = await boot($, on)
  const r = text(await t.delegate(MODEL, 'a'.repeat(30001)))
  expect(r).toContain('30000')
  expect(t.runs().length).toBe(0)
  await t.delegate(MODEL, 'a'.repeat(30000))
  expect(t.runs().length).toBe(1)
})

test('10 soft-denied notices ride along on success', async ($, on) => {
  const t = await boot($, on, () => ({ ...OK, stderr: 'denied: write_file(x)' }))
  const r = text(await t.delegate(MODEL, 'x'))
  expect(r).toContain('pong')
  expect(r).toContain('soft-denied')
  expect(r).toContain('denied: write_file(x)')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`11 band on ${surface}`, async ($, on) => {
    let next: Run = OK
    const t = await boot($, on, () => next)
    let ui = await $.ui.mount(BAND(surface))
    expect((await ui.find({ type: 'Text', text: /ready · 7 models/ }))?.text).toMatch(/ready · 7 models/)
    await ui.unmount()

    await t.delegate(MODEL, 'x', 'my label')
    ui = await $.ui.mount(BAND(surface))
    const line = (await ui.find({ type: 'Text', text: new RegExp(MODEL) }))?.text ?? ''
    expect(line).toContain('my label')
    expect(line).toMatch(/12.?264 tokens/)
    expect(await ui.find(surface === 'terminal' ? { type: 'Text', text: /✓/ } : { type: 'Svg' })).toBeTruthy()
    await ui.unmount()

    next = FAIL
    await t.delegate(MODEL, 'x', 'bad run')
    ui = await $.ui.mount(BAND(surface))
    expect(await ui.find(surface === 'terminal' ? { type: 'Text', text: /✗/ } : { type: 'Svg' })).toBeTruthy()
    await ui.unmount()
  })
}

test('12 overlapping runs stay "running" until the last finishes', async ($, on) => {
  const gates: ((r: Run) => void)[] = []
  const t = await boot($, on, () => new Promise<Run>(res => gates.push(res)))
  const a = t.delegate(MODEL, 'one', 'first')
  const b = t.delegate(MODEL, 'two', 'second')
  while (gates.length < 2) await new Promise(r => setTimeout(r, 5))

  gates[0]!(OK)
  await a
  let ui = await $.ui.mount(BAND('terminal'))
  expect(await ui.find({ type: 'Text', text: /running/ })).toBeTruthy()
  await ui.unmount()

  gates[1]!(OK)
  await b
  ui = await $.ui.mount(BAND('terminal'))
  expect(await ui.find({ type: 'Text', text: /running/ })).toBeFalsy()
  await ui.unmount()
})

test('13 a run left active before a reload is not shown as running', async ($, on) => {
  // The stored value answers once (what the previous process left); later reads fall to the kit's own state.
  let stale = true
  on('state.get', (_: any, e: any, next: any) => {
    if (e.plugin === 'GeminiClaude' && e.key === 'running' && stale) {
      stale = false
      return { value: { value: [{ id: 1, model: MODEL, label: 'old run' }], version: 1 } }
    }
    return next(e)
  })
  await boot($, on)
  const ui = await $.ui.mount(BAND('terminal'))
  expect(await ui.find({ type: 'Text', text: /running/ })).toBeFalsy()
  await ui.unmount()
})

test('14 tasks in one call run in parallel and come back labelled', { timeoutMs: 20000 }, async ($, on) => {
  const gates: ((r: Run) => void)[] = []
  const t = await boot($, on, () => new Promise<Run>(res => gates.push(res)))
  const call = t.batch([
    { model: MODEL, description: 'first job', prompt: 'one' },
    { model: 'gemini-4-argon-high', description: 'second job', prompt: 'two' },
  ])
  // Both agy processes are started before either has answered.
  while (gates.length < 2) await new Promise(r => setTimeout(r, 5))
  expect(t.runs().map(a => a[2])).toEqual(['one', 'two'])

  // The band lists each agent in flight on its own row, with its model.
  let ui = await $.ui.mount(BAND('terminal'))
  expect(await ui.find({ type: 'Text', text: /2 agents/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: 'first job' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: 'second job' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: 'gemini-4-argon-high' })).toBeTruthy()
  await ui.unmount()

  // A finished agent drops off; the one left shows on the single line.
  gates[1]!({ ...OK, stdout: OK.stdout.replace('pong', 'second reply') })
  while (await (async () => {
    ui = await $.ui.mount(BAND('terminal'))
    const still = await ui.find({ type: 'Text', text: 'second job' })
    await ui.unmount()
    return still
  })()) await new Promise(r => setTimeout(r, 5))
  ui = await $.ui.mount(BAND('terminal'))
  expect(await ui.find({ type: 'Text', text: /first job/ })).toBeTruthy()
  await ui.unmount()

  gates[0]!({ ...OK, stdout: OK.stdout.replace('pong', 'first reply') })
  const r = text(await call)
  expect(r).toContain('## 1. first job (' + MODEL + ')')
  expect(r).toContain('## 2. second job (gemini-4-argon-high)')
  expect(r.indexOf('first reply')).toBeLessThan(r.indexOf('second reply'))
})

test('15 a bad model in any task refuses the whole call', async ($, on) => {
  const t = await boot($, on)
  const r = text(await t.batch([
    { model: MODEL, description: 'a', prompt: 'x' },
    { model: 'hydrogen', description: 'b', prompt: 'y' },
  ]))
  expect(r).toContain('Unknown model "hydrogen"')
  expect(t.runs().length).toBe(0)
})

test('16 no tasks, or more than 5, is refused', async ($, on) => {
  const t = await boot($, on)
  const six = Array.from({ length: 6 }, (_, i) => ({ model: MODEL, description: `t${i}`, prompt: 'x' }))
  expect(text(await t.batch(six))).toContain('1 to 5 tasks')
  expect(text(await t.batch([]))).toContain('1 to 5 tasks')
  expect(t.runs().length).toBe(0)
})

test('17 auto: the arne judge picks family and effort from the brief', async ($, on) => {
  let verdict = '{"tier":"S","effort":"low","reason":"a lookup"}'
  const asked: any[] = []
  on('model.complete', (_: any, e: any) => (asked.push(e), { value: { text: verdict, isAnswered: true } as any }))
  const t = await boot($, on)
  const go = async (model?: string) => {
    await $.tool.call({ tool: 'mcp__GeminiClaude__delegate', tasks: [{ ...(model ? { model } : {}), description: 'd', prompt: 'find X' }] })
    return t.runs().at(-1)![4]
  }
  expect(await go()).toBe('gemini-4-hydrogen-low')
  expect(asked[0].prompt).toBe('find X')
  verdict = '{"tier":"M","effort":"medium","reason":"edit"}'
  expect(await go('auto')).toBe('gemini-4-argon-medium')
  verdict = '{"tier":"L","effort":"low","reason":"race"}'
  expect(await go()).toBe('gemini-4-argon-high') // L always runs at high
  verdict = 'no json here'
  expect(await go()).toBe('gemini-4-argon-medium') // no verdict: M · medium
  verdict = '{"tier":"M","effort":"high","reason":"careful"}'
  expect(await go()).toBe('gemini-4-argon-high')
  expect(asked.length).toBe(5)
  await go(MODEL) // an explicit slug skips the judge
  expect(asked.length).toBe(5)
})

test('18 the agents dropdown lists running agents, then finished ones', { timeoutMs: 20000 }, async ($, on) => {
  const gates: ((r: Run) => void)[] = []
  const t = await boot($, on, () => new Promise<Run>(res => gates.push(res)))
  const a = t.delegate(MODEL, 'one', 'slow job')
  while (gates.length < 1) await new Promise(r => setTimeout(r, 5))

  let ui = await $.ui.mount(BAND('terminal'))
  expect(await ui.find({ type: 'Text', text: /since/ })).toBeFalsy()
  await ui.press({ key: 'agents' })
  expect(await ui.find({ type: 'Text', text: /^slow job$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: new RegExp(`${MODEL} · since`) })).toBeTruthy()
  await ui.unmount()

  gates[0]!(OK)
  await a
  ui = await $.ui.mount(BAND('terminal')) // still open: the choice is session state
  expect(await ui.find({ type: 'Text', text: /no agents running/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^slow job$/ })).toBeTruthy()
  await ui.press({ key: 'agents' })
  expect(await ui.find({ type: 'Text', text: /no agents running/ })).toBeFalsy()
  await ui.unmount()
})

test('19 the band is outlined on the terminal and flat in the apps', async ($, on) => {
  await boot($, on)
  let ui = await $.ui.mount(BAND('terminal'))
  expect(JSON.stringify(await ui.drawn())).toContain('"borderStyle":"round"')
  await ui.unmount()
  ui = await $.ui.mount(BAND('desktop'))
  expect(JSON.stringify(await ui.drawn())).not.toContain('borderStyle')
  await ui.unmount()
})

test('20 autoHaiku: a trivial subagent brief runs on Haiku', { options: { autoHaiku: true } }, async ($, on) => {
  let verdict = '{"tier":"S","effort":"low","reason":"a lookup"}'
  let asked = 0
  const spawned: any[] = []
  on('model.complete', () => (asked++, { value: { text: verdict, isAnswered: true } as any }))
  on('tool.call', { tool: 'Agent' }, (_: any, e: any) => (spawned.push(e), { result: 'ran' }))
  await boot($, on)
  const spawn = (extra: object = {}) => $.tool.call({ tool: 'Agent', description: 'd', prompt: 'find x', ...extra } as any)

  await spawn()
  expect(spawned[0].model).toBe('haiku')

  verdict = '{"tier":"M","effort":"medium","reason":"normal coding"}'
  await spawn()
  expect(spawned[1].model).toBeUndefined()

  // A model Claude named, a subagent's own spawn and a fork are left alone, unjudged.
  asked = 0
  await spawn({ model: 'opus' })
  await spawn({ agentId: 'a1' })
  await spawn({ subagent_type: 'fork' })
  expect(spawned[2].model).toBe('opus')
  expect(spawned[3].model).toBeUndefined()
  expect(asked).toBe(0)
})

const compose = async ($: any) => JSON.stringify(await $.prompt.compose({ promptModel: 'haiku', outputStyle: null, tools: [], traits: [], surfaces: [], sections: [] }))
test('23 managerSession (default on): the prompt routes delegate through a Haiku session', async ($, on) => {
  on('prompt.compose', (_: any, e: any) => ({ sections: e.sections }))
  await boot($, on)
  expect(await compose($)).toContain('start_session')
})
test('24 managerSession off: no manager wording', { options: { managerSession: false } }, async ($, on) => {
  on('prompt.compose', (_: any, e: any) => ({ sections: e.sections }))
  await boot($, on)
  expect(await compose($)).not.toContain('start_session')
})

test('22 stream-json: tool steps are counted and the result event is the reply', async ($, on) => {
  const ev = (o: unknown) => JSON.stringify(o)
  const stdout = [
    ev({ event: 'init', init: { model: MODEL } }),
    ev({ event: 'step_update', step_update: { step_type: 'tool', state: 'ACTIVE', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'ls' } } } }),
    ev({ event: 'step_update', step_update: { step_type: 'agent_response', state: 'ACTIVE', text_delta: 'do' } }),
    ev({ event: 'step_update', step_update: { step_type: 'agent_response', state: 'DONE', usage: { total_tokens: 50, thinking_tokens: 7 } } }),
    ev({ event: 'result', result: { status: 'SUCCESS', response: 'done\n', usage: { total_tokens: 50, thinking_tokens: 7 } } }),
  ].join('\n')
  const t = await boot($, on, () => ({ exitCode: 0, stdout, stderr: '' }))
  expect(text(await t.delegate(MODEL, 'x')).startsWith('done')).toBe(true)
  const ui = await $.ui.mount(BAND('terminal'))
  expect(await ui.find({ type: 'Text', text: /1 tools/ })).toBeTruthy()
  await ui.unmount()
})
