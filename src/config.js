import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'

const env = process.env

function int (name, def) {
  const v = env[name]
  if (v === undefined || v === '') return def
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`)
  return n
}

const dataDir = path.resolve(env.DATA_DIR || './data')
const downloadsDir = path.resolve(env.DOWNLOADS_DIR || './downloads')

fs.mkdirSync(dataDir, { recursive: true })
fs.mkdirSync(downloadsDir, { recursive: true })

// Secret for signing share links. Persisted so links survive restarts.
function loadSecret () {
  if (env.LINK_SECRET) return env.LINK_SECRET
  const file = path.join(dataDir, 'secret.key')
  try {
    return fs.readFileSync(file, 'utf8').trim()
  } catch {
    const s = crypto.randomBytes(32).toString('hex')
    fs.writeFileSync(file, s, { mode: 0o600 })
    return s
  }
}

export const config = {
  host: env.HOST || '127.0.0.1',
  port: int('PORT', 3000),
  dataDir,
  downloadsDir,
  // Lives inside downloadsDir so finished torrents can be moved with a cheap rename (same mount).
  incompleteDir: path.join(downloadsDir, '.incomplete'),
  torrentFilesDir: path.join(dataDir, 'torrents'),
  username: env.AUTH_USERNAME || 'admin',
  password: env.AUTH_PASSWORD || '',
  passwordHash: env.AUTH_PASSWORD_HASH || '',
  sessionDays: int('SESSION_DAYS', 30),
  // "true" when the app is only reachable over HTTPS (behind Caddy) — cookies get the Secure flag.
  secureCookies: (env.SECURE_COOKIES || 'auto').toLowerCase(),
  torrentPort: int('TORRENT_PORT', 51413),
  // KB/s, -1 = unlimited
  uploadLimitKB: int('UPLOAD_LIMIT_KBPS', -1),
  downloadLimitKB: int('DOWNLOAD_LIMIT_KBPS', -1),
  maxConns: int('MAX_CONNS', 100),
  linkSecret: loadSecret()
}

fs.mkdirSync(config.incompleteDir, { recursive: true })
fs.mkdirSync(config.torrentFilesDir, { recursive: true })
