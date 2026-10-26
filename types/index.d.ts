export type Todo = { due: string; text: string }
export type GitState = { branch: string; changed: number; ahead: number; behind: number }
export type Deploy = { site: string; state: string; at: string }

declare module 'claude-code' {
  interface PluginState {
    remind: {
      todos: Shaped<Todo[]>
      today: string
      isHidden: boolean
      problem: string
      git: GitState | null
      deploys: Shaped<Deploy[]>
    }
  }
}
