/** `activity`, `steps`, `thinking` and `tools` are live fields of a run still in flight, fed by agy's stream. */
export type Run = {
  id?: number
  model: string
  label: string
  started?: number
  seconds?: number
  tokens?: number
  ok?: boolean
  activity?: string
  steps?: string[]
  thinking?: number
  tools?: number
}

declare module 'claude-code' {
  interface PluginState {
    GeminiClaude: { running: Run[]; recent: Run[]; isOpen: boolean; isHidden: boolean; stepsShown: boolean }
  }
}
