import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import WebTorrent from 'webtorrent'
import parseTorrent from 'parse-torrent'
import { config } from './config.js'
import { uniqueName } from './files.js'

// Extra public trackers help magnets without trackers find peers/metadata faster.
// Only used for magnet links — never added to .torrent files (they may be private).
const PUBLIC_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://explodie.org:6969/announce'
]

const MAX_TORRENT_FILE = 10 * 1024 * 1024
const HISTORY_LIMIT = 100

// Seeding is off by default: peers are kept choked and piece requests are refused.
// Upload speed limit in KB/s, 0 = unlimited. Lower bound keeps protocol messages flowing.
const DEFAULT_SETTINGS = { seeding: false, uploadLimitKB: 500 }
const MIN_UPLOAD_KB = 10

export class TorrentError extends Error {
  constructor (msg, status = 400) {
    super(msg)
    this.status = status
  }
}

export class TorrentManager {
  constructor () {
    this.stateFile = path.join(config.dataDir, 'torrents.json')
    this.historyFile = path.join(config.dataDir, 'history.json')
    this.settingsFile = path.join(config.dataDir, 'settings.json')
    this.settings = { ...DEFAULT_SETTINGS }
    /** @type {Map<string, object>} persisted entries */
    this.entries = new Map()
    /** @type {Map<string, import('webtorrent').Torrent>} running torrents */
    this.running = new Map()
    this.history = []

    this.client = new WebTorrent({
      torrentPort: config.torrentPort,
      dhtPort: config.torrentPort,
      maxConns: config.maxConns,
      natUpnp: false,
      natPmp: false,
      lsd: false,
      downloadLimit: config.downloadLimitKB >= 0 ? config.downloadLimitKB * 1024 : -1
    })
    this.client.on('error', err => console.error('[webtorrent]', err.message))

    this._load()
    this._applySettings()
    for (const entry of this.entries.values()) {
      if (entry.status === 'active' || entry.status === 'select') this._start(entry)
    }
    // Periodically persist progress so paused/restarted torrents show something sensible.
    this._saveTimer = setInterval(() => this._snapshotAndSave(), 15000)
    this._saveTimer.unref()
  }

  // ---------- persistence ----------

  _load () {
    try {
      const list = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'))
      for (const e of list) this.entries.set(e.id, e)
    } catch {}
    try {
      this.history = JSON.parse(fs.readFileSync(this.historyFile, 'utf8'))
    } catch {}
    try {
      this.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')) }
    } catch {}
  }

