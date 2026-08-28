import { describe, expect, it } from 'vitest'
import {
  checkBudget,
  describeBudgetRefusal,
  isUncapped,
  MICROS_PER_USD,
  type BudgetCaps,
  type BudgetObserved
} from './budget-cap'

const UNCAPPED: BudgetCaps = { maxSpawns: null, maxTokens: null, maxSpendMicros: null }
const NOTHING_USED: BudgetObserved = { spawns: 0, tokens: 0, spendMicros: 0 }

describe('budget caps', () => {
  it('allows everything when nothing is capped', () => {
    expect(isUncapped(UNCAPPED)).toBe(true)
    expect(checkBudget(UNCAPPED, { spawns: 999, tokens: 9e9, spendMicros: 9e9 })).toEqual({
      allowed: true
    })
  })

  // Null is "no cap"; zero is a cap an operator meant. Conflating them would
  // silently ignore the strictest budget anyone can set.
  it('treats a zero cap as a real cap, not as unset', () => {
    expect(isUncapped({ ...UNCAPPED, maxSpawns: 0 })).toBe(false)
    expect(checkBudget({ ...UNCAPPED, maxSpawns: 0 }, NOTHING_USED)).toMatchObject({
      allowed: false,
      dimension: 'spawns'
    })
  })

  // The spawn being judged is not counted yet, so being *at* the cap must refuse.
  it('refuses at the cap, not only past it', () => {
    const caps = { ...UNCAPPED, maxSpawns: 3 }
    expect(checkBudget(caps, { ...NOTHING_USED, spawns: 2 })).toEqual({ allowed: true })
    expect(checkBudget(caps, { ...NOTHING_USED, spawns: 3 })).toMatchObject({
      allowed: false,
      observed: 3,
      cap: 3
    })
  })

  it('refuses on each dimension independently', () => {
    expect(
      checkBudget({ ...UNCAPPED, maxTokens: 100 }, { ...NOTHING_USED, tokens: 100 })
    ).toMatchObject({ allowed: false, dimension: 'tokens' })
    expect(
      checkBudget({ ...UNCAPPED, maxSpendMicros: 5 }, { ...NOTHING_USED, spendMicros: 5 })
    ).toMatchObject({ allowed: false, dimension: 'spend' })
  })

  it('leaves uncapped dimensions alone when another one is capped', () => {
    const caps = { ...UNCAPPED, maxSpawns: 10 }
    expect(checkBudget(caps, { spawns: 1, tokens: 9e9, spendMicros: 9e9 })).toEqual({
      allowed: true
    })
  })

  // Spawn count is the exact dimension; tokens and spend lag a transcript scan.
  // Reporting the actionable one first is the point of the ordering.
  it('reports the exact dimension first when several are blown', () => {
    const caps = { maxSpawns: 1, maxTokens: 1, maxSpendMicros: 1 }
    expect(checkBudget(caps, { spawns: 5, tokens: 5, spendMicros: 5 })).toMatchObject({
      dimension: 'spawns'
    })
  })
})

describe('refusal messages', () => {
  // A refused spawn with no visible reason reads as a bug (ADR-0009).
  it('names the dimension, what was used, and the cap', () => {
    const refused = checkBudget({ ...UNCAPPED, maxSpawns: 2 }, { ...NOTHING_USED, spawns: 2 })
    expect(refused.allowed).toBe(false)
    if (refused.allowed) {
      return
    }
    const message = describeBudgetRefusal(refused, 'run')
    expect(message).toContain('run budget')
    expect(message).toContain('2 of 2')
  })

  it('renders spend as money rather than raw micros', () => {
    const refused = checkBudget(
      { ...UNCAPPED, maxSpendMicros: 5 * MICROS_PER_USD },
      { ...NOTHING_USED, spendMicros: 7 * MICROS_PER_USD }
    )
    if (refused.allowed) {
      throw new Error('expected a refusal')
    }
    expect(describeBudgetRefusal(refused, 'global')).toContain('$7.00 of $5.00')
  })

  // The lag is a property of the measurement, so the message says so rather than
  // letting an operator read a token refusal as exact.
  it('says token counts can lag, and does not claim that of spawns', () => {
    const tokens = checkBudget({ ...UNCAPPED, maxTokens: 1 }, { ...NOTHING_USED, tokens: 1 })
    const spawns = checkBudget({ ...UNCAPPED, maxSpawns: 1 }, { ...NOTHING_USED, spawns: 1 })
    if (tokens.allowed || spawns.allowed) {
      throw new Error('expected refusals')
    }
    expect(describeBudgetRefusal(tokens, 'run')).toContain('can lag')
    expect(describeBudgetRefusal(spawns, 'run')).not.toContain('can lag')
  })
})
