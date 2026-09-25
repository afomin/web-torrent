import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'

const COOKIE = 'wt_session'
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 }

// ---------- password hashing ----------

export function hashPassword (password) {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p })
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${hash.toString('base64')}`
}

function verifyPassword (password, stored) {
  const parts = stored.split('$')
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false
  const N = Number(parts[1])
  const salt = Buffer.from(parts[2], 'base64')
  const expected = Buffer.from(parts[3], 'base64')
  const actual = crypto.scryptSync(password, salt, expected.length, { N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 256 * N * SCRYPT.r })
  return crypto.timingSafeEqual(actual, expected)
}

function safeEqual (a, b) {
  const ha = crypto.createHash('sha256').update(a).digest()
  const hb = crypto.createHash('sha256').update(b).digest()
  return crypto.timingSafeEqual(ha, hb)
}

let passwordHash = config.passwordHash
if (!passwordHash) {
  if (!config.password) {
    console.error('FATAL: set AUTH_PASSWORD or AUTH_PASSWORD_HASH (see .env.example)')
    process.exit(1)
  }
  if (config.password.length < 10) {
    console.warn('WARNING: AUTH_PASSWORD is shorter than 10 characters — use a longer password')
  }
  passwordHash = hashPassword(config.password)
}

export function checkCredentials (username, password) {
  if (typeof username !== 'string' || typeof password !== 'string') return false
  if (password.length > 1024) return false
  const userOk = safeEqual(username, config.username)
  const passOk = verifyPassword(password, passwordHash)
  return userOk && passOk
}

// ---------- sessions (persisted, token hashes only) ----------

const sessionsFile = path.join(config.dataDir, 'sessions.json')
let sessions = new Map() // sha256(token) -> expiresAt

try {
  const raw = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'))
  sessions = new Map(Object.entries(raw))
} catch {}

function saveSessions () {
  const now = Date.now()
  for (const [k, exp] of sessions) if (exp < now) sessions.delete(k)
  fs.writeFileSync(sessionsFile, JSON.stringify(Object.fromEntries(sessions)), { mode: 0o600 })
}

const tokenHash = t => crypto.createHash('sha256').update(t).digest('hex')

function parseCookies (header = '') {
  const out = {}
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

function isSecure (req) {
  if (config.secureCookies === 'true') return true
  if (config.secureCookies === 'false') return false
  return req.secure
}

export function createSession (req, res) {
  const token = crypto.randomBytes(32).toString('base64url')
  const maxAge = config.sessionDays * 24 * 3600
  sessions.set(tokenHash(token), Date.now() + maxAge * 1000)
  saveSessions()
  const attrs = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAge}`]
  if (isSecure(req)) attrs.push('Secure')
  res.setHeader('Set-Cookie', attrs.join('; '))
}

export function destroySession (req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE]
  if (token) {
    sessions.delete(tokenHash(token))
    saveSessions()
  }
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`)
}

export function isAuthenticated (req) {
  const token = parseCookies(req.headers.cookie)[COOKIE]
  if (!token) return false
  const exp = sessions.get(tokenHash(token))
  if (!exp) return false
  if (exp < Date.now()) {
    sessions.delete(tokenHash(token))
    return false
  }
  return true
}

// ---------- brute-force protection ----------

const failures = new Map() // ip -> { count, until }
const MAX_FAILS = 5
const LOCK_MS = 15 * 60 * 1000

export function loginLockedFor (ip) {
  const f = failures.get(ip)
  if (!f || f.until < Date.now()) return 0
  return f.count >= MAX_FAILS ? f.until - Date.now() : 0
}

export function recordLoginFailure (ip) {
  const now = Date.now()
  let f = failures.get(ip)
  if (!f || f.until < now) f = { count: 0, until: now + LOCK_MS }
  f.count++
  f.until = now + LOCK_MS
  failures.set(ip, f)
}

export function clearLoginFailures (ip) {
  failures.delete(ip)
}

// ---------- signed share links (for VLC / wget, no cookie needed) ----------

export function signLink (relPath, ttlSeconds) {
  const payload = Buffer.from(JSON.stringify({ p: relPath, e: Date.now() + ttlSeconds * 1000 })).toString('base64url')
  const sig = crypto.createHmac('sha256', config.linkSecret).update(payload).digest('base64url')
  return `${payload}.${sig}`
}

export function verifyLink (token) {
  if (typeof token !== 'string') return null
  const [payload, sig] = token.split('.')
  if (!payload || !sig) return null
  const expected = crypto.createHmac('sha256', config.linkSecret).update(payload).digest('base64url')
  if (!safeEqual(sig, expected)) return null
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (typeof data.p !== 'string' || typeof data.e !== 'number' || data.e < Date.now()) return null
    return data.p
  } catch {
    return null
  }
}