  _save () {
    const tmp = this.stateFile + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify([...this.entries.values()], null, 2))
    fs.renameSync(tmp, this.stateFile)
  }

  _saveHistory () {
    fs.writeFileSync(this.historyFile, JSON.stringify(this.history.slice(0, HISTORY_LIMIT), null, 2))
  }

  _snapshotAndSave () {
    for (const [id, t] of this.running) {
      const e = this.entries.get(id)
      const p = e && this._progressOf(e, t)
      if (p && e.status !== 'select') Object.assign(e, p)
    }
    try { this._save() } catch (err) { console.error('save failed', err.message) }
  }

  // ---------- seeding control ----------

  getSettings () {
    return { ...this.settings }
  }

  setSettings ({ seeding, uploadLimitKB }) {
    if (seeding !== undefined) this.settings.seeding = !!seeding
    if (uploadLimitKB !== undefined) {
      const n = Math.round(Number(uploadLimitKB))
      if (!Number.isFinite(n) || n < 0) throw new TorrentError('Некорректный лимит')
      this.settings.uploadLimitKB = n === 0 ? 0 : Math.max(n, MIN_UPLOAD_KB)
    }
    fs.writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 2))
    this._applySettings()
    return this.getSettings()
  }

  _applySettings () {
    const { seeding, uploadLimitKB } = this.settings
    // The throttle covers every outgoing byte (handshakes, requests), so it is only used to cap
    // seeding speed; "no seeding" is enforced at the protocol level in _guardWire instead.
    this.client.throttleUpload(seeding && uploadLimitKB > 0 ? uploadLimitKB * 1024 : -1)
    for (const t of this.running.values()) {
      for (const wire of t.wires) {
        if (!seeding) wire.choke()
        else if (wire.peerInterested) wire.unchoke() // don't wait for the next rechoke round
      }
    }
  }

  /** Keep a peer connection from receiving data unless seeding is enabled. */
  _guardWire (wire) {
    const unchoke = wire.unchoke.bind(wire)
    wire.unchoke = () => { if (this.settings.seeding) unchoke() }
    const onRequest = wire._onRequest.bind(wire)
    wire._onRequest = (index, offset, length) => {
      if (this.settings.seeding) return onRequest(index, offset, length)
      if (wire.hasFast) wire.reject(index, offset, length)
    }
    if (!this.settings.seeding) wire.choke()
  }

  // ---------- adding ----------

  /**
   * @param {{ magnet?: string, torrentFile?: Buffer }} input
   */
  async add ({ magnet, torrentFile }) {
    let parsed
    let torrentBuf = null
    let magnetURI = null

    if (torrentFile) {
      torrentBuf = torrentFile
    } else if (typeof magnet === 'string' && magnet.trim()) {
      const link = magnet.trim()
      if (/^https?:\/\//i.test(link)) {
        torrentBuf = await fetchTorrentFile(link)
      } else if (/^magnet:\?/i.test(link)) {
        magnetURI = link
      } else if (/^[a-f0-9]{40}$/i.test(link)) {
        magnetURI = `magnet:?xt=urn:btih:${link}`
      } else {
        throw new TorrentError('Нужна magnet-ссылка, ссылка на .torrent или сам .torrent-файл')
      }
    } else {
      throw new TorrentError('Пустой запрос')
    }

    try {
      parsed = await parseTorrent(torrentBuf || magnetURI)
    } catch (err) {
      console.warn('[add] parse failed:', err.message)
      throw new TorrentError(describeParseError(torrentBuf, err))
    }
    if (!parsed?.infoHash) throw new TorrentError('Не удалось разобрать торрент: нет info hash')

    for (const e of this.entries.values()) {
      if (e.infoHash === parsed.infoHash) throw new TorrentError('Этот торрент уже добавлен', 409)
    }

    const id = crypto.randomBytes(8).toString('hex')
    const entry = {
      id,
      infoHash: parsed.infoHash,
      name: parsed.name || parsed.dn || parsed.infoHash,
      source: torrentBuf ? 'file' : 'magnet',
      magnet: magnetURI,
      addedAt: Date.now(),
      status: 'active',
      progress: 0,
      length: parsed.length || 0,
      downloaded: 0,
      // null = the user hasn't chosen yet; multi-file torrents wait for a choice
      selection: null
    }
    if (torrentBuf) {
      await fsp.writeFile(path.join(config.torrentFilesDir, `${id}.torrent`), torrentBuf)
    }
    this.entries.set(id, entry)
    this._save()
    this._start(entry)
    return this._view(entry)
  }

  _start (entry) {
    const dir = path.join(config.incompleteDir, entry.id)
    fs.mkdirSync(dir, { recursive: true })

    let source
    // Start with nothing selected; files are selected once metadata is known (see _onReady).
    const opts = { path: dir, destroyStoreOnDestroy: false, deselect: true }
    if (entry.source === 'file') {
      try {
        source = fs.readFileSync(path.join(config.torrentFilesDir, `${entry.id}.torrent`))
      } catch {
        entry.status = 'error'
        entry.error = '.torrent-файл потерян'
        this._save()
        return
      }
    } else {
      source = entry.magnet
      opts.announce = PUBLIC_TRACKERS
    }

    delete entry.error
    const torrent = this.client.add(source, opts)
    this.running.set(entry.id, torrent)

    torrent.on('wire', wire => this._guardWire(wire))
    torrent.on('metadata', () => {
      entry.name = torrent.name
      entry.length = torrent.length
      this._save()
    })
    torrent.on('error', err => {
      console.error(`[torrent ${entry.name}]`, err.message)
      this.running.delete(entry.id)
      entry.status = 'error'
      entry.error = err.message
      this._save()
    })
    torrent.on('ready', () => this._onReady(entry, torrent))
    torrent.on('done', () => setImmediate(() => this._checkComplete(entry, torrent)))
  }

  _onReady (entry, torrent) {
    entry.name = torrent.name
    entry.length = torrent.length
    entry.files = torrent.files.map(f => ({ path: f.path.split(path.sep).join('/'), length: f.length }))
    // Deferred: WebTorrent emits these while iterating its files; destroying the torrent inside would crash it.
    for (const f of torrent.files) f.on('done', () => setImmediate(() => this._checkComplete(entry, torrent)))
    if (entry.selection === undefined) {
      // Added by an older version: download everything, as before.
      entry.selection = torrent.files.map((_, i) => i)
    } else if (entry.selection === null) {
      if (torrent.files.length > 1) {
        entry.status = 'select'
        this._save()
        return
      }
      entry.selection = [0]
    }
    this._applySelection(entry, torrent)
    this._save()
    setImmediate(() => this._checkComplete(entry, torrent))
  }

  _applySelection (entry, torrent) {
    const wanted = new Set(entry.selection || [])
    torrent.files.forEach((f, i) => {
      if (wanted.has(i) && !f._wtSelected) {
        f.select()
        f._wtSelected = true
      } else if (!wanted.has(i) && f._wtSelected) {
        f.deselect()
        f._wtSelected = false
      }
    })
  }

  /** Finish when every selected file is complete (WebTorrent's own 'done' needs *all* files). */
  _checkComplete (entry, torrent) {
    if (entry.finishing || entry.status === 'select' || !torrent.ready || torrent.destroyed) return
    if (!entry.selection?.length) return
    const done = entry.selection.every(i => torrent.files[i] && (torrent.files[i].length === 0 || torrent.files[i].done))
    if (!done) return
    this._finish(entry, torrent).catch(err => {
      console.error(`[finish ${entry.name}]`, err)
      entry.finishing = false
      entry.status = 'error'
      entry.error = 'Ошибка при переносе файлов: ' + err.message
      this._save()
    })
  }

  _progressOf (entry, t) {
    if (!t?.ready) return null
    const files = (entry.selection || []).map(i => t.files[i]).filter(Boolean)
    if (!files.length) return { progress: 0, length: 0, downloaded: 0 }
    const length = files.reduce((a, f) => a + f.length, 0)
    const downloaded = Math.min(length, files.reduce((a, f) => a + f.downloaded, 0))
    return { progress: length ? downloaded / length : 1, length, downloaded }
  }

  async _finish (entry, torrent) {
    if (entry.finishing) return
    entry.finishing = true
    const files = entry.files
    const selection = [...entry.selection]
    const multi = files.length > 1 || files[0].path.includes('/')
    // Stop seeding immediately: drop the torrent from the client, keep the data.
    await new Promise(resolve => torrent.destroy({ destroyStore: false }, () => resolve()))
    this.running.delete(entry.id)

    const dir = path.join(config.incompleteDir, entry.id)
    let dest = entry.dest
    if (multi) {
      // Folder torrents go to downloads/<name>/...; "download more" later merges into the same folder.
      if (!dest) dest = uniqueName(config.downloadsDir, files[0].path.split('/')[0])
      for (const i of selection) {
        const rel = files[i].path.split('/').slice(1).join('/')
        await moveInto(path.join(dir, files[i].path), path.join(config.downloadsDir, dest, rel))
      }
    } else {
      dest = uniqueName(config.downloadsDir, files[0].path)
      await moveInto(path.join(dir, files[0].path), path.join(config.downloadsDir, dest))
    }
    await fsp.rm(dir, { recursive: true, force: true })

    const doneFiles = [...new Set([...(entry.doneFiles || []), ...selection])].sort((a, b) => a - b)
    const complete = files.every((f, i) => f.length === 0 || doneFiles.includes(i))
    // Keep the .torrent only while there are files left to download later.
    const canAddMore = multi && !complete
    if (!canAddMore) await fsp.rm(path.join(config.torrentFilesDir, `${entry.id}.torrent`), { force: true })

    this.entries.delete(entry.id)
    this._save()
    this.history = this.history.filter(h => h.id !== entry.id)
    this.history.unshift({
      id: entry.id,
      name: entry.name,
      infoHash: entry.infoHash,
      length: doneFiles.reduce((a, i) => a + files[i].length, 0),
      totalLength: files.reduce((a, f) => a + f.length, 0),
      addedAt: entry.addedAt,
      completedAt: Date.now(),
      path: dest,
      files: multi ? files : null,
      doneFiles: multi ? doneFiles : null,
      canAddMore,
      source: canAddMore ? entry.source : undefined,
      magnet: canAddMore ? entry.magnet : undefined
    })
    this._saveHistory()
    console.log(`[done] ${entry.name} (${selection.length} of ${files.length} files)`)
  }

  // ---------- control ----------

  _get (id) {
    const e = this.entries.get(id)
    if (!e) throw new TorrentError('Торрент не найден', 404)
    return e
  }

  async pause (id) {
    const entry = this._get(id)
    const t = this.running.get(id)
    if (t) {
      const p = this._progressOf(entry, t)
      if (p && entry.status !== 'select') Object.assign(entry, p)
      this.running.delete(id)
      await new Promise(resolve => t.destroy({ destroyStore: false }, () => resolve()))
    }
    if (entry.status !== 'select') entry.status = 'paused'
    this._save()
    return this._view(entry)
  }

  resume (id) {
    const entry = this._get(id)
    if (this.running.has(id)) return this._view(entry)
    entry.status = entry.selection === null && entry.files?.length > 1 ? 'select' : 'active'
    this._save()
    this._start(entry)
    return this._view(entry)
  }

  /** Cancel a download and delete everything that was downloaded so far. */
  async remove (id) {
    const entry = this._get(id)
    const t = this.running.get(id)
    this.running.delete(id)
    this.entries.delete(id)
    this._save()
    if (t) await new Promise(resolve => t.destroy({ destroyStore: true }, () => resolve()))
    await fsp.rm(path.join(config.incompleteDir, id), { recursive: true, force: true })
    await fsp.rm(path.join(config.torrentFilesDir, `${id}.torrent`), { force: true })
    return { id: entry.id }
  }

  /** File list of an active torrent with per-file progress. */
  files (id) {
    const entry = this._get(id)
    if (!entry.files) throw new TorrentError('Список файлов ещё не получен — дождитесь метаданных', 409)
    const t = this.running.get(id)
    const sel = new Set(entry.selection || [])
    const done = new Set(entry.doneFiles || [])
    return {
      id,
      name: entry.name,
      files: entry.files.map((f, i) => {
        const tf = t?.ready ? t.files[i] : null
        return {
          index: i,
          path: f.path,
          length: f.length,
          downloaded: tf ? Math.min(f.length, tf.downloaded) : null,
          selected: sel.has(i) || (entry.selection === null),
          done: done.has(i) || !!tf?.done,
          previous: done.has(i)
        }
      })
    }
  }

  setFiles (id, indices) {
    const entry = this._get(id)
    if (!entry.files) throw new TorrentError('Список файлов ещё не получен — дождитесь метаданных', 409)
    const sel = normalizeSelection(indices, entry.files.length).filter(i => !(entry.doneFiles || []).includes(i))
    if (!sel.length) throw new TorrentError('Выберите хотя бы один файл', 400)
    entry.selection = sel
    if (entry.status === 'select') entry.status = 'active'
    const t = this.running.get(id)
    if (t?.ready) {
      this._applySelection(entry, t)
      setImmediate(() => this._checkComplete(entry, t))
    }
    this._save()
    return this._view(entry)
  }

  /** Files of a finished multi-file torrent, to pick more of them later. */
  historyFiles (id) {
    const h = this.history.find(x => x.id === id)
    if (!h?.files) throw new TorrentError('Нет списка файлов для этой загрузки', 404)
    const done = new Set(h.doneFiles || [])
    return {
      id,
      name: h.name,
      canAddMore: h.canAddMore,
      files: h.files.map((f, i) => ({ index: i, path: f.path, length: f.length, downloaded: done.has(i) ? f.length : 0, selected: done.has(i), done: done.has(i), previous: done.has(i) }))
    }
  }

  /** Start downloading more files of a finished torrent into the same folder. */
  async addMoreFiles (id, indices) {
    const h = this.history.find(x => x.id === id)
    if (!h?.canAddMore) throw new TorrentError('Для этой загрузки нельзя докачать файлы', 400)
    const sel = normalizeSelection(indices, h.files.length).filter(i => !h.doneFiles.includes(i))
    if (!sel.length) throw new TorrentError('Выберите хотя бы один новый файл', 400)
    for (const e of this.entries.values()) {
      if (e.infoHash === h.infoHash) throw new TorrentError('Этот торрент уже качается', 409)
    }
    const entry = {
      id: h.id,
      infoHash: h.infoHash,
      name: h.name,
      source: h.source,
      magnet: h.magnet,
      addedAt: Date.now(),
      status: 'active',
      progress: 0,
      length: 0,
      downloaded: 0,
      files: h.files,
      selection: sel,
      doneFiles: h.doneFiles,
      dest: h.path
    }
    this.history = this.history.filter(x => x.id !== id)
    this._saveHistory()
    this.entries.set(entry.id, entry)
    this._save()
    this._start(entry)
    return this._view(entry)
  }

  clearHistory (id) {
    const removed = id ? this.history.filter(h => h.id === id) : this.history
    for (const h of removed) {
      if (h.canAddMore) fs.rmSync(path.join(config.torrentFilesDir, `${h.id}.torrent`), { force: true })
    }
    this.history = id ? this.history.filter(h => h.id !== id) : []
    this._saveHistory()
  }

  // ---------- views ----------

  _view (entry) {
    const t = this.running.get(entry.id)
    const v = {
      id: entry.id,
      infoHash: entry.infoHash,
      name: entry.name,
      addedAt: entry.addedAt,
      status: entry.status,
      error: entry.error || null,
      progress: entry.progress || 0,
      length: entry.length || 0,
      downloaded: entry.downloaded || 0,
      downloadSpeed: 0,
      uploadSpeed: 0,
      peers: 0,
      timeRemaining: null,
      files: entry.files ? entry.files.length : null,
      selectedFiles: entry.selection ? entry.selection.length : null
    }
    if (entry.finishing) v.status = 'finishing'
    if (t && !t.destroyed) {
      v.peers = t.numPeers
      v.downloadSpeed = t.downloadSpeed
      v.uploadSpeed = t.uploadSpeed
      if (!t.ready) {
        v.status = 'metadata'
      } else {
        v.name = t.name
        const p = this._progressOf(entry, t)
        Object.assign(v, p)
        if (v.status === 'select') {
          v.length = t.length
          v.downloadSpeed = 0
        } else if (v.downloadSpeed > 0) {
          v.timeRemaining = Math.max(0, (p.length - p.downloaded) / v.downloadSpeed * 1000)
        }
        if (v.status === 'active') v.status = 'downloading'
      }
    }
    return v
  }

  list () {
    return {
      torrents: [...this.entries.values()].sort((a, b) => b.addedAt - a.addedAt).map(e => this._view(e)),
      history: this.history.slice(0, HISTORY_LIMIT),
      totals: {
        downloadSpeed: this.client.downloadSpeed,
        uploadSpeed: this.client.uploadSpeed
      },
      settings: this.getSettings()
    }
  }

  async shutdown () {
    clearInterval(this._saveTimer)
    this._snapshotAndSave()
    await new Promise(resolve => this.client.destroy(() => resolve()))
  }
}

