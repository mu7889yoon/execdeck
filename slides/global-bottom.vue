<script setup lang="ts">
import type * as Monaco from 'monaco-editor'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useNav } from '@slidev/client/composables/useNav.ts'
import { lockShortcuts } from '@slidev/client/state/index.ts'
import config from './workshop.config.json'

type Mode = 'integrated' | 'editor' | 'terminal' | 'hidden'
type FileNode = { name: string; path: string; type: 'file' | 'directory'; children?: FileNode[] }
type MonacoModel = Monaco.editor.ITextModel
type MonacoEditor = Monaco.editor.IStandaloneCodeEditor

const TERMINAL_PROTOCOL = 'execdeck-terminal'
const nav = useNav()
const editorHost = ref<HTMLDivElement>()
const terminalHost = ref<HTMLDivElement>()
const tree = ref<FileNode[]>([])
const expandedFolders = ref(new Set<string>())
const currentFile = ref('')
const fileStatus = ref('Choose a file to begin')
const connectionStatus = ref('Not connected')
const errorMessage = ref('')
const ready = ref(false)
const busy = ref(false)
const starting = ref(false)
const stopping = ref(false)
const editorFontSize = ref(14)
const terminalFontSize = ref(13)
const selectedMode = ref<Mode | null>(null)

let editor: MonacoEditor | undefined
let monacoApi: typeof import('monaco-editor') | undefined
let terminal: Terminal | undefined
let fitAddon: FitAddon | undefined
let socket: WebSocket | undefined
let pollTimer: ReturnType<typeof setInterval> | undefined
let saveTimer: ReturnType<typeof setTimeout> | undefined
let reconnectTimer: ReturnType<typeof setTimeout> | undefined
let resizeObserver: ResizeObserver | undefined
let loadingEditor: Promise<void> | undefined
let pendingSave: Promise<boolean> | undefined
let fileSelection = 0
let applyingRemoteFile = false
let dirty = false
let releaseShortcuts: (() => void) | undefined
const models = new Map<string, MonacoModel>()
const viewStates = new Map<string, Monaco.editor.ICodeEditorViewState>()

const slideMode = computed<Mode>(() => {
  const frontmatterMode = nav.currentFrontmatter.value.workbench
  if (frontmatterMode === 'hidden') return 'hidden'
  if (frontmatterMode === 'editor' || frontmatterMode === 'terminal' || frontmatterMode === 'integrated') return frontmatterMode
  return config.defaultMode as Mode
})
const mode = computed<Mode>(() => selectedMode.value || slideMode.value)
const visible = computed(() => mode.value !== 'hidden')
const editorVisible = computed(() => mode.value === 'editor' || mode.value === 'integrated')
const terminalVisible = computed(() => mode.value === 'terminal' || mode.value === 'integrated')
const explorerVisible = computed(() => mode.value !== 'terminal')
const workbenchStyle = computed(() => ({
  '--workbench-height': `${config.layout.workbenchHeight}%`,
  '--explorer-width': `${config.layout.explorerWidth}%`,
  '--editor-height': `${config.layout.editorHeight}%`,
}))

const fileRows = computed(() => {
  const rows: Array<{ node: FileNode; depth: number }> = []
  const append = (nodes: FileNode[], depth: number) => {
    for (const node of nodes) {
      rows.push({ node, depth })
      if (node.type === 'directory' && expandedFolders.value.has(node.path)) append(node.children || [], depth + 1)
    }
  }
  append(tree.value, 0)
  return rows
})

