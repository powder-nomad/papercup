import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_AUTO_COMPACT_PCT,
  DEFAULT_DANGER_PCT,
  DEFAULT_POLICY,
  DEFAULT_POLICY_MODE,
  DEFAULT_WARN_PCT,
  classifyUsage,
  computeThresholds,
  estimateTokensFromBytes,
  loadPolicyFromEnv,
  resolveContextWindowTokens,
  resolvePolicyMode,
  usagePercent,
} from '../src/state/context-policy.ts'

/* --------------------------- window resolution --------------------------- */

test('resolveContextWindowTokens defaults to 200k when model is missing', () => {
  assert.equal(resolveContextWindowTokens(undefined), 200_000)
  assert.equal(resolveContextWindowTokens(''), 200_000)
})

test('resolveContextWindowTokens picks 1M when model carries [1m] suffix', () => {
  assert.equal(resolveContextWindowTokens('claude-opus-4-7[1m]'), 1_000_000)
  assert.equal(resolveContextWindowTokens('CLAUDE-OPUS-4-7[1M]'), 1_000_000)
})

test('resolveContextWindowTokens picks 1M for hyphen/underscore 1m variant', () => {
  assert.equal(resolveContextWindowTokens('claude-opus-4-7-1m'), 1_000_000)
  assert.equal(resolveContextWindowTokens('opus_1m'), 1_000_000)
})

test('resolveContextWindowTokens picks 1M for sonnet 4.x', () => {
  assert.equal(resolveContextWindowTokens('claude-sonnet-4-6'), 1_000_000)
  assert.equal(resolveContextWindowTokens('sonnet-4'), 1_000_000)
  assert.equal(resolveContextWindowTokens('sonnet4'), 1_000_000)
})

test('resolveContextWindowTokens stays at 200k for opus/haiku without [1m]', () => {
  assert.equal(resolveContextWindowTokens('claude-opus-4-7'), 200_000)
  assert.equal(resolveContextWindowTokens('opus'), 200_000)
  assert.equal(resolveContextWindowTokens('claude-haiku-4-5-20251001'), 200_000)
  assert.equal(resolveContextWindowTokens('haiku'), 200_000)
})

/* ------------------------------ thresholds ------------------------------ */

test('computeThresholds: 200k window applies default percents', () => {
  const t = computeThresholds('opus', DEFAULT_POLICY)
  assert.equal(t.windowTokens, 200_000)
  assert.equal(t.warnTokens, 140_000)
  assert.equal(t.dangerTokens, 170_000)
  assert.equal(t.autoCompactTokens, 184_000)
})

test('computeThresholds: 1M window scales thresholds up', () => {
  const t = computeThresholds('claude-opus-4-7[1m]', DEFAULT_POLICY)
  assert.equal(t.windowTokens, 1_000_000)
  assert.equal(t.warnTokens, 700_000)
  assert.equal(t.dangerTokens, 850_000)
  assert.equal(t.autoCompactTokens, 920_000)
})

test('computeThresholds: legacy abs floor caps warn lower than percent', () => {
  const t = computeThresholds('claude-opus-4-7[1m]', {
    ...DEFAULT_POLICY,
    legacyAbsWarn: 150_000,
    legacyAbsDanger: 180_000,
  })
  assert.equal(t.warnTokens, 150_000, 'abs floor wins over 700k percent')
  assert.equal(t.dangerTokens, 180_000, 'abs floor wins over 850k percent')
  assert.equal(t.autoCompactTokens, 920_000, 'auto-compact has no abs floor')
})

test('computeThresholds: legacy abs floor IGNORED when percent is lower', () => {
  const t = computeThresholds('opus', {
    ...DEFAULT_POLICY,
    legacyAbsWarn: 190_000,
  })
  assert.equal(t.warnTokens, 140_000, 'percent (140k) < abs (190k), percent wins')
})

test('computeThresholds: clamps out-of-range percentages', () => {
  const tHigh = computeThresholds('opus', { ...DEFAULT_POLICY, warnPct: 150 })
  assert.equal(tHigh.warnTokens, 200_000)
  const tLow = computeThresholds('opus', { ...DEFAULT_POLICY, warnPct: -10 })
  assert.equal(tLow.warnTokens, 0)
  const tNaN = computeThresholds('opus', { ...DEFAULT_POLICY, warnPct: Number.NaN })
  assert.equal(tNaN.warnTokens, 0)
})

/* -------------------------- usage classification ------------------------- */

