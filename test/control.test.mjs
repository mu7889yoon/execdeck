import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { createHandler } from '../control/handler.mjs'
import { store } from '../control/aws-services.mjs'

const requireControl = createRequire(new URL('../control/package.json', import.meta.url))
const { DynamoDBDocumentClient } = requireControl('@aws-sdk/lib-dynamodb')

function workshop(status, overrides = {}) {
  const session = {
    pk: 'SESSION#attendee', sid: 'attendee', joinKey: 'request', status,
    microvmId: 'vm', endpoint: 'https://vm.example', expiresAt: Date.now() / 1000 + 3600,
  }
  const calls = []
  const handler = createHandler({
    config: { egressConnectorArn: 'isolated', originVerifyToken: 'origin' },
    store: { getSession: async () => ({ ...session }), ...overrides.store },
    microvms: {
      get: async () => { calls.push('get VM'); return { state: 'RUNNING' } },
      createAuthToken: async () => { calls.push('token'); return { authToken: { 'X-aws-proxy-auth': 'token' } } },
      ...overrides.microvms,
    },
    fetchImpl: async (url, options) => {
      const { pathname } = new URL(url)
      calls.push(options.method + ' ' + pathname)
      return overrides.fetch?.(pathname, options) ?? Response.json({ ok: true })
    },
  })
  const request = (path, method = 'GET', body) => handler({
    rawPath: path, httpMethod: method, cookies: ['workshop_sid=attendee'],
    headers: { 'x-workshop-origin': 'origin' }, body: JSON.stringify(body),
  })
  return { calls, request, session }
}

test('ready workspace operations call only the requested endpoint and issue one token each', async () => {
  const { calls, request } = workshop('READY', {
    fetch: path => path.endsWith('/file') ? Response.json({ error: 'Missing file' }, { status: 404 }) : undefined,
  })
  assert.equal((await request('/api/workspace/tree')).statusCode, 200)
  assert.equal((await request('/api/workspace/file')).statusCode, 404)
  assert.deepEqual(calls, ['token', 'GET /api/workspace/tree', 'token', 'GET /api/workspace/file'])
})

test('a failed workspace write probes health without repeating the write', async () => {
  const { calls, request } = workshop('READY', {
    fetch: path => path.endsWith('/file') ? Response.json({ error: 'write failed' }, { status: 503 }) : undefined,
  })
  const response = await request('/api/workspace/file', 'POST', { path: 'hello.sh', content: 'updated' })
  assert.equal(response.statusCode, 503)
  assert.deepEqual(calls, ['token', 'POST /api/workspace/file', 'get VM', 'token', 'GET /api/health'])
})

test('stopping during a readiness probe cannot resurrect the session', async t => {
  const db = t.mock.method(DynamoDBDocumentClient.prototype, 'send', async ({ input }) => {
    assert.equal(input.ConditionExpression, '#status = :expected')
    assert.equal(input.ExpressionAttributeNames['#status'], 'status')
    assert.equal(input.ExpressionAttributeValues[':expected'], 'STARTING')
    throw Object.assign(new Error('Status changed'), { name: 'ConditionalCheckFailedException' })
  })
  const { request, calls, session } = workshop('STARTING', {
    store: { updateSession: store.updateSession },
    fetch: () => {
      session.status = 'TERMINATING'
      return Response.json({ ok: true })
    },
  })
  assert.deepEqual(JSON.parse((await request('/api/me')).body), { joined: false, status: 'expired' })
  assert.equal(db.mock.callCount(), 1)
  calls.length = 0
  assert.equal((await request('/api/workspace/tree')).statusCode, 401)
  assert.deepEqual(calls, [])
})

test('releasing twice uses conditional transactions and never reads the session first', async t => {
  const { session } = workshop('READY')
  let active = 1
  const db = t.mock.method(DynamoDBDocumentClient.prototype, 'send', async ({ input }) => {
    const [record, counter, join] = input.TransactItems
    assert.equal(record.Delete.Key.pk, session.pk)
    assert.equal(record.Delete.ConditionExpression, 'counted = :true')
    assert.equal(record.Delete.ExpressionAttributeValues[':true'], true)
    assert.equal(counter.Update.Key.pk, 'CONTROL#ACTIVE')
    assert.equal(join.Delete.Key.pk, 'JOIN#request')
    if (!active) throw Object.assign(new Error('Already released'), { name: 'TransactionCanceledException' })
    active--
  })
  assert.equal(await store.releaseSession(session), true)
  assert.equal(await store.releaseSession(session), false)
  assert.equal(active, 0)
  assert.equal(db.mock.callCount(), 2)
})

test('retrying a join without the first response cookie reuses its reservation and VM', async () => {
  let record
  let launches = 0
  let reservations = 0
  const { request } = workshop('LAUNCHING', {
    store: {
      getSession: async sid => record?.sid === sid ? { ...record } : undefined,
      getJoin: async key => record?.joinKey === key ? { sid: record.sid } : undefined,
      reserveSession: async session => { reservations++; record = { ...session }; return true },
      updateSession: async (_pk, changes, expected) => {
        assert.equal(record.status, expected)
        Object.assign(record, changes)
      },
    },
    microvms: { run: async () => { launches++; return { microvmId: 'vm', endpoint: 'vm.example' } } },
  })
  const body = { requestId: '395f344c-96e6-48be-8091-842a42a85420' }
  const first = await request('/api/join', 'POST', body)
  const retry = await request('/api/join', 'POST', body)
  assert.equal(first.statusCode, 202)
  assert.equal(retry.statusCode, 202)
  assert.equal(first.cookies[0].split(';')[0], retry.cookies[0].split(';')[0])
  assert.equal(reservations, 1)
  assert.equal(launches, 1)
})
