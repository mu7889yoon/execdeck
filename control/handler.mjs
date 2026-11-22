import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const COOKIE_NAME = 'workshop_sid'
const MAX_BODY_BYTES = 256 * 1024
const MAX_FILE_BYTES = 180_000
const WORKSPACE_PORT = 8080
const TERMINAL_PORT = 8081
const LAUNCH_FAILED = { error: 'Could not start the workspace. Try again.' }

function header(event, name) {
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(event.headers || {})) {
    if (key.toLowerCase() === wanted) return String(value)
  }
  return ''
}

function sessionId(event) {
  const cookies = event.cookies || []
  const fromCookieList = cookies.map(cookie => cookie.split(';', 1)[0])
  const allCookies = [...fromCookieList, header(event, 'cookie')]
  for (const source of allCookies) {
    for (const item of source.split(';')) {
      const [name, ...rest] = item.trim().split('=')
      if (name === COOKIE_NAME) return rest.join('=')
    }
  }
  return ''
}

function respond(statusCode, body, cookies = []) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, private',
      'pragma': 'no-cache',
    },
    ...(cookies.length ? { cookies } : {}),
    body: JSON.stringify(body),
  }
}

function cookie(value, maxAge) {
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`
}

function parseBody(event) {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : event.body || ''
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) throw Object.assign(new Error('Request too large'), { statusCode: 413 })
  try { return JSON.parse(raw || '{}') } catch {
    throw Object.assign(new Error('Invalid JSON'), { statusCode: 400 })
  }
}

function equalSecret(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string') return false
  const a = Buffer.from(candidate)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function normalizeEndpoint(endpoint) {
  return endpoint.startsWith('https://') ? endpoint : `https://${endpoint}`
}

function alreadyTerminated(error) {
  return ['ResourceNotFoundException', 'NotFoundException'].includes(error?.name)
}

