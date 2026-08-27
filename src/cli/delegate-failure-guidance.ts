// Translates the delegation sidecar's failures into English guidance.
//
// The sidecar is vendored from an upstream whose user-facing errors are
// Chinese. Orca's CLI is English, so the classes people actually hit get a
// mapped message — and the sidecar's own text is always kept as a detail line
// rather than swallowed, because a mapping that silently drops evidence is
// worse than an untranslated error.

export type DelegateFailure = {
  /** English, actionable. */
  summary: string
  /** The sidecar's own words, preserved verbatim. */
  detail: string
}

type FailurePattern = {
  /** Every fragment must appear for the mapping to apply. */
  match: readonly string[]
  summarize: (raw: string) => string
}

function backendFromNotInstalled(raw: string): string {
  return /后端\s+(\S+)\s+的命令\s+(\S+)/.exec(raw)?.[2] ?? 'the backend CLI'
}

function backendFromNotAuthenticated(raw: string): string {
  return /后端\s+(\S+)\s+未登录/.exec(raw)?.[1] ?? 'the backend'
}

const FAILURE_PATTERNS: readonly FailurePattern[] = [
  {
    match: ['没有已启用的后端'],
    summarize: () =>
      'No delegation backends are configured yet. Run `orca agent delegate-setup` once to detect the agent CLIs you already have.'
  },
  {
    match: ['不在 PATH 中'],
    summarize: (raw) =>
      `The delegate CLI \`${backendFromNotInstalled(raw)}\` is not on PATH. Install it, or pick another backend with --backend (see \`orca agent delegate-doctor\`).`
  },
  {
    match: ['未登录'],
    summarize: (raw) =>
      `The \`${backendFromNotAuthenticated(raw)}\` CLI is not logged in. Sign in with that vendor's own CLI, then retry.`
  },
  {
    match: ['任务不符合五段式模板'],
    summarize: () =>
      'The task document was rejected. Every delegation needs a briefing and an objective substantial enough for a model with no knowledge of this project.'
  },
  {
    match: ['cwd 不存在'],
    summarize: () => 'The --cwd directory does not exist, or is not a directory.'
  },
  {
    match: ['没有匹配到任何文件'],
    summarize: () =>
      'No file matched --files. Check the globs — they are resolved relative to the delegation working directory, not to your shell.'
  },
  {
    match: ['线程', '不存在'],
    summarize: () =>
      'That delegation thread no longer exists; it may have been garbage-collected. Omit --thread to start a new one.'
  },
  {
    match: ['占位符'],
    summarize: () =>
      '--model looks like placeholder text rather than a model id. Omit it to use the backend default.'
  }
]

export function describeDelegateFailure(raw: string): DelegateFailure {
  const detail = raw.trim()
  const pattern = FAILURE_PATTERNS.find((candidate) =>
    candidate.match.every((fragment) => detail.includes(fragment))
  )
  return {
    summary: pattern
      ? pattern.summarize(detail)
      : 'Delegation failed. The delegate sidecar reported:',
    detail
  }
}

export function formatDelegateFailure(raw: string): string {
  const { summary, detail } = describeDelegateFailure(raw)
  return detail.length > 0 ? `${summary}\n\ndetail: ${detail}` : summary
}
