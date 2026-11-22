import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { cp, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { spawn as spawnPty, type IPty } from 'node-pty'
import { WebSocket, WebSocketServer } from 'ws'

const HOST = process.env.HOST || '0.0.0.0'
const API_PORT = Number(process.env.PORT || 8080)
const TERMINAL_PORT = Number(process.env.TERMINAL_PORT || 8081)
const WORKSPACE_ROOT = resolve(process.env.WORKSPACE_ROOT || '/workspace')
const WORKSPACE_SEED_ROOT = resolve('/workspace')
const MAX_BODY_BYTES = 1_000_000
const MAX_FILE_BYTES = 180_000
const MAX_TREE_ENTRIES = 2500
const SKIP_ENTRIES = new Set(['.git', 'node_modules', '.DS_Store'])
const TERMINAL_PROTOCOL = 'execdeck-terminal'
let localSessionStarted = false

if (!isAbsolute(process.env.WORKSPACE_ROOT || '/workspace') || WORKSPACE_ROOT === sep) {
  throw new Error('WORKSPACE_ROOT must be an absolute path below the filesystem root.')
}
await mkdir(WORKSPACE_ROOT, { recursive: true })
if (WORKSPACE_ROOT !== WORKSPACE_SEED_ROOT) {
  const pathFromSeed = relative(WORKSPACE_SEED_ROOT, WORKSPACE_ROOT)
  const isNestedSeedPath = pathFromSeed !== '..' && !pathFromSeed.startsWith(`..${sep}`) && !isAbsolute(pathFromSeed)
  if (!isNestedSeedPath) {
    const existing = await readdir(WORKSPACE_ROOT)
    const seed = await readdir(WORKSPACE_SEED_ROOT).catch(() => [])
    if (existing.length === 0 && seed.length > 0) await cp(WORKSPACE_SEED_ROOT, WORKSPACE_ROOT, { recursive: true, force: false })
  }
}
const workspaceRealPath = await realpath(WORKSPACE_ROOT)
const shellEnv = {
  PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  HOME: '/tmp',
  TMPDIR: '/tmp',
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  LANG: 'C.UTF-8',
  PS1: 'workshop:\w\$ ',
}

const apiServer = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost')
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return respond(res, 200, { ok: true, mode: process.env.WORKSHOP_MODE || 'microvm' })
    }
    if (req.method === 'GET' && url.pathname === '/api/me') {
      if (process.env.WORKSHOP_MODE === 'local') {
        return respond(res, 200, { joined: localSessionStarted, status: localSessionStarted ? 'ready' : 'not-started', local: true })
      }
      return respond(res, 200, { joined: true, status: 'ready', local: false })
    }
    if (req.method === 'POST' && url.pathname === '/api/join') {
      localSessionStarted = true
      return respond(res, 200, { joined: true, status: 'ready', local: true })
    }
    if (req.method === 'POST' && url.pathname === '/api/terminal-token') {
      return respond(res, 200, { local: true, port: TERMINAL_PORT })
    }
    if (req.method === 'POST' && url.pathname === '/api/leave') {
      localSessionStarted = false
      shellPty?.kill()
      shellPty = undefined
      shellOutput = ''
      return respond(res, 200, { ok: true, local: true })
    }
    if (req.method === 'GET' && url.pathname === '/api/workspace/tree') {
      return respond(res, 200, { tree: await buildTree(WORKSPACE_ROOT, '') })
    }
    if (req.method === 'GET' && url.pathname === '/api/workspace/file') {
      const filePath = url.searchParams.get('path') || ''
      const absolutePath = await safeExistingPath(filePath)
      const info = await lstat(absolutePath)
      if (!info.isFile()) return respond(res, 400, { error: 'Path is not a file.' })
      if (info.size > MAX_FILE_BYTES) return respond(res, 413, { error: 'The file is too large for the editor.' })
      const content = await readFile(absolutePath, 'utf8')
      if (content.includes('\0')) return respond(res, 415, { error: 'The selected file is not plain text.' })
      return respond(res, 200, { path: filePath, content })
    }
    if (req.method === 'POST' && url.pathname === '/api/workspace/file') {
      const input = await readJSON(req)
      if (typeof input.path !== 'string' || typeof input.content !== 'string') {
        return respond(res, 400, { error: 'A file path and text content are required.' })
      }
      if (Buffer.byteLength(input.content, 'utf8') > MAX_FILE_BYTES) return respond(res, 413, { error: 'The file is too large.' })
      const absolutePath = await safeWritablePath(input.path)
      await mkdir(dirname(absolutePath), { recursive: true })
      const realParent = await realpath(dirname(absolutePath))
      if (!isWithinWorkspace(realParent)) return respond(res, 400, { error: 'File path is outside the workspace.' })
      await writeFile(absolutePath, input.content, 'utf8')
      return respond(res, 200, { ok: true, path: input.path })
    }
    return respond(res, 404, { error: 'Not found.' })
  } catch (error) {
    const statusCode = error instanceof Error && 'statusCode' in error ? Number(error.statusCode) : 500
    if (statusCode >= 500) console.error('[workspace API]', error)
    return respond(res, statusCode, { error: statusCode === 500 || !(error instanceof Error) ? 'Workspace request failed.' : error.message })
  }
})

function respond(res: ServerResponse, statusCode: number, body: unknown) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

async function readJSON(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Request body is too large.'), { statusCode: 413 })
    chunks.push(chunk)
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    return body && typeof body === 'object' ? body as Record<string, unknown> : {}
  }
  catch { throw Object.assign(new Error('Request body must be valid JSON.'), { statusCode: 400 }) }
}

