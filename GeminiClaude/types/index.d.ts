export type Run = { id?: number; model: string; label: string; seconds?: number; tokens?: number; ok?: boolean }

declare module 'claude-code' {
  interface PluginState {
    GeminiClaude: { running: Run[]; last: Run | null; isHidden: boolean }
  }
}
