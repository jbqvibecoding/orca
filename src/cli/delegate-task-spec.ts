// Builds the task document the delegation sidecar consumes.
//
// The sidecar validates this too, but its messages are Chinese and arrive only
// after a process spawn. Checking the two rules people actually break —
// briefing and objective too thin to brief a model with zero project knowledge
// — lets the CLI refuse in English before spawning anything.

export const DELEGATE_BACKENDS = ['auto', 'claude', 'codex', 'grok', 'kimi', 'agy'] as const
export type DelegateBackend = (typeof DELEGATE_BACKENDS)[number]

export const DELEGATE_MODES = ['read-only', 'edit'] as const
export type DelegateMode = (typeof DELEGATE_MODES)[number]

export const DELEGATE_EFFORTS = ['low', 'medium', 'high'] as const
export type DelegateEffort = (typeof DELEGATE_EFFORTS)[number]

/** Mirrors the sidecar's schema minimum; shorter text produces useless answers. */
export const MIN_BRIEFING_LENGTH = 20
export const MIN_OBJECTIVE_LENGTH = 20

export type DelegateTaskSpec = {
  backend: DelegateBackend
  mode: DelegateMode
  strict: boolean
  files: string[]
  task: {
    briefing: string
    objective: string
    locations?: string
    constraints?: string
    output_contract?: string
  }
  model?: string
  effort?: DelegateEffort
  cwd?: string
  label?: string
  thread?: string
}

export type DelegateTaskInput = {
  briefing?: string
  objective?: string
  locations?: string
  constraints?: string
  outputContract?: string
  backend?: string
  model?: string
  effort?: string
  mode?: string
  strict?: boolean
  files?: readonly string[]
  cwd?: string
  label?: string
  thread?: string
}

export type DelegateTaskSpecResult =
  | { ok: true; spec: DelegateTaskSpec }
  | { ok: false; error: string }

function isOneOf<T extends readonly string[]>(values: T, value: string): value is T[number] {
  return (values as readonly string[]).includes(value)
}

function invalidChoice(flag: string, value: string, allowed: readonly string[]): string {
  return `--${flag} must be one of: ${allowed.join(', ')} (got "${value}")`
}

export function buildDelegateTaskSpec(input: DelegateTaskInput): DelegateTaskSpecResult {
  const briefing = input.briefing?.trim() ?? ''
  const objective = input.objective?.trim() ?? ''

  if (briefing.length < MIN_BRIEFING_LENGTH) {
    return {
      ok: false,
      error: `--briefing needs at least ${MIN_BRIEFING_LENGTH} characters: the delegate has no knowledge of this project, so state the stack and the build/test commands.`
    }
  }
  if (objective.length < MIN_OBJECTIVE_LENGTH) {
    return {
      ok: false,
      error: `--objective needs at least ${MIN_OBJECTIVE_LENGTH} characters: state the exact question, what has already been tried, and the full error text.`
    }
  }

  const backend = input.backend ?? 'auto'
  if (!isOneOf(DELEGATE_BACKENDS, backend)) {
    return { ok: false, error: invalidChoice('backend', backend, DELEGATE_BACKENDS) }
  }
  const mode = input.mode ?? 'read-only'
  if (!isOneOf(DELEGATE_MODES, mode)) {
    return { ok: false, error: invalidChoice('mode', mode, DELEGATE_MODES) }
  }
  if (input.effort !== undefined && !isOneOf(DELEGATE_EFFORTS, input.effort)) {
    return { ok: false, error: invalidChoice('effort', input.effort, DELEGATE_EFFORTS) }
  }
  const strict = input.strict === true
  if (strict && mode === 'edit') {
    return {
      ok: false,
      error: '--strict applies to read-only delegation; an edit task needs the real workspace.'
    }
  }
  const files = [...(input.files ?? [])]
  if (strict && files.length === 0) {
    return {
      ok: false,
      error:
        '--strict runs the delegate against only the whitelisted files, so --files is required with it.'
    }
  }

  return {
    ok: true,
    spec: {
      backend,
      mode,
      strict,
      files,
      task: {
        briefing,
        objective,
        ...(input.locations ? { locations: input.locations } : {}),
        ...(input.constraints ? { constraints: input.constraints } : {}),
        ...(input.outputContract ? { output_contract: input.outputContract } : {})
      },
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort as DelegateEffort } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.label ? { label: input.label } : {}),
      ...(input.thread ? { thread: input.thread } : {})
    }
  }
}
