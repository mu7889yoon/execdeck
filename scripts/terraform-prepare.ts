import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const marker = join(root, 'infrastructure', 'build', 'prepare-hash')
const excluded = new Set(['.git', '.terraform', 'node_modules', 'dist', 'build'])

async function sourceFiles(directory: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const paths = []
  for (const entry of entries) {
    if (excluded.has(entry.name) || entry.name === '.DS_Store') continue
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
    const absolutePath = join(directory, entry.name)
    if (entry.isDirectory()) paths.push(...await sourceFiles(absolutePath, relativePath))
    else if (entry.isFile()) paths.push(relativePath)
  }
  return paths
}

async function fingerprint() {
  const hash = createHash('sha256')
  for (const file of ['package.json', 'package-lock.json', 'tsconfig.json']) {
    hash.update(file)
    hash.update(await readFile(join(root, file)))
  }
  for (const path of ['control', 'slides', 'scripts']) {
    const absolute = join(root, path)
    for (const relativePath of (await sourceFiles(absolute)).sort()) {
      hash.update(`${path}/${relativePath}\0`)
      hash.update(await readFile(join(absolute, relativePath)))
    }
  }
  return hash.digest('hex')
}

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' })
  if (result.stdout) process.stderr.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`)
}

const hash = await fingerprint()
const outputs = [
  'slides/dist/index.html', 'control/node_modules',
  'control/dist/aws-runtime.js', 'control/dist/reaper.js', 'control/dist/handler.js', 'control/dist/aws-services.js',
]
const oldHash = await readFile(marker, 'utf8').catch(() => '')
const built = oldHash.trim() === hash && (await Promise.all(outputs.map(path =>
  stat(join(root, path)).then(() => true, () => false),
))).every(Boolean)

if (!built) {
  run('npm', ['ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'])
  run('npm', ['ci', '--prefix', 'control', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'])
  run('npm', ['run', 'build:control'])
  run('npm', ['ci', '--prefix', 'slides', '--no-audit', '--no-fund'])
  run('npm', ['run', 'build', '--prefix', 'slides'])
  await mkdir(dirname(marker), { recursive: true })
  await writeFile(marker, `${hash}\n`)
}

async function listFiles(directory: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
    const absolutePath = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await listFiles(absolutePath, relativePath))
    else if (entry.isFile()) files.push(relativePath)
  }
  return files.sort()
}

const files = await listFiles(join(root, 'slides', 'dist'))
process.stdout.write(`${JSON.stringify({ files: JSON.stringify(files) })}\n`)