test('classifyUsage tiers correctly', () => {
  const t = computeThresholds('opus', DEFAULT_POLICY)
  assert.equal(classifyUsage(0, t), 'safe')
  assert.equal(classifyUsage(t.warnTokens - 1, t), 'safe')
  assert.equal(classifyUsage(t.warnTokens, t), 'warn')
  assert.equal(classifyUsage(t.dangerTokens, t), 'danger')
  assert.equal(classifyUsage(t.autoCompactTokens, t), 'auto-compact')
  assert.equal(classifyUsage(t.windowTokens, t), 'auto-compact')
})

test('usagePercent rounds to one decimal place', () => {
  const t = computeThresholds('opus', DEFAULT_POLICY)
  assert.equal(usagePercent(100_000, t), 50)
  assert.equal(usagePercent(123_456, t), 61.7)
  assert.equal(usagePercent(0, t), 0)
})

/* ---------------------------- byte estimation --------------------------- */

test('estimateTokensFromBytes is 4 bytes/token', () => {
  assert.equal(estimateTokensFromBytes(0), 0)
  assert.equal(estimateTokensFromBytes(-100), 0)
  assert.equal(estimateTokensFromBytes(400_000), 100_000)
  assert.equal(estimateTokensFromBytes(1_600_000), 400_000)
})

test('estimateTokensFromBytes handles non-finite input', () => {
  assert.equal(estimateTokensFromBytes(Number.NaN), 0)
  assert.equal(estimateTokensFromBytes(Number.POSITIVE_INFINITY), 0)
})

/* ------------------------------ env loading ----------------------------- */

test('loadPolicyFromEnv: empty env yields defaults', () => {
  const cfg = loadPolicyFromEnv({})
  assert.equal(cfg.warnPct, DEFAULT_WARN_PCT)
  assert.equal(cfg.dangerPct, DEFAULT_DANGER_PCT)
  assert.equal(cfg.autoCompactPct, DEFAULT_AUTO_COMPACT_PCT)
  assert.equal(cfg.legacyAbsWarn, undefined)
  assert.equal(cfg.legacyAbsDanger, undefined)
})

test('loadPolicyFromEnv: percentages override defaults', () => {
  const cfg = loadPolicyFromEnv({
    PAPERCUP_CONTEXT_WARN_PCT: '60',
    PAPERCUP_CONTEXT_DANGER_PCT: '80',
    PAPERCUP_AUTOCOMPACT_PCT: '90',
  })
  assert.equal(cfg.warnPct, 60)
  assert.equal(cfg.dangerPct, 80)
  assert.equal(cfg.autoCompactPct, 90)
})

test('loadPolicyFromEnv: legacy abs floors opt-in only when set', () => {
  const cfg = loadPolicyFromEnv({
    PAPERCUP_CONTEXT_WARN_TOKENS: '150000',
    PAPERCUP_CONTEXT_DANGER_TOKENS: '180000',
  })
  assert.equal(cfg.legacyAbsWarn, 150_000)
  assert.equal(cfg.legacyAbsDanger, 180_000)
})

test('loadPolicyFromEnv: empty / non-numeric values fall back to defaults', () => {
  const cfg = loadPolicyFromEnv({
    PAPERCUP_CONTEXT_WARN_PCT: 'NaN',
    PAPERCUP_CONTEXT_DANGER_PCT: '',
    PAPERCUP_CONTEXT_WARN_TOKENS: '   ',
    PAPERCUP_CONTEXT_DANGER_TOKENS: '0',
  })
  assert.equal(cfg.warnPct, DEFAULT_WARN_PCT)
  assert.equal(cfg.dangerPct, DEFAULT_DANGER_PCT)
  assert.equal(cfg.legacyAbsWarn, undefined)
  assert.equal(cfg.legacyAbsDanger, undefined, '0 is rejected (must be > 0)')
})

/* ----------------------------- policy mode ----------------------------- */

test('resolvePolicyMode defaults to off when env missing', () => {
  assert.equal(resolvePolicyMode({}), DEFAULT_POLICY_MODE)
  assert.equal(resolvePolicyMode({ PAPERCUP_COMPACT_POLICY: '' }), DEFAULT_POLICY_MODE)
})

test('resolvePolicyMode accepts off / warn-only / auto', () => {
  assert.equal(resolvePolicyMode({ PAPERCUP_COMPACT_POLICY: 'off' }), 'off')
  assert.equal(resolvePolicyMode({ PAPERCUP_COMPACT_POLICY: 'warn-only' }), 'warn-only')
  assert.equal(resolvePolicyMode({ PAPERCUP_COMPACT_POLICY: 'AUTO' }), 'auto')
})

test('resolvePolicyMode rejects unknown values', () => {
  assert.equal(resolvePolicyMode({ PAPERCUP_COMPACT_POLICY: 'aggressive' }), DEFAULT_POLICY_MODE)
})