function postJSON(path: string, body: unknown) {
  return fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function readJSON(response: Response) {
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`)
  return payload
}

async function refreshTree() {
  try {
    const response = await fetch('/api/workspace/tree')
    if (response.status === 401) {
      ready.value = false
      disconnectTerminal()
      connectionStatus.value = 'Workspace session ended'
      return
    }
    const payload = await readJSON(response)
    tree.value = Array.isArray(payload.tree) ? payload.tree : []
  } catch (error) {
    errorMessage.value = String(error)
  }
}

function languageFor(path: string) {
  const extension = path.split('.').pop()?.toLowerCase()
  const languages: Record<string, string> = {
    c: 'c', cc: 'cpp', cpp: 'cpp', css: 'css', go: 'go', html: 'html', js: 'javascript',
    json: 'json', md: 'markdown', mjs: 'javascript', py: 'python', rb: 'ruby', rs: 'rust',
    sh: 'shell', sql: 'sql', toml: 'ini', ts: 'typescript', tsx: 'typescript', yaml: 'yaml', yml: 'yaml',
  }
  return languages[extension || ''] || 'plaintext'
}

function firstFile(nodes: FileNode[]): string | undefined {
  for (const node of nodes) {
    if (node.type === 'file') return node.path
  }
  for (const node of nodes) {
    const path = firstFile(node.children ?? [])
    if (path) return path
  }
}

async function initializeEditor() {
  if (!editorHost.value || !ready.value) return
  if (editor) {
    if (!editor.getModel()) await openFile(firstFile(tree.value))
    return
  }
  if (loadingEditor) return loadingEditor
  loadingEditor = (async () => {
    const loadedMonaco = await import('monaco-editor')
    if (!editorHost.value || !ready.value) return
    monacoApi = loadedMonaco
    globalThis.MonacoEnvironment = {
      async getWorker(_moduleId, label) {
        switch (label) {
          case 'typescript':
          case 'javascript':
            return new (await import('monaco-editor/language/typescript/ts.worker?worker')).default()
          case 'css':
          case 'scss':
          case 'less':
            return new (await import('monaco-editor/language/css/css.worker?worker')).default()
          case 'html':
            return new (await import('monaco-editor/language/html/html.worker?worker')).default()
          case 'json':
            return new (await import('monaco-editor/language/json/json.worker?worker')).default()
          default:
            return new (await import('monaco-editor/editor/editor.worker?worker')).default()
        }
      },
    }
    monacoApi.editor.setTheme('vs-dark')
    editor = monacoApi.editor.create(editorHost.value, {
      automaticLayout: true,
      minimap: { enabled: false },
      lineNumbers: 'on',
      scrollBeyondLastLine: false,
      wordWrap: 'on',
      fontSize: editorFontSize.value,
      tabSize: 2,
      padding: { top: 12, bottom: 12 },
      ariaLabel: 'Workshop source editor',
    })
    await openFile(firstFile(tree.value))
  })()
  try { await loadingEditor }
  catch (error) { errorMessage.value = `Could not load the editor: ${String(error)}` }
  finally { loadingEditor = undefined }
}

async function openFile(path?: string) {
  if (!path || !editor || !monacoApi || !ready.value) return
  const selection = ++fileSelection
  if (path === currentFile.value) return
  try {
    let model = models.get(path)
    if (!model) {
      const payload = await readJSON(await fetch(`/api/workspace/file?path=${encodeURIComponent(path)}`))
      if (selection !== fileSelection || !ready.value) return
      const uri = monacoApi.Uri.from({ scheme: 'file', path: `/${path}` })
      model = monacoApi.editor.createModel(payload.content, languageFor(path), uri)
      model.onDidChangeContent(() => {
        if (applyingRemoteFile || currentFile.value !== path) return
        dirty = true
        fileStatus.value = 'Unsaved changes'
        clearTimeout(saveTimer)
        saveTimer = setTimeout(() => { void saveFile() }, 450)
      })
      models.set(path, model)
    }
    if (!await saveFile() || dirty || selection !== fileSelection || !ready.value) return
    const oldState = editor.saveViewState()
    if (currentFile.value && oldState) viewStates.set(currentFile.value, oldState)
    currentFile.value = path
    editor.setModel(model)
    const state = viewStates.get(path)
    if (state) editor.restoreViewState(state)
    fileStatus.value = 'Saved'
    errorMessage.value = ''
  } catch (error) {
    if (selection === fileSelection) errorMessage.value = String(error)
  }
}

async function saveFile() {
  clearTimeout(saveTimer)
  while (pendingSave) {
    if (!await pendingSave) return false
  }
  if (!currentFile.value || !editor || !dirty) return true
  const path = currentFile.value
  const content = editor.getValue()
  fileStatus.value = 'Saving…'
  pendingSave = writeFile(path, content)
  try { return await pendingSave }
  finally { pendingSave = undefined }
}

async function writeFile(path: string, content: string) {
  try {
    await readJSON(await postJSON('/api/workspace/file', { path, content }))
    if (currentFile.value === path && editor?.getValue() === content) {
      dirty = false
      fileStatus.value = 'Saved'
    }
    return true
  } catch (error) {
    fileStatus.value = 'Save failed'
    errorMessage.value = String(error)
    return false
  }
}

async function refreshActiveFile() {
  const path = currentFile.value
  const model = models.get(path)
  if (!model || dirty) return
  const version = model.getVersionId()
  try {
    const response = await fetch(`/api/workspace/file?path=${encodeURIComponent(path)}`)
    const payload = await readJSON(response)
    if (path !== currentFile.value || models.get(path) !== model || dirty || version !== model.getVersionId()) return
    if (typeof payload.content !== 'string' || model.getValue() === payload.content) return
    applyingRemoteFile = true
    model.setValue(payload.content)
    fileStatus.value = 'Updated from terminal'
  } catch {
    // A file may have been removed or renamed from the terminal.
  } finally {
    applyingRemoteFile = false
  }
}

function toggleFolder(path: string) {
  const next = new Set(expandedFolders.value)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  expandedFolders.value = next
}

function initializeTerminal() {
  if (terminal || !terminalHost.value) return
  try {
    terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: terminalFontSize.value,
      scrollback: 4000,
      theme: { background: '#111827', foreground: '#e5e7eb', cursor: '#93c5fd', selectionBackground: '#374151' },
    })
    fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(terminalHost.value!)
    terminal.onData(data => {
      if (socket?.readyState !== WebSocket.OPEN) return
      const currentSocket = socket
      if (data.includes('\r')) {
        void saveFile().then(saved => {
          if (saved && currentSocket.readyState === WebSocket.OPEN) currentSocket.send(JSON.stringify({ type: 'input', data }))
        })
      } else {
        currentSocket.send(JSON.stringify({ type: 'input', data }))
      }
    })
    terminal.textarea?.addEventListener('focus', lockTerminalShortcuts)
    terminal.textarea?.addEventListener('blur', unlockTerminalShortcuts)
    terminal.onResize(({ cols, rows }) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols, rows }))
    })
    resizeObserver = new ResizeObserver(() => requestAnimationFrame(() => {
      try { fitAddon?.fit() } catch { /* Container may still be changing size. */ }
    }))
    resizeObserver.observe(terminalHost.value!)
  } catch (error) {
    terminal?.dispose()
    terminal = undefined
    fitAddon = undefined
    errorMessage.value = `Could not load the terminal: ${String(error)}`
  }
}

function lockTerminalShortcuts() {
  releaseShortcuts ??= lockShortcuts()
}

function unlockTerminalShortcuts() {
  releaseShortcuts?.()
  releaseShortcuts = undefined
}

function disconnectTerminal() {
  clearTimeout(reconnectTimer)
  const connection = socket
  socket = undefined
  connection?.close()
}

function clearTerminal() {
  terminal?.reset()
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'clear' }))
}

async function connectTerminal() {
  if (!ready.value || !terminal || !terminalVisible.value || busy.value) return
  if (socket && socket.readyState <= WebSocket.OPEN) return
  busy.value = true
  try {
    if (!await saveFile()) throw new Error('Save the active file before connecting to the terminal.')
    const ticket = await readJSON(await postJSON('/api/terminal-token', {}))
    if (!ready.value || !visible.value || !terminalVisible.value) return
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const address = ticket.local
      ? `${protocol}//${location.host}/terminal`
      : (() => {
          const endpoint = new URL(ticket.endpoint)
          endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'
          endpoint.pathname = '/terminal'
          endpoint.search = ''
          endpoint.hash = ''
          return endpoint.toString()
        })()
    const protocols = ticket.local
      ? [TERMINAL_PROTOCOL]
      : ['lambda-microvms', `lambda-microvms.authentication.${ticket.token}`, `lambda-microvms.port.${ticket.port}`, TERMINAL_PROTOCOL]
    const newSocket = new WebSocket(address, protocols)
    socket = newSocket
    connectionStatus.value = 'Connecting…'
    newSocket.addEventListener('open', () => {
      if (socket !== newSocket) return
      connectionStatus.value = 'Connected'
      requestAnimationFrame(() => {
        try { fitAddon?.fit() } catch { /* Terminal is not visible yet. */ }
        if (terminal) newSocket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }))
      })
    })
    newSocket.addEventListener('message', event => {
      if (socket !== newSocket || typeof event.data !== 'string' || !terminal) return
      let frame: { type?: string; data?: string }
      try { frame = JSON.parse(event.data) } catch { return }
      if ((frame.type === 'output' || frame.type === 'replay') && typeof frame.data === 'string') {
        if (frame.type === 'replay') terminal.reset()
        terminal.write(frame.data)
      }
    })
    newSocket.addEventListener('close', event => {
      if (socket !== newSocket) return
      socket = undefined
      if (!ready.value || event.code === 4001) {
        connectionStatus.value = event.code === 4001 ? 'Opened in another tab' : 'Not connected'
        return
      }
      connectionStatus.value = 'Disconnected · reconnecting…'
      reconnectTimer = setTimeout(() => { void connectTerminal() }, 900)
    })
    newSocket.addEventListener('error', () => { connectionStatus.value = 'Connection failed' })
  } catch (error) {
    connectionStatus.value = String(error)
  } finally {
    busy.value = false
  }
}

