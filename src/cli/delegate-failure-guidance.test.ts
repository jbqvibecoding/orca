import { describe, expect, it } from 'vitest'
import { describeDelegateFailure, formatDelegateFailure } from './delegate-failure-guidance'

describe('describeDelegateFailure', () => {
  it('maps a missing backend CLI and names the binary', () => {
    const { summary } = describeDelegateFailure(
      '后端 kimi 的命令 kimi 不在 PATH 中。先安装它，或换一个后端（ywcrew backends 查看）。'
    )
    expect(summary).toContain('`kimi` is not on PATH')
    expect(summary).toContain('--backend')
  })

  it('maps an unauthenticated backend and names it', () => {
    const { summary } = describeDelegateFailure(
      '后端 codex 未登录。修复：codex login（然后 ywcrew refresh）'
    )
    expect(summary).toContain('`codex` CLI is not logged in')
  })

  it('maps the first-run case to the setup command', () => {
    const { summary } = describeDelegateFailure('没有已启用的后端，先运行 ywcrew init')
    expect(summary).toContain('orca agent delegate-setup')
  })

  it('maps a rejected task document', () => {
    const { summary } = describeDelegateFailure('任务不符合五段式模板：\n  briefing: 太短')
    expect(summary).toContain('briefing and an objective')
  })

  it('maps a glob that matched nothing', () => {
    const { summary } = describeDelegateFailure(
      'files 的 glob 在 /tmp 下没有匹配到任何文件: src/**'
    )
    expect(summary).toContain('No file matched --files')
  })

  it('maps a missing thread', () => {
    const { summary } = describeDelegateFailure('线程 t-9 不存在（可能已被 gc 回收）。')
    expect(summary).toContain('--thread')
  })

  it('maps a placeholder model', () => {
    const { summary } = describeDelegateFailure('model 字段收到疑似占位符文本: "（可选）"')
    expect(summary).toContain('placeholder text')
  })

  it('maps a bad working directory', () => {
    const { summary } = describeDelegateFailure('cwd 不存在或不是目录: /nope')
    expect(summary).toContain('--cwd')
  })

  it('falls back without pretending to understand an unmapped failure', () => {
    const { summary, detail } = describeDelegateFailure('something entirely new')
    expect(summary).toBe('Delegation failed. The delegate sidecar reported:')
    expect(detail).toBe('something entirely new')
  })

  // A mapping that drops the original text is worse than no mapping.
  it('always preserves the sidecar text as detail', () => {
    const raw = '后端 kimi 的命令 kimi 不在 PATH 中。'
    expect(describeDelegateFailure(raw).detail).toBe(raw)
    expect(formatDelegateFailure(raw)).toContain(`detail: ${raw}`)
  })

  it('omits the detail line when there is nothing to preserve', () => {
    expect(formatDelegateFailure('   ')).not.toContain('detail:')
  })
})