export function createHandler({ store, microvms, config, fetchImpl = fetch }) {
  const sessionTTLSeconds = config.sessionTTLSeconds || 60 * 60
  if (!config.egressConnectorArn) throw new Error('A MicroVM egress connector is required')
  const validOrigin = event => {
    const supplied = header(event, 'x-workshop-origin')
    const expected = config.originVerifyToken
    return Boolean(expected && supplied && equalSecret(supplied, expected))
  }

  async function vmToken(session, port, expirationInMinutes) {
    const tokenResponse = await microvms.createAuthToken({
      microvmIdentifier: session.microvmId,
      expirationInMinutes,
      allowedPorts: [{ port }],
    })
    const token = tokenResponse.authToken?.['X-aws-proxy-auth']
    if (!token) throw new Error('MicroVM auth token was not returned')
    return token
  }

  async function vmRequest(session, path, body) {
    const token = await vmToken(session, WORKSPACE_PORT, 1)
    const response = await fetchImpl(`${normalizeEndpoint(session.endpoint)}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'content-type': 'application/json',
        'X-aws-proxy-auth': token,
        'X-aws-proxy-port': String(WORKSPACE_PORT),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(18_000),
    })
    const text = await response.text()
    let payload
    try { payload = JSON.parse(text) } catch { payload = { error: `MicroVM returned HTTP ${response.status}` } }
    return { status: response.status, payload }
  }

  async function updateSessionReadiness(session) {
    if (session.status === 'TERMINATING') return { status: 'expired', joined: false }
    if (!session.microvmId || !session.endpoint) return { status: 'starting' }
    try {
      const current = await microvms.get({ microvmIdentifier: session.microvmId })
      if (['TERMINATING', 'TERMINATED'].includes(current.state)) {
        await store.releaseSession(session)
        return { status: 'expired', joined: false }
      }
      if (!['RUNNING', 'SUSPENDED'].includes(current.state)) return { status: 'starting' }
      // An authenticated health request also resumes a suspended MicroVM.
      const health = await vmRequest(session, '/api/health')
      if (health.status !== 200 || health.payload.ok !== true) return { status: 'starting' }
      if (session.status !== 'READY') await store.updateSession(session.pk, { status: 'READY' }, 'STARTING')
      return { status: 'ready' }
    } catch (error) {
      if (error.name === 'ConditionalCheckFailedException') {
        const latest = await store.getSession(session.sid)
        if (!latest || latest.status === 'TERMINATING') return { status: 'expired', joined: false }
        return { status: latest.status === 'READY' ? 'ready' : 'starting' }
      }
      if (alreadyTerminated(error)) {
        await store.releaseSession(session).catch(() => {})
        return { status: 'expired', joined: false }
      }
      console.warn('MicroVM readiness check failed:', error.name || 'Error', error.message || '')
      return { status: 'starting' }
    }
  }

  async function workspaceUnavailable(session) {
    const state = await updateSessionReadiness(session)
    if (state.joined === false) return respond(401, { error: 'Join the workshop first.' })
    if (state.status !== 'ready') return respond(409, { error: 'The workspace is still starting.' })
  }

  async function cleanFailedLaunch(session, vm) {
    if (!vm?.microvmId) {
      await store.releaseSession(session).catch(() => {})
      return
    }
    try {
      await microvms.terminate({ microvmIdentifier: vm.microvmId })
      await store.releaseSession(session)
    } catch (error) {
      if (alreadyTerminated(error)) {
        await store.releaseSession(session).catch(() => {})
        return
      }
      await store.updateSession(session.pk, {
        status: 'TERMINATING',
        microvmId: vm.microvmId,
        ...(vm.endpoint ? { endpoint: normalizeEndpoint(vm.endpoint) } : {}),
      }).catch(() => {})
      console.warn('Failed launch cleanup deferred to reaper:', error.name || 'Error')
    }
  }

  async function launchSession(session) {
    let vm
    try {
      vm = await microvms.run({
        imageIdentifier: config.imageArn,
        clientToken: session.sid,
        ingressNetworkConnectors: [config.ingressConnectorArn],
        egressNetworkConnectors: [config.egressConnectorArn],
        idlePolicy: { autoResumeEnabled: true, maxIdleDurationSeconds: 600, suspendedDurationSeconds: 1200 },
        maximumDurationInSeconds: sessionTTLSeconds,
      })
      if (!vm.microvmId || !vm.endpoint) throw new Error('RunMicrovm returned no endpoint')
      const changes = { status: 'STARTING', microvmId: vm.microvmId, endpoint: normalizeEndpoint(vm.endpoint) }
      await store.updateSession(session.pk, changes, 'LAUNCHING')
      Object.assign(session, changes)
      return true
    } catch (error) {
      if (error.name === 'ConditionalCheckFailedException') {
        const latest = await store.getSession(session.sid)
        if (latest && latest.microvmId === vm?.microvmId) {
          Object.assign(session, latest)
          return latest.status === 'STARTING' || latest.status === 'READY'
        }
      }
      await cleanFailedLaunch(session, vm)
      console.error('MicroVM launch failed:', error.name || 'Error', error.message || '')
      return false
    }
  }

  return async function handler(event) {
    const method = event.requestContext?.http?.method || event.httpMethod || 'GET'
    const path = event.rawPath || event.path || '/'

    if (method === 'GET' && path === '/api/health') return respond(200, { ok: true })
    if (method === 'OPTIONS') return respond(204, {})
    if (method === 'POST' && !validOrigin(event)) return respond(403, { error: 'Origin check failed' })

    if (method === 'GET' && path === '/api/me') {
      const sid = sessionId(event)
      if (!sid) return respond(200, { joined: false })
      const session = await store.getSession(sid)
      if (!session || session.expiresAt <= Math.floor(Date.now() / 1000)) return respond(200, { joined: false })
      const state = await updateSessionReadiness(session)
      if (state.joined === false) return respond(200, { joined: false, status: state.status })
      return respond(200, { joined: true, status: state.status })
    }

    if (method === 'POST' && path === '/api/join') {
      let input
      try { input = parseBody(event) } catch (error) { return respond(error.statusCode || 400, { error: error.message }) }
      if (typeof input?.requestId !== 'string' || !/^[a-f0-9-]{36}$/i.test(input.requestId)) {
        return respond(400, { error: 'Reload the page and try joining again.' })
      }

      const currentSid = sessionId(event)
      if (currentSid) {
        const current = await store.getSession(currentSid)
        if (current && current.status !== 'TERMINATING' && current.expiresAt > Math.floor(Date.now() / 1000)) {
          return respond(200, { joined: true, status: current.status }, [cookie(currentSid, Math.max(1, current.expiresAt - Math.floor(Date.now() / 1000)))])
        }
      }

      const joinKey = createHash('sha256').update(input.requestId).digest('hex')
      const previous = await store.getJoin(joinKey)
      if (previous) {
        const existing = await store.getSession(previous.sid)
        if (existing) {
          if (!existing.microvmId && existing.status === 'LAUNCHING' && !await launchSession(existing)) {
            return respond(502, LAUNCH_FAILED)
          }
          return respond(202, { joined: true, status: existing.status }, [cookie(previous.sid, Math.max(1, existing.expiresAt - Math.floor(Date.now() / 1000)))])
        }
        await store.deleteJoin(joinKey)
      }

      const sid = randomBytes(32).toString('hex')
      const now = Math.floor(Date.now() / 1000)
      const session = {
        pk: `SESSION#${sid}`,
        sid,
        joinKey,
        status: 'LAUNCHING',
        createdAt: now,
        expiresAt: now + sessionTTLSeconds,
      }
      const reserved = await store.reserveSession(session, config.maxSessions)
      if (!reserved) {
        const duplicate = await store.getJoin(joinKey)
        if (duplicate) {
          const existing = await store.getSession(duplicate.sid)
          if (existing) return respond(202, { joined: true, status: existing.status }, [cookie(duplicate.sid, Math.max(1, existing.expiresAt - now))])
        }
        return respond(429, { error: 'All workshop workspaces are busy. Please contact the workshop host.' })
      }

      if (!await launchSession(session)) return respond(502, LAUNCH_FAILED)
      return respond(202, { joined: true, status: 'starting' }, [cookie(sid, sessionTTLSeconds)])
    }

    const sid = sessionId(event)
    const session = sid ? await store.getSession(sid) : null
    if (!session || session.expiresAt <= Math.floor(Date.now() / 1000)) {
      return respond(401, { error: 'Join the workshop first.' })
    }

    const readWorkspace = method === 'GET' && ['/api/workspace/tree', '/api/workspace/file'].includes(path)
    const writeWorkspace = method === 'POST' && path === '/api/workspace/file'
    if (readWorkspace || writeWorkspace) {
      let input
      let vmPath = path
      if (writeWorkspace) {
        try { input = parseBody(event) } catch (error) { return respond(error.statusCode || 400, { error: error.message }) }
        if (typeof input?.path !== 'string' || input.path.length > 1024 || typeof input.content !== 'string') {
          return respond(400, { error: 'A valid workspace path and file content are required.' })
        }
        if (Buffer.byteLength(input.content, 'utf8') > MAX_FILE_BYTES) return respond(413, { error: 'The file is too large.' })
      } else if (path === '/api/workspace/file') {
        vmPath += `?path=${encodeURIComponent(event.queryStringParameters?.path || '')}`
      }
      if (session.status !== 'READY') {
        const unavailable = await workspaceUnavailable(session)
        if (unavailable) return unavailable
      }
      let result
      try {
        result = await vmRequest(session, vmPath, input)
        if (result.status < 500) return respond(result.status, result.payload)
      } catch (error) {
        console.error(writeWorkspace ? 'Workspace write failed:' : 'Workspace read failed:', error.name || 'Error')
      }
      // Diagnose an unavailable VM without replaying a possibly completed write.
      const unavailable = await workspaceUnavailable(session)
      if (unavailable) return unavailable
      if (result) return respond(result.status, result.payload)
      return respond(502, { error: writeWorkspace ? 'Could not save the workspace file.' : 'Could not read the workspace.' })
    }

    if (method === 'POST' && path === '/api/terminal-token') {
      const state = await updateSessionReadiness(session)
      if (state.status !== 'ready') return respond(409, { error: 'The workspace is still starting. Wait a moment and reconnect.' })
      try {
        const token = await vmToken(session, TERMINAL_PORT, 5)
        return respond(200, {
          endpoint: normalizeEndpoint(session.endpoint),
          token,
          port: TERMINAL_PORT,
        })
      } catch (error) {
        console.error('MicroVM terminal token request failed:', error.name || 'Error')
        return respond(502, { error: 'Could not create a terminal connection token.' })
      }
    }

    if (method === 'POST' && path === '/api/leave') {
      let terminated = false
      try {
        if (session.microvmId) await microvms.terminate({ microvmIdentifier: session.microvmId })
        terminated = true
      } catch (error) {
        if (alreadyTerminated(error)) terminated = true
        else {
          console.warn('MicroVM termination deferred to reaper:', error.name || 'Error')
          await store.updateSession(session.pk, { status: 'TERMINATING' }).catch(() => {})
        }
      }
      if (terminated) await store.releaseSession(session)
      return respond(200, { ok: true, cleanupPending: !terminated }, [cookie('', 0)])
    }

    return respond(404, { error: 'Not found' })
  }
}