async function readSession() {
  const session = await readJSON(await fetch('/api/me', { credentials: 'same-origin' }))
  if (stopping.value) return
  const wasReady = ready.value
  const isReady = Boolean(session.joined && session.status === 'ready')
  if (wasReady && !isReady) {
    disconnectTerminal()
  }
  if (!wasReady && isReady) {
    for (const model of models.values()) model.dispose()
    models.clear()
    viewStates.clear()
    currentFile.value = ''
    fileSelection++
    expandedFolders.value = new Set()
    fileStatus.value = 'Choose a file to begin'
    dirty = false
    editor?.setModel(null)
    terminal?.reset()
    tree.value = []
  }
  ready.value = isReady
  if (!socket) {
    connectionStatus.value = ready.value ? 'Environment ready' : session.joined ? 'Starting environment…' : 'Join to start the environment'
  }
  if (ready.value && visible.value) {
    await refreshTree()
    if (editorVisible.value) {
      await nextTick()
      await initializeEditor()
    }
    if (terminalVisible.value) {
      await nextTick()
      initializeTerminal()
      void connectTerminal()
    }
  }
}

async function joinWorkshop() {
  if (starting.value || stopping.value) return
  starting.value = true
  errorMessage.value = ''
  connectionStatus.value = 'Starting your workspace…'
  try {
    const requestId = crypto.randomUUID()
    await readJSON(await postJSON('/api/join', { requestId }))
    for (let attempt = 0; attempt < 120; attempt++) {
      await readSession()
      if (ready.value) return
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    throw new Error('The environment did not become ready in time.')
  } catch (error) {
    errorMessage.value = String(error)
    connectionStatus.value = 'Could not start the environment'
  } finally {
    starting.value = false
  }
}

async function leaveWorkshop() {
  if (stopping.value) return
  stopping.value = true
  errorMessage.value = ''
  if (!await saveFile()) {
    stopping.value = false
    return
  }
  ready.value = false
  disconnectTerminal()
  terminal?.reset()
  connectionStatus.value = 'Stopping workspace…'
  try {
    await readJSON(await postJSON('/api/leave', {}))
    connectionStatus.value = 'Workspace stopped'
  } catch (error) {
    errorMessage.value = String(error)
    connectionStatus.value = 'Could not stop workspace'
  } finally {
    stopping.value = false
  }
}

function changeFontSize(target: 'editor' | 'terminal', delta: number) {
  if (target === 'editor') {
    editorFontSize.value = Math.max(11, Math.min(24, editorFontSize.value + delta))
    editor?.updateOptions({ fontSize: editorFontSize.value })
  } else {
    terminalFontSize.value = Math.max(11, Math.min(24, terminalFontSize.value + delta))
    if (terminal) terminal.options.fontSize = terminalFontSize.value
    try { fitAddon?.fit() } catch { /* Terminal may be hidden. */ }
  }
}

watch(() => nav.currentPage.value, () => { selectedMode.value = null })
watch(mode, async () => {
  await nextTick()
  if (ready.value && editorVisible.value) await initializeEditor()
  if (ready.value && terminalVisible.value) {
    initializeTerminal()
    void connectTerminal()
  }
  try { fitAddon?.fit() } catch { /* Terminal may be hidden. */ }
})

onMounted(() => {
  async function syncWorkspace() {
    if (starting.value || stopping.value) return
    if (ready.value && visible.value) {
      await Promise.all([refreshTree(), refreshActiveFile()])
    } else {
      try { await readSession() }
      catch (error) { errorMessage.value = String(error) }
    }
  }
  void syncWorkspace()
  pollTimer = setInterval(() => { void syncWorkspace() }, 2000)
})

onBeforeUnmount(() => {
  clearInterval(pollTimer)
  clearTimeout(saveTimer)
  ready.value = false
  disconnectTerminal()
  resizeObserver?.disconnect()
  terminal?.textarea?.removeEventListener('focus', lockTerminalShortcuts)
  terminal?.textarea?.removeEventListener('blur', unlockTerminalShortcuts)
  unlockTerminalShortcuts()
  terminal?.dispose()
  for (const model of models.values()) model.dispose()
  editor?.dispose()
})
</script>

<template>
  <section
    v-show="visible"
    class="execdeck-workbench"
    :class="`mode-${mode}`"
    :data-mode="mode"
    :style="workbenchStyle"
    aria-label="Workshop workspace"
  >
    <nav class="mode-switcher" aria-label="Workspace view">
      <button :aria-pressed="mode === 'integrated'" @click="selectedMode = 'integrated'">Split</button>
      <button :aria-pressed="mode === 'editor'" @click="selectedMode = 'editor'">Editor</button>
      <button :aria-pressed="mode === 'terminal'" @click="selectedMode = 'terminal'">Terminal</button>
      <button v-if="ready" class="stop-action" :disabled="stopping" @click="void leaveWorkshop()">Stop</button>
    </nav>

    <aside v-show="explorerVisible" class="explorer" aria-label="Workspace files">
      <div class="explorer-heading">WORKSPACE</div>
      <div v-for="{ node, depth } in fileRows" :key="node.path">
        <button
          v-if="node.type === 'directory'"
          class="tree-row"
          :style="{ '--depth': depth }"
          :aria-expanded="expandedFolders.has(node.path)"
          @click="toggleFolder(node.path)"
        >
          <span class="tree-icon" aria-hidden="true">{{ expandedFolders.has(node.path) ? '▾' : '▸' }}</span>
          <span class="tree-name" :title="node.name">{{ node.name }}</span>
        </button>
        <button
          v-else
          class="tree-row"
          :class="{ active: node.path === currentFile }"
          :style="{ '--depth': depth }"
          @click="void openFile(node.path)"
        >
          <span class="tree-icon" aria-hidden="true">{{ node.name.endsWith('.md') ? 'M' : node.name.endsWith('.sh') ? '$' : '·' }}</span>
          <span class="tree-name" :title="node.name">{{ node.name }}</span>
        </button>
      </div>
      <div v-if="!fileRows.length" class="empty-tree">Workspace is empty.</div>
    </aside>

    <div class="workbench-main">
      <div v-show="editorVisible" class="editor-pane">
        <header class="pane-toolbar">
          <span class="active-file">{{ currentFile || 'No file selected' }}</span>
          <span class="save-status">{{ fileStatus }}</span>
          <div class="toolbar-group" aria-label="Editor font size">
            <button title="Smaller editor text" aria-label="Smaller editor text" @click="changeFontSize('editor', -1)">A−</button>
            <button title="Larger editor text" aria-label="Larger editor text" @click="changeFontSize('editor', 1)">A+</button>
          </div>
        </header>
        <div ref="editorHost" class="editor-host" />
      </div>

      <div v-show="terminalVisible" class="terminal-pane">
        <header class="pane-toolbar">
          <span class="terminal-title"><i :class="{ connected: connectionStatus === 'Connected' }" />Terminal</span>
          <span class="terminal-status">{{ connectionStatus }}</span>
          <div class="toolbar-group" aria-label="Terminal font size">
            <button title="Smaller terminal text" aria-label="Smaller terminal text" @click="changeFontSize('terminal', -1)">A−</button>
            <button title="Larger terminal text" aria-label="Larger terminal text" @click="changeFontSize('terminal', 1)">A+</button>
          </div>
          <button class="toolbar-action" title="Clear terminal" @click="clearTerminal">Clear</button>
        </header>
        <div ref="terminalHost" class="terminal-host" />
      </div>
    </div>

    <div v-if="!ready" class="launch-overlay">
      <div class="launch-card">
        <strong>Start your workshop workspace</strong>
        <span>{{ connectionStatus }}</span>
        <button :disabled="starting || stopping" @click="void joinWorkshop()">{{ stopping ? 'Stopping…' : starting ? 'Starting…' : 'Start workspace' }}</button>
        <span v-if="errorMessage" class="launch-error">{{ errorMessage }}</span>
      </div>
    </div>
    <div v-else-if="errorMessage" class="inline-error" role="status">
      <span>{{ errorMessage }}</span>
      <button aria-label="Dismiss error" @click="errorMessage = ''">×</button>
    </div>
  </section>
</template>

<style scoped>
/* Slidev's floating controls intercept pointer input at the bottom of the slide. */
:global(.slidev-slide-container:has(> .slidev-slide-content > .execdeck-workbench:not(.mode-hidden)) > .absolute.bottom-0.left-0:has(> nav)) {
  top: 0;
  bottom: auto;
}
.execdeck-workbench {
  position: absolute;
  z-index: 30;
  inset: auto 0 0;
  height: var(--workbench-height, 50%);
  display: grid;
  grid-template-columns: var(--explorer-width, 22%) minmax(0, 1fr);
  grid-template-rows: 29px minmax(0, 1fr);
  overflow: hidden;
  color: #e5e7eb;
  background: #111827;
  border-top: 1px solid #374151;
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.explorer { min-width: 0; min-height: 0; overflow: auto; padding: 7px 0; background: #111827; border-right: 1px solid #374151; }
.explorer-heading { padding: 5px 12px 8px; color: #9ca3af; font-size: 10px; font-weight: 700; letter-spacing: .12em; }
.tree-row { width: 100%; display: flex; align-items: center; gap: 7px; min-height: 25px; padding: 2px 8px 2px calc(8px + var(--depth, 0) * 13px); border: 0; color: #d1d5db; background: transparent; text-align: left; cursor: pointer; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
.tree-row:hover { background: #1f2937; }
.tree-row.active { color: #fff; background: #1f2937; }
.tree-icon { width: 13px; flex: 0 0 auto; color: #93c5fd; text-align: center; }
.tree-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.empty-tree { padding: 12px; color: #9ca3af; font-size: 12px; }
.workbench-main { min-width: 0; min-height: 0; display: grid; grid-template-rows: var(--editor-height, 60%) minmax(0, 1fr); }
.editor-pane, .terminal-pane { min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.editor-pane { border-bottom: 1px solid #374151; background: #111827; }
.terminal-pane { background: #0b1220; }
.pane-toolbar { min-height: 32px; display: flex; align-items: center; gap: 9px; padding: 0 9px; background: #1f2937; border-bottom: 1px solid #374151; font-size: 11px; }
.active-file { min-width: 0; flex: 1; overflow: hidden; color: #d1d5db; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.save-status, .terminal-status { min-width: 0; overflow: hidden; color: #9ca3af; text-overflow: ellipsis; white-space: nowrap; }
.toolbar-group { display: inline-flex; flex-shrink: 0; gap: 2px; }
.toolbar-group button, .toolbar-action { min-width: 28px; height: 23px; padding: 0 5px; border: 1px solid #4b5563; border-radius: 4px; color: #d1d5db; background: #111827; cursor: pointer; font-size: 10px; }
.toolbar-group button:hover, .toolbar-action:hover { border-color: #93c5fd; color: white; }
.editor-host { flex: 1; min-height: 0; }
.terminal-title { display: inline-flex; flex-shrink: 0; align-items: center; gap: 7px; margin-right: auto; }
.terminal-title i { width: 7px; height: 7px; border-radius: 50%; background: #f59e0b; }
.terminal-title i.connected { background: #4ade80; }
.terminal-host { flex: 1; min-height: 0; padding: 6px 9px 8px; overflow: hidden; }
.terminal-host :deep(.xterm) { height: 100%; }
.terminal-host :deep(.xterm-viewport) { scrollbar-color: #4b5563 #0b1220; }
.mode-switcher { grid-column: 1 / -1; display: flex; justify-content: flex-end; align-items: center; gap: 2px; padding: 2px 8px; border-bottom: 1px solid #374151; }
.mode-switcher button { padding: 3px 7px; border: 0; border-radius: 4px; color: #9ca3af; background: transparent; cursor: pointer; font-size: 11px; }
.mode-switcher button:hover, .mode-switcher button[aria-pressed="true"] { color: white; background: #374151; }
.mode-switcher .stop-action { margin-left: 3px; border-left: 1px solid #4b5563; color: #fca5a5; }
.mode-switcher .stop-action:hover { color: white; background: #7f1d1d; }
.mode-switcher .stop-action:disabled { opacity: .6; cursor: wait; }
.mode-terminal { grid-template-columns: minmax(0, 1fr); }
.mode-terminal .workbench-main { grid-template-rows: minmax(0, 1fr); }
.mode-editor .workbench-main { grid-template-rows: minmax(0, 1fr); }
.launch-overlay { position: absolute; z-index: 5; inset: 0; display: flex; overflow: auto; padding: 8px; background: #0b1220cc; }
.launch-card { width: min(360px, 100%); display: flex; flex-direction: column; align-items: flex-start; gap: 10px; margin: auto; padding: 18px; border: 1px solid #4b5563; border-radius: 10px; background: #111827; box-shadow: 0 15px 40px #0008; }
.launch-card strong { font-size: 15px; }
.launch-card span { color: #9ca3af; font-size: 12px; }
.launch-card button { padding: 8px 12px; border: 0; border-radius: 6px; color: #111827; background: #bfdbfe; cursor: pointer; font-weight: 650; }
.launch-card button:disabled { opacity: .6; cursor: wait; }
.launch-card .launch-error { color: #fca5a5; overflow-wrap: anywhere; }
.inline-error { position: absolute; z-index: 6; left: 8px; bottom: 8px; display: flex; align-items: center; gap: 10px; max-width: min(520px, 90%); padding: 8px 10px; border: 1px solid #7f1d1d; border-radius: 6px; color: #fecaca; background: #450a0a; font-size: 12px; overflow-wrap: anywhere; }
.inline-error button { color: inherit; cursor: pointer; }
</style>
