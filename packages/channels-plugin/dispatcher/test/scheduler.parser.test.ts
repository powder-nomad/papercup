import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseCron,
  parseAtTime,
  parseDuration,
  hostTimezone,
  formatTimezoneLabel,
  isParseError,
} from '../src/scheduler/parser.ts'

const KST = 'Asia/Seoul'
const UTC = 'UTC'
const NOW = Date.UTC(2026, 4, 27, 0, 0, 0) // 2026-05-27T00:00:00Z

test('parseDuration: valid +Nm/+Nh/+Nd', () => {
  assert.equal(parseDuration('+30m'), 30 * 60_000)
  assert.equal(parseDuration('+2h'), 2 * 60 * 60_000)
  assert.equal(parseDuration('+1d'), 24 * 60 * 60_000)
})

test('parseDuration: rejects bad format', () => {
  assert.ok(isParseError(parseDuration('2h')))         // missing +
  assert.ok(isParseError(parseDuration('+0h')))        // zero
  assert.ok(isParseError(parseDuration('+2y')))        // bad unit
  assert.ok(isParseError(parseDuration('+1.5h')))      // fractional
  assert.ok(isParseError(parseDuration('')))           // empty
})

test('parseDuration: caps at 30d', () => {
  assert.equal(parseDuration('+30d'), 30 * 24 * 60 * 60_000)
  assert.ok(isParseError(parseDuration('+31d')))
})

test('parseCron: valid expression yields advancing nextAfter()', () => {
  const p = parseCron('0 9 * * *', KST)
  assert.ok(!isParseError(p))
  if (isParseError(p)) return
  const t1 = p.nextAfter(NOW)
  const t2 = p.nextAfter(t1)
  assert.ok(t1 > NOW, 'first fire must be in future')
  assert.ok(t2 > t1, 'second fire must be later than first')
  const oneDay = 24 * 60 * 60_000
  assert.equal(t2 - t1, oneDay, 'daily cron advances by 1 day')
})

test('parseCron: rejects malformed expression', () => {
  assert.ok(isParseError(parseCron('not a cron', KST)))
  assert.ok(isParseError(parseCron('', KST)))
  assert.ok(isParseError(parseCron('99 99 99 99 99', KST)))
})

test('parseAtTime: relative +Nh', () => {
  const out = parseAtTime('+2h', KST, NOW)
  assert.equal(out, NOW + 2 * 60 * 60_000)
})

test('parseAtTime: clock HH:mm picks next occurrence in tz', () => {
  const out = parseAtTime('03:00', KST, NOW)
  assert.equal(typeof out, 'number')
  assert.ok((out as number) > NOW)
  assert.ok((out as number) - NOW <= 24 * 60 * 60_000)
})

test('parseAtTime: HH:mm rejects bad ranges', () => {
  assert.ok(isParseError(parseAtTime('25:00', KST, NOW)))
  assert.ok(isParseError(parseAtTime('00:60', KST, NOW)))
})

test('parseAtTime: ISO 8601 with explicit offset', () => {
  const future = '2027-01-01T00:00:00Z'
  const out = parseAtTime(future, KST, NOW)
  assert.equal(out, Date.parse(future))
})

test('parseAtTime: past ISO rejected', () => {
  const past = '2020-01-01T00:00:00Z'
  assert.ok(isParseError(parseAtTime(past, KST, NOW)))
})

test('parseAtTime: garbage rejected', () => {
  assert.ok(isParseError(parseAtTime('definitely not a time', KST, NOW)))
  assert.ok(isParseError(parseAtTime('', KST, NOW)))
})

test('hostTimezone returns a non-empty IANA-ish string', () => {
  const tz = hostTimezone()
  assert.equal(typeof tz, 'string')
  assert.ok(tz.length > 0)
})

test('formatTimezoneLabel: UTC anchor returns offset-only label', () => {
  const label = formatTimezoneLabel(UTC, NOW)
  assert.match(label, /UTC[+-]\d/, `got ${label}`)
})

test('formatTimezoneLabel: KST has +9 offset (no DST)', () => {
  const label = formatTimezoneLabel(KST, NOW)
  assert.match(label, /UTC\+9/, `got ${label}`)
})