function cleanRelativePath(value: string) {
  if (typeof value !== 'string' || value.includes('\0')) throw Object.assign(new Error('Invalid file path.'), { statusCode: 400 })
  const normalized = value.replaceAll('\\', '/').replace(/^\/+/, '')
  const segments = normalized.split('/')
  if (!normalized || segments.some(segment => !segment || segment === '.' || segment === '..' || SKIP_ENTRIES.has(segment))) {
    throw Object.assign(new Error('Invalid file path.'), { statusCode: 400 })
  }
  return normalized
}

function isWithinWorkspace(candidate: string) {
  const pathFromRoot = relative(workspaceRealPath, candidate)
  return pathFromRoot === '' || (pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
}

function insideWorkspace(candidate: string) {
  return candidate !== workspaceRealPath && isWithinWorkspace(candidate)
}

async function safeExistingPath(value: string) {
  const cleanPath = cleanRelativePath(value)
  const candidate = resolve(workspaceRealPath, cleanPath)
  let actual
  try { actual = await realpath(candidate) }
  catch { throw Object.assign(new Error('File not found.'), { statusCode: 404 }) }
  if (!insideWorkspace(actual)) throw Object.assign(new Error('File path is outside the workspace.'), { statusCode: 400 })
  return actual
}

async function safeWritablePath(value: string) {
  const cleanPath = cleanRelativePath(value)
  let parent = workspaceRealPath
  for (const segment of cleanPath.split('/').slice(0, -1)) {
    parent = resolve(parent, segment)
    const info = await lstat(parent).catch(error => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!info) break
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw Object.assign(new Error('The selected path is not a regular workspace directory.'), { statusCode: 400 })
    }
  }
  const candidate = resolve(workspaceRealPath, cleanPath)
  const existing = await lstat(candidate).catch(() => null)
  if (existing?.isSymbolicLink() || existing?.isDirectory()) {
    throw Object.assign(new Error('The selected path is not a regular file.'), { statusCode: 400 })
  }
  return candidate
}

type FileNode = { name: string; path: string } & (
  | { type: 'file' }
  | { type: 'directory'; children: FileNode[] }
)

async function buildTree(directory: string, prefix: string, budget = { remaining: MAX_TREE_ENTRIES }): Promise<FileNode[]> {
  const result: FileNode[] = []
  const entries = await readdir(directory, { withFileTypes: true })
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (SKIP_ENTRIES.has(entry.name) || entry.isSymbolicLink() || budget.remaining <= 0) continue
    budget.remaining -= 1
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      result.push({ name: entry.name, path, type: 'directory', children: await buildTree(resolve(directory, entry.name), path, budget) })
    } else if (entry.isFile()) {
      result.push({ name: entry.name, path, type: 'file' })
    }
  }
  return result
}

let shellPty: IPty | undefined
let shellSocket: WebSocket | undefined
let shellOutput = ''

function sendFrame(ws: WebSocket | undefined, frame: { type: 'output' | 'replay'; data: string }) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame))
}

function startShell() {
  if (shellPty) return
  shellOutput = ''
  shellPty = spawnPty('/bin/bash', ['--noprofile', '--norc', '-i'], {
    name: 'xterm-256color',
    cols: 100,
    rows: 28,
    cwd: workspaceRealPath,
    env: shellEnv,
  })
  shellPty.onData(data => {
    shellOutput = `${shellOutput}${data}`.slice(-65_536)
    sendFrame(shellSocket, { type: 'output', data })
  })
  shellPty.onExit(() => {
    shellPty = undefined
    if (shellSocket?.readyState === WebSocket.OPEN) shellSocket.close(1000, 'shell exited')
  })
}

const terminalServer = createServer((_req, res) => {
  res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found')
})
const terminalWebSockets = new WebSocketServer({
  noServer: true,
  maxPayload: 65_536,
  handleProtocols(protocols) {
    return protocols.has(TERMINAL_PROTOCOL) ? TERMINAL_PROTOCOL : false
  },
})
terminalServer.on('upgrade', (req, socket, head) => {
  if (new URL(req.url || '/', 'http://localhost').pathname !== '/terminal') {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  terminalWebSockets.handleUpgrade(req, socket, head, ws => terminalWebSockets.emit('connection', ws, req))
})
terminalWebSockets.on('connection', ws => {
  if (shellSocket && shellSocket !== ws && shellSocket.readyState === WebSocket.OPEN) {
    shellSocket.close(4001, 'terminal already connected')
  }
  shellSocket = ws
  startShell()
  if (shellOutput) sendFrame(ws, { type: 'replay', data: shellOutput })
  ws.on('message', raw => {
    let message: unknown
    try { message = JSON.parse(String(raw)) } catch { return }
    if (!message || typeof message !== 'object' || !('type' in message)) return
    if (message.type === 'clear') {
      shellOutput = ''
      return
    }
    if (message.type === 'input' && 'data' in message && typeof message.data === 'string') shellPty?.write(message.data)
    if (message.type === 'resize' && 'cols' in message && 'rows' in message
      && typeof message.cols === 'number' && typeof message.rows === 'number'
      && Number.isInteger(message.cols) && Number.isInteger(message.rows)) {
      shellPty?.resize(Math.max(20, Math.min(240, message.cols)), Math.max(6, Math.min(100, message.rows)))
    }
  })
  ws.on('close', () => { if (shellSocket === ws) shellSocket = undefined })
})

apiServer.listen(API_PORT, HOST, () => console.log(`[api] listening on ${HOST}:${API_PORT}`))
terminalServer.listen(TERMINAL_PORT, HOST, () => console.log(`[terminal] listening on ${HOST}:${TERMINAL_PORT}`))

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    apiServer.close()
    terminalServer.close()
    shellPty?.kill()
    process.exitCode = 0
  })
}
