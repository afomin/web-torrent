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
import { KinozalClient, KinozalError, MIRRORS } from './kinozal/client.js'
import { groupMovies, rankReleases } from './kinozal/score.js'

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')
const manager = new TorrentManager()
const kinozal = new KinozalClient({
  dataDir: config.dataDir,
  mirrors: process.env.KINOZAL_MIRRORS ? process.env.KINOZAL_MIRRORS.split(',').map(s => s.trim().replace(/\/+$/, '')) : MIRRORS
})
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

// ----- kinozal search -----

app.get('/api/kinozal/status', (req, res) => res.json(kinozal.status()))

app.put('/api/kinozal/config', express.json({ limit: '8kb' }), wrap(async (req, res) => {
  const { mirror, username, password, cookies } = req.body || {}
  res.json(await kinozal.configure({ mirror, username, password, cookies }))
}))

app.post('/api/kinozal/logout', wrap(async (req, res) => res.json(await kinozal.logout())))

app.get('/api/kinozal/search', wrap(async (req, res) => {
  const releases = await kinozal.search(String(req.query.q || ''))
  res.json({ movies: groupMovies(releases) })
}))

app.get('/api/kinozal/movie', wrap(async (req, res) => {
  const title = String(req.query.title || '').trim()
  if (!title) throw new KinozalError('Не указано название', 400)
  const movie = {
    title,
    altTitles: [].concat(req.query.alt || []).map(String).filter(Boolean),
    year: parseInt(req.query.year, 10) || null
  }
  // Details of a known release give the poster/description and the site's "similar releases" query.
  const details = req.query.id ? await kinozal.details(String(req.query.id)).catch(err => {
    if (err.code === 'CAPTCHA') throw err
    return null
  }) : null
  const releases = rankReleases(await kinozal.releasesForMovie(movie, details?.similarQuery))
  res.json({ movie, details, releases })
}))

app.get('/api/kinozal/details/:id', wrap(async (req, res) => res.json(await kinozal.details(req.params.id))))

app.get('/api/kinozal/poster/:id', wrap(async (req, res) => {
  const img = await kinozal.poster(req.params.id).catch(() => null)
  if (!img) return res.status(404).end()
  res.setHeader('Content-Type', img.type)
  res.setHeader('Cache-Control', 'private, max-age=604800')
  res.end(img.buf)
}))

// "I'm not a robot": the server-side browser page is shown to the user as a screenshot,
// their clicks are replayed there.
app.get('/api/kinozal/captcha/screen', wrap(async (req, res) => {
  const shot = await kinozal.captchaScreenshot()
  if (!shot) return res.status(404).end()
  res.setHeader('Content-Type', 'image/jpeg')
  res.setHeader('Cache-Control', 'no-store')
  res.end(shot)
}))

app.get('/api/kinozal/captcha/state', wrap(async (req, res) => {
  res.json({ solved: await kinozal.captchaSolved(), viewport: kinozal.viewport })
}))

app.post('/api/kinozal/captcha/click', express.json({ limit: '1kb' }), wrap(async (req, res) => {
  await kinozal.captchaClick(req.body?.x, req.body?.y)
  await new Promise(resolve => setTimeout(resolve, 1500))
  res.json({ solved: await kinozal.captchaSolved() })
}))

app.post('/api/kinozal/download', express.json({ limit: '8kb' }), wrap(async (req, res) => {
  const { id, name, mode } = req.body || {}
  let hash = null
  if (mode !== 'torrent') hash = await kinozal.infoHash(id)
  let input
  if (hash) {
    input = { magnet: `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(String(name || hash))}` }
  } else {
    input = { torrentFile: await kinozal.torrentFile(id) }
  }
  const t = await manager.add(input)
  res.status(201).json({ ...t, via: hash ? 'magnet' : 'torrent' })
}))

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
  if (err instanceof KinozalError) console.warn('[kinozal]', err.message)
  else if (status >= 500 && !(err instanceof PathError) && !(err instanceof TorrentError)) console.error(err)
  if (res.headersSent) return res.destroy()
  const expose = status < 500 || err instanceof KinozalError
  res.status(status).json({ error: expose ? err.message : 'Внутренняя ошибка сервера', code: expose ? err.code : undefined })
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
  await Promise.all([manager.shutdown(), kinozal.close()]).catch(() => {})
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
