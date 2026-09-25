import path from 'node:path'
import fsp from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { ZipArchive } from 'archiver'
import { config } from './config.js'
import {
  checkCredentials, createSession, destroySession, isAuthenticated,
  loginLockedFor, recordLoginFailure, clearLoginFailures, signLink, verifyLink
} from './auth.js'
import { listDir, remove, resolveSafe, diskUsage, toRel, PathError } from './files.js'
import { TorrentManager, TorrentError } from './torrents.js'

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')
const manager = new TorrentManager()
const app = express()

app.disable('x-powered-by')
// Caddy runs on the same host and sets X-Forwarded-For / X-Forwarded-Proto.
app.set('trust proxy', 'loopback')

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; media-src 'self' blob:; style-src 'self'; script-src 'self'; " +
    "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
  next()
})

// CSRF: every state-changing request must carry a custom header. Browsers cannot send it
// cross-origin without a CORS preflight, which this server never approves.
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next()
  if (req.get('X-Requested-With') !== 'web-torrent') return res.status(403).json({ error: 'Forbidden' })
  next()
})

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

// ---------- public routes ----------

app.get('/login', (req, res) => {
  if (isAuthenticated(req)) return res.redirect('/')
  res.sendFile(path.join(publicDir, 'login.html'))
})
for (const f of ['style.css', 'login.js', 'favicon.svg']) {
  app.get('/' + f, (req, res) => res.sendFile(path.join(publicDir, f)))
}

app.post('/api/login', express.json({ limit: '4kb' }), wrap(async (req, res) => {
  const ip = req.ip
  const locked = loginLockedFor(ip)
  if (locked) {
    return res.status(429).json({ error: `Слишком много попыток. Попробуйте через ${Math.ceil(locked / 60000)} мин.` })
  }
  const { username, password } = req.body || {}
  // Constant-ish delay to slow down guessing.
  await new Promise(resolve => setTimeout(resolve, 400))
  if (!checkCredentials(username, password)) {
    recordLoginFailure(ip)
    console.warn(`[auth] failed login from ${ip}`)
    return res.status(401).json({ error: 'Неверный логин или пароль' })
  }
  clearLoginFailures(ip)
  createSession(req, res)
  res.json({ ok: true })
}))

// Signed share links: usable from VLC / wget / a TV without a login cookie.
app.get('/s/:token/:name', wrap(async (req, res) => {
  const rel = verifyLink(req.params.token)
  if (rel === null) return res.status(404).send('Link expired or invalid')
  await sendPath(req, res, rel, { inline: true })
}))

// ---------- everything below requires login ----------

app.use((req, res, next) => {
  if (isAuthenticated(req)) return next()
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' })
  res.redirect('/login')
})

app.post('/api/logout', (req, res) => {
  destroySession(req, res)
  res.json({ ok: true })
})

app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')))
app.get('/app.js', (req, res) => res.sendFile(path.join(publicDir, 'app.js')))

// ----- torrents -----

app.get('/api/torrents', (req, res) => res.json(manager.list()))

app.post('/api/torrents',
  express.json({ limit: '64kb' }),
  express.raw({ type: 'application/x-bittorrent', limit: '10mb' }),
  wrap(async (req, res) => {
    const input = Buffer.isBuffer(req.body) ? { torrentFile: req.body } : { magnet: req.body?.magnet }
    res.status(201).json(await manager.add(input))
  }))

app.post('/api/torrents/:id/pause', wrap(async (req, res) => res.json(await manager.pause(req.params.id))))
app.post('/api/torrents/:id/resume', (req, res) => res.json(manager.resume(req.params.id)))
app.delete('/api/torrents/:id', wrap(async (req, res) => res.json(await manager.remove(req.params.id))))

app.get('/api/settings', (req, res) => res.json(manager.getSettings()))
app.put('/api/settings', express.json({ limit: '4kb' }), (req, res) => res.json(manager.setSettings(req.body || {})))

app.delete('/api/history/:id', (req, res) => { manager.clearHistory(req.params.id); res.json({ ok: true }) })
app.delete('/api/history', (req, res) => { manager.clearHistory(); res.json({ ok: true }) })

// ----- files -----

app.get('/api/files', wrap(async (req, res) => res.json(await listDir(String(req.query.path || '')))))

app.delete('/api/files', wrap(async (req, res) => {
  await remove(String(req.query.path || ''))
  res.json({ ok: true })
}))

app.get('/api/disk', wrap(async (req, res) => res.json(await diskUsage())))

app.get('/api/download', wrap(async (req, res) => {
  await sendPath(req, res, String(req.query.path || ''), { inline: false })
}))

app.get('/api/stream', wrap(async (req, res) => {
  await sendPath(req, res, String(req.query.path || ''), { inline: true })
}))

app.post('/api/share', express.json({ limit: '8kb' }), wrap(async (req, res) => {
  const abs = await resolveSafe(String(req.body?.path || ''))
  const hours = Math.min(Math.max(Number(req.body?.hours) || 24, 1), 24 * 30)
  const rel = toRel(abs)
  if (!rel) throw new PathError('Bad path')
  const st = await fsp.stat(abs)
  const name = path.basename(abs) + (st.isDirectory() ? '.zip' : '')
  const token = signLink(rel, hours * 3600)
  res.json({ url: `/s/${token}/${encodeURIComponent(name)}`, expiresAt: Date.now() + hours * 3600 * 1000 })
}))

async function sendPath (req, res, rel, { inline }) {
  const abs = await resolveSafe(rel)
  const st = await fsp.stat(abs)
  if (st.isDirectory()) {
    const name = (toRel(abs) ? path.basename(abs) : 'downloads') + '.zip'
    res.attachment(name)
    res.setHeader('Content-Type', 'application/zip')
    // Store-only: media is already compressed, and this keeps CPU usage near zero.
    const archive = new ZipArchive({ store: true })
    archive.on('error', err => { console.error('[zip]', err.message); res.destroy(err) })
    req.on('close', () => { if (!res.writableEnded) archive.abort() })
    archive.pipe(res)
    archive.directory(abs, path.basename(abs))
    await archive.finalize()
    return
  }
  if (!st.isFile()) throw new PathError('Not a file')
  if (inline) {
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`)
  } else {
    res.attachment(path.basename(abs))
  }
  await new Promise((resolve, reject) => {
    res.sendFile(abs, { dotfiles: 'allow', acceptRanges: true, cacheControl: false }, err => {
      if (err && !res.headersSent) reject(err)
      else resolve()
    })
  })
}

// ---------- errors ----------

app.use((req, res) => res.status(404).json({ error: 'Not found' }))

app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500
  if (status >= 500 && !(err instanceof PathError) && !(err instanceof TorrentError)) console.error(err)
  if (res.headersSent) return res.destroy()
  res.status(status).json({ error: status >= 500 ? 'Внутренняя ошибка сервера' : err.message })
})

const server = app.listen(config.port, config.host, () => {
  console.log(`web-torrent listening on http://${config.host}:${config.port}`)
  console.log(`downloads: ${config.downloadsDir}`)
})

let shuttingDown = false
async function shutdown () {
  if (shuttingDown) return
  shuttingDown = true
  console.log('shutting down...')
  server.close()
  await manager.shutdown().catch(() => {})
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
