export type Run = { id?: number; model: string; label: string; started?: number; seconds?: number; tokens?: number; ok?: boolean }

declare module 'claude-code' {
  interface PluginState {
    GeminiClaude: { running: Run[]; recent: Run[]; isOpen: boolean; isHidden: boolean }
  }
}
