// What session-shepherd keeps for the session in $.state.

// Where the session stands after its last finished turn: what was done, what it waits on from the
// person ('' when nothing), what comes next ('' when finished). Each line is at most 80 characters.
export type Recap = { done: string; needs: string; next: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    'session-shepherd': { recap: Recap | null; lastPrompt: string }
  }
}
