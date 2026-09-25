import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import WebTorrent from 'webtorrent'
import parseTorrent from 'parse-torrent'
import { config } from './config.js'
import { uniqueName, toRel } from './files.js'

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
      uploadLimit: config.uploadLimitKB >= 0 ? config.uploadLimitKB * 1024 : -1,
      downloadLimit: config.downloadLimitKB >= 0 ? config.downloadLimitKB * 1024 : -1
    })
    this.client.on('error', err => console.error('[webtorrent]', err.message))

    this._load()
    for (const entry of this.entries.values()) {
      if (entry.status === 'active') this._start(entry)
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
      if (e && t.ready) Object.assign(e, { progress: t.progress, length: t.length, downloaded: t.downloaded })
    }
    try { this._save() } catch (err) { console.error('save failed', err.message) }
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
    } catch {
      throw new TorrentError('Не удалось разобрать торрент')
    }
    if (!parsed?.infoHash) throw new TorrentError('Не удалось разобрать торрент')

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
      downloaded: 0
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
    const opts = { path: dir, destroyStoreOnDestroy: false }
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
    torrent.on('done', () => this._finish(entry, torrent).catch(err => {
      console.error(`[finish ${entry.name}]`, err)
      entry.status = 'error'
      entry.error = 'Ошибка при переносе файлов: ' + err.message
      this._save()
    }))
  }

  async _finish (entry, torrent) {
    if (entry.finishing) return
    entry.finishing = true
    const length = torrent.length
    // Stop seeding immediately: drop the torrent from the client, keep the data.
    await new Promise(resolve => torrent.destroy({ destroyStore: false }, () => resolve()))
    this.running.delete(entry.id)

    const dir = path.join(config.incompleteDir, entry.id)
    const moved = []
    for (const name of await fsp.readdir(dir)) {
      const target = uniqueName(config.downloadsDir, name)
      const src = path.join(dir, name)
      const dst = path.join(config.downloadsDir, target)
      try {
        await fsp.rename(src, dst)
      } catch (err) {
        if (err.code !== 'EXDEV') throw err
        await fsp.cp(src, dst, { recursive: true })
        await fsp.rm(src, { recursive: true, force: true })
      }
      moved.push(toRel(fs.realpathSync(dst)))
    }
    await fsp.rm(dir, { recursive: true, force: true })
    await fsp.rm(path.join(config.torrentFilesDir, `${entry.id}.torrent`), { force: true })

    this.entries.delete(entry.id)
    this._save()
    this.history.unshift({
      id: entry.id,
      name: entry.name,
      length,
      addedAt: entry.addedAt,
      completedAt: Date.now(),
      path: moved.length === 1 ? moved[0] : ''
    })
    this._saveHistory()
    console.log(`[done] ${entry.name}`)
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
      if (t.ready) Object.assign(entry, { progress: t.progress, length: t.length, downloaded: t.downloaded })
      this.running.delete(id)
      await new Promise(resolve => t.destroy({ destroyStore: false }, () => resolve()))
    }
    entry.status = 'paused'
    this._save()
    return this._view(entry)
  }

  resume (id) {
    const entry = this._get(id)
    if (this.running.has(id)) return this._view(entry)
    entry.status = 'active'
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

  clearHistory (id) {
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
      files: null
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
        v.progress = t.progress
        v.length = t.length
        v.downloaded = t.downloaded
        v.timeRemaining = Number.isFinite(t.timeRemaining) ? t.timeRemaining : null
        v.files = t.files.length
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
      }
    }
  }

  async shutdown () {
    clearInterval(this._saveTimer)
    this._snapshotAndSave()
    await new Promise(resolve => this.client.destroy(() => resolve()))
  }
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
