import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createAcl } from '../src/scheduler/acl.ts'
import type { SchedulerStore } from '../src/scheduler/store.ts'

function makeStore(allowlist: Set<string>): SchedulerStore {
  const stub = {
    isAllowlisted: (id: string) => allowlist.has(id),
  } as unknown as SchedulerStore
  return stub
}

test('isOwner: matches BOT_OWNER_ID exactly', () => {
  const acl = createAcl({ store: makeStore(new Set()), ownerId: 'owner1' })
  assert.equal(acl.isOwner('owner1'), true)
  assert.equal(acl.isOwner('someone-else'), false)
  assert.equal(acl.isOwner(''), false)
})

test('isOwner: empty ownerId means no one is owner', () => {
  const acl = createAcl({ store: makeStore(new Set()), ownerId: '' })
  assert.equal(acl.isOwner('owner1'), false)
  assert.equal(acl.isOwner(''), false)
})

test('isAllowlisted: defers to store', () => {
  const acl = createAcl({ store: makeStore(new Set(['ally1'])), ownerId: 'owner1' })
  assert.equal(acl.isAllowlisted('ally1'), true)
  assert.equal(acl.isAllowlisted('owner1'), false)
  assert.equal(acl.isAllowlisted(''), false)
})

test('canManage: owner can manage any job (incl. null jobOwnerId)', () => {
  const acl = createAcl({ store: makeStore(new Set()), ownerId: 'owner1' })
  assert.equal(acl.canManage('owner1', null), true)
  assert.equal(acl.canManage('owner1', 'ally1'), true)
  assert.equal(acl.canManage('owner1', 'stranger'), true)
})

test('canManage: allowlisted user can manage own job', () => {
  const acl = createAcl({ store: makeStore(new Set(['ally1'])), ownerId: 'owner1' })
  assert.equal(acl.canManage('ally1', 'ally1'), true)
  assert.equal(acl.canManage('ally1', null), true)
})

test("canManage: allowlisted user blocked from another owner's job", () => {
  const acl = createAcl({ store: makeStore(new Set(['ally1'])), ownerId: 'owner1' })
  assert.equal(acl.canManage('ally1', 'ally2'), false)
  assert.equal(acl.canManage('ally1', 'owner1'), false)
})

test('canManage: non-allowlisted user always denied', () => {
  const acl = createAcl({ store: makeStore(new Set(['ally1'])), ownerId: 'owner1' })
  assert.equal(acl.canManage('stranger', null), false)
  assert.equal(acl.canManage('stranger', 'stranger'), false)
})

test('canManage: empty actor always denied', () => {
  const acl = createAcl({ store: makeStore(new Set([''])), ownerId: 'owner1' })
  assert.equal(acl.canManage('', null), false)
  assert.equal(acl.canManage('', 'owner1'), false)
})