function normalizeSelection (indices, count) {
  if (!Array.isArray(indices)) throw new TorrentError('Нужен список файлов', 400)
  const out = new Set()
  for (const x of indices) {
    const i = Number(x)
    if (!Number.isInteger(i) || i < 0 || i >= count) throw new TorrentError('Некорректный номер файла', 400)
    out.add(i)
  }
  return [...out].sort((a, b) => a - b)
}

/** Move a file into place, creating folders; replaces an existing file with the same name. */
async function moveInto (src, dst) {
  await fsp.mkdir(path.dirname(dst), { recursive: true })
  try {
    await fsp.rename(src, dst)
  } catch (err) {
    if (err.code === 'ENOENT') return // zero-length files are never written
    if (err.code !== 'EXDEV') throw err
    await fsp.cp(src, dst, { recursive: true })
    await fsp.rm(src, { recursive: true, force: true })
  }
}

function describeParseError (buf, err) {
  if (buf) {
    const head = buf.subarray(0, 1024).toString('latin1').trimStart()
    if (head.startsWith('<') || /<html|<!doctype/i.test(head)) {
      return 'Это не .torrent, а веб-страница (сайт, скорее всего, требует вход). Скачайте .torrent в браузере и перетащите файл сюда.'
    }
    if (buf.includes('9:file tree') && !buf.includes('6:pieces')) {
      return 'Торрент в формате BitTorrent v2 — этот формат движок не поддерживает. Попробуйте magnet-ссылку или другую раздачу.'
    }
    if (buf[0] !== 0x64 /* 'd' */) return 'Файл не похож на .torrent'
  }
  return `Не удалось разобрать торрент: ${err.message}`
}

async function fetchTorrentFile (url) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 20000)
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' })
    if (!res.ok) throw new TorrentError(`Не удалось скачать .torrent: HTTP ${res.status}`)
    const chunks = []
    let size = 0
    for await (const chunk of res.body) {
      size += chunk.length
      if (size > MAX_TORRENT_FILE) throw new TorrentError('.torrent-файл слишком большой')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  } catch (err) {
    if (err instanceof TorrentError) throw err
    throw new TorrentError('Не удалось скачать .torrent по ссылке')
  } finally {
    clearTimeout(timer)
  }
}
