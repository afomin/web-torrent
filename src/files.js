import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'

const root = fs.realpathSync(config.downloadsDir)
const INCOMPLETE = path.basename(config.incompleteDir)

const VIDEO_EXT = new Set(['.mp4', '.m4v', '.webm', '.mkv', '.mov', '.ogv', '.avi', '.ts'])
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wav'])

export class PathError extends Error {
  constructor (msg, status = 400) {
    super(msg)
    this.status = status
  }
}

/**
 * Resolve a user-supplied relative path inside the downloads directory.
 * Rejects anything that escapes the root, including via symlinks.
 */
export async function resolveSafe (rel = '') {
  if (typeof rel !== 'string' || rel.includes('\0')) throw new PathError('Bad path')
  const abs = path.resolve(root, '.' + path.sep + rel)
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new PathError('Bad path')
  if (path.relative(root, abs).split(path.sep)[0] === INCOMPLETE) throw new PathError('Not found', 404)
  let real
  try {
    real = await fsp.realpath(abs)
  } catch {
    throw new PathError('Not found', 404)
  }
  if (real !== root && !real.startsWith(root + path.sep)) throw new PathError('Bad path')
  return real
}

export function toRel (abs) {
  return path.relative(root, abs).split(path.sep).join('/')
}

export function kindOf (name) {
  const ext = path.extname(name).toLowerCase()
  if (VIDEO_EXT.has(ext)) return 'video'
  if (AUDIO_EXT.has(ext)) return 'audio'
  return 'file'
}

async function dirSize (dir) {
  let total = 0
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) total += await dirSize(p)
    else if (e.isFile()) total += (await fsp.stat(p)).size
  }
  return total
}

export async function listDir (rel) {
  const abs = await resolveSafe(rel)
  const st = await fsp.stat(abs)
  if (!st.isDirectory()) throw new PathError('Not a directory')
  const entries = await fsp.readdir(abs, { withFileTypes: true })
  const items = []
  for (const e of entries) {
    if (!e.isDirectory() && !e.isFile()) continue
    if (abs === root && e.name === INCOMPLETE) continue
    const p = path.join(abs, e.name)
    const s = await fsp.stat(p)
    items.push({
      name: e.name,
      path: toRel(p),
      type: e.isDirectory() ? 'dir' : 'file',
      kind: e.isDirectory() ? 'dir' : kindOf(e.name),
      size: e.isDirectory() ? await dirSize(p) : s.size,
      mtime: s.mtimeMs
    })
  }
  items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.type === 'dir' ? -1 : 1))
  return { path: toRel(abs), items }
}

export async function remove (rel) {
  const abs = await resolveSafe(rel)
  if (abs === root) throw new PathError('Cannot delete root')
  await fsp.rm(abs, { recursive: true, force: true })
}

/** Bytes actually allocated on disk (sparse files count only what's written). */
async function allocated (p) {
  let total = 0
  let st
  try { st = await fsp.lstat(p) } catch { return 0 }
  if (st.isDirectory()) {
    for (const name of await fsp.readdir(p)) total += await allocated(path.join(p, name))
  } else if (st.isFile()) {
    total += st.blocks * 512
  }
  return total
}

let breakdownCache = { at: 0, data: null }

export async function diskUsage () {
  const s = await fsp.statfs(root)
  const total = s.blocks * s.bsize
  const free = s.bavail * s.bsize
  // What the app itself uses; the rest of "used" is the OS, Docker images/cache, swap, logs...
  if (!breakdownCache.data || breakdownCache.at < Date.now() - 30000) {
    const incomplete = await allocated(path.join(root, INCOMPLETE))
    const downloads = (await allocated(root)) - incomplete
    const appData = await allocated(config.dataDir)
    breakdownCache = { at: Date.now(), data: { downloads, incomplete, appData } }
  }
  const { downloads, incomplete, appData } = breakdownCache.data
  const used = total - free
  // Root-reserved blocks (bfree - bavail) are neither free for us nor used by anything.
  const reserved = (s.bfree - s.bavail) * s.bsize
  return {
    total,
    free,
    used,
    downloads,
    incomplete,
    appData,
    reserved,
    other: Math.max(0, used - reserved - downloads - incomplete - appData)
  }
}

/** Pick a name that doesn't exist yet in dir: "Movie", "Movie (2)", ... */
export function uniqueName (dir, name) {
  if (!fs.existsSync(path.join(dir, name))) return name
  const ext = path.extname(name)
  const base = ext && ext.length <= 6 ? name.slice(0, -ext.length) : name
  const suffix = ext && ext.length <= 6 ? ext : ''
  for (let i = 2; ; i++) {
    const candidate = `${base} (${i})${suffix}`
    if (!fs.existsSync(path.join(dir, candidate))) return candidate
  }
}
