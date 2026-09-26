// Kinozal client. Plain HTTP by default; if the site answers with a browser check
// (DDoS-Guard), it switches to a headless Chromium that passes the check and then
// performs all requests from inside the page, so cookies and fingerprint match.
import fs from 'node:fs'
import path from 'node:path'
import { decode, encodeURIComponent1251, formBody1251 } from './cp1251.js'
import { parseSearch, parseInfoHash, isLoggedIn, loginError, isChallenge } from './parse.js'
import { sameMovie } from './score.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const MIN_INTERVAL = 1000
const CACHE_MS = 10 * 60 * 1000
const BROWSER_IDLE_MS = 10 * 60 * 1000
const DEFAULT_BASE = 'https://kinozal.guru'

export class KinozalError extends Error {
  constructor (msg, status = 502) {
    super(msg)
    this.status = status
  }
}

function findChromium () {
  const candidates = [process.env.CHROMIUM_PATH, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']
  try {
    for (const d of fs.readdirSync('/opt/pw-browsers')) {
      candidates.push(path.join('/opt/pw-browsers', d, 'chrome-linux', 'chrome'))
    }
  } catch {}
  return candidates.find(p => p && fs.existsSync(p)) || null
}

// ---------- cookie jar ----------

class CookieJar {
  constructor (obj = {}) { this.cookies = new Map(Object.entries(obj)) }
  header () { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') }
  store (setCookies) {
    for (const sc of setCookies) {
      const [pair, ...attrs] = sc.split(';')
      const i = pair.indexOf('=')
      if (i < 0) continue
      const name = pair.slice(0, i).trim()
      const value = pair.slice(i + 1).trim()
      const expired = attrs.some(a => /^\s*max-age=\s*(0|-)/i.test(a)) ||
        attrs.some(a => { const m = a.match(/^\s*expires=(.*)$/i); return m && Date.parse(m[1]) < Date.now() })
      if (expired || value === 'deleted') this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
  }
  toJSON () { return Object.fromEntries(this.cookies) }
}

/** "uid=1; pass=abc" or "uid=1\npass=abc" → { uid: '1', pass: 'abc' } */
export function parseCookieString (s) {
  const out = {}
  for (const part of String(s).split(/[;\n]/)) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim()
  }
  return out
}

// ---------- transports ----------

class FetchTransport {
  constructor (jar) { this.jar = jar }

  async request (url, { method = 'GET', body, contentType } = {}) {
    let current = url
    for (let i = 0; i < 6; i++) {
      const headers = { 'User-Agent': UA, 'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8', Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' }
      const cookie = this.jar.header()
      if (cookie) headers.Cookie = cookie
      if (body) headers['Content-Type'] = contentType
      const res = await fetch(current, { method, body, headers, redirect: 'manual', signal: AbortSignal.timeout(30000) })
      this.jar.store(res.headers.getSetCookie())
      const loc = res.headers.get('location')
      if (res.status >= 300 && res.status < 400 && loc) {
        current = new URL(loc, current).href
        if (res.status === 303 || method === 'POST') { method = 'GET'; body = undefined }
        continue
      }
      return { status: res.status, url: current, server: res.headers.get('server'), buf: Buffer.from(await res.arrayBuffer()) }
    }
    throw new KinozalError('Слишком много перенаправлений')
  }

  async close () {}
}

class BrowserTransport {
  constructor ({ jar, executablePath, statePath, baseUrl }) {
    Object.assign(this, { jar, executablePath, statePath, baseUrl })
    this.browser = null
    this.context = null
    this.page = null
    this.idleTimer = null
  }

  async _ensure () {
    this._touch()
    if (this.page && !this.page.isClosed()) return
    const { chromium } = await import('playwright-core')
    this.browser = await chromium.launch({
      executablePath: this.executablePath,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled']
    })
    const major = this.browser.version().split('.')[0]
    let storageState
    try { storageState = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) } catch {}
    this.context = await this.browser.newContext({
      userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
      locale: 'ru-RU',
      storageState
    })
    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    })
    // Carry over cookies we already have (e.g. uid/pass pasted by the user).
    const host = new URL(this.baseUrl).hostname
    const cookies = [...this.jar.cookies].map(([name, value]) => ({ name, value, domain: '.' + host, path: '/' }))
    if (cookies.length) await this.context.addCookies(cookies)
    this.page = await this.context.newPage()
    await this.open(this.baseUrl + '/')
  }

  _touch () {
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.close().catch(() => {}), BROWSER_IDLE_MS)
    this.idleTimer.unref()
  }

  /** Navigate and wait until the browser check (if any) is passed. */
  async open (url) {
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
    const deadline = Date.now() + 45000
    while (Date.now() < deadline) {
      const html = await this.page.content().catch(() => '')
      if (!isChallenge(200, html)) {
        await this._saveState()
        return
      }
      await this.page.waitForTimeout(1000)
    }
    throw new KinozalError('Не удалось пройти проверку браузера на сайте. Попробуйте вход через cookie.')
  }

  async _saveState () {
    const state = await this.context.storageState()
    fs.writeFileSync(this.statePath, JSON.stringify(state), { mode: 0o600 })
    for (const c of state.cookies) this.jar.cookies.set(c.name, c.value)
  }

  async request (url, { method = 'GET', body, contentType } = {}, retried = false) {
    await this._ensure()
    const pageOrigin = new URL(this.page.url()).origin
    let res
    if (new URL(url).origin === pageOrigin) {
      res = await this.page.evaluate(async ({ url, method, body, contentType }) => {
        const r = await fetch(url, { method, body, headers: body ? { 'Content-Type': contentType } : {}, credentials: 'include' })
        const bytes = new Uint8Array(await r.arrayBuffer())
        let s = ''
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
        return { status: r.status, url: r.url, server: r.headers.get('server'), b64: btoa(s) }
      }, { url, method, body, contentType })
      res.buf = Buffer.from(res.b64, 'base64')
      delete res.b64
    } else {
      // Other subdomain (e.g. dl.): cross-origin fetch would be blocked by CORS, use the context's HTTP client.
      const r = await this.context.request.fetch(url, { method, data: body, headers: body ? { 'Content-Type': contentType } : {}, maxRedirects: 5, timeout: 30000 })
      res = { status: r.status(), url: r.url(), server: r.headers().server, buf: await r.body() }
    }
    if (!retried && isChallenge(res.status, decode(res.buf), { server: res.server })) {
      await this.open(url.includes('download.php') ? this.baseUrl + '/' : url)
      return this.request(url, { method, body, contentType }, true)
    }
    await this._saveState()
    return res
  }

  async close () {
    clearTimeout(this.idleTimer)
    const b = this.browser
    this.browser = this.context = this.page = null
    if (b) await b.close()
  }
}

// ---------- client ----------

export class KinozalClient {
  constructor ({ dataDir }) {
    this.stateFile = path.join(dataDir, 'kinozal.json')
    this.debugDir = path.join(dataDir, 'kinozal-debug')
    this.browserStateFile = path.join(dataDir, 'kinozal-browser.json')
    this.chromium = findChromium()
    this.state = { baseUrl: DEFAULT_BASE, username: '', password: '', cookies: {}, mode: 'fetch', loggedIn: false }
    try { Object.assign(this.state, JSON.parse(fs.readFileSync(this.stateFile, 'utf8'))) } catch {}
    this.jar = new CookieJar(this.state.cookies)
    this._resetTransports()
    this.queue = Promise.resolve()
    this.lastRequest = 0
    this.cache = new Map()
  }

  _resetTransports () {
    this.browserTransport?.close().catch(() => {})
    this.fetchTransport = new FetchTransport(this.jar)
    this.browserTransport = this.chromium
      ? new BrowserTransport({ jar: this.jar, executablePath: this.chromium, statePath: this.browserStateFile, baseUrl: this.state.baseUrl })
      : null
  }

  _save () {
    this.state.cookies = this.jar.toJSON()
    fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2), { mode: 0o600 })
  }

  status () {
    const s = this.state
    return {
      baseUrl: s.baseUrl,
      username: s.username,
      hasPassword: !!s.password,
      hasCookies: !!(this.jar.cookies.get('uid') && this.jar.cookies.get('pass')),
      configured: !!(s.password || this.jar.cookies.get('pass')),
      loggedIn: s.loggedIn,
      mode: s.mode,
      browserAvailable: !!this.chromium
    }
  }

  async configure ({ baseUrl, username, password, cookies }) {
    if (baseUrl !== undefined) {
      const u = new URL(/^https?:\/\//.test(baseUrl) ? baseUrl : 'https://' + baseUrl)
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new KinozalError('Некорректный адрес', 400)
      this.state.baseUrl = u.origin
    }
    if (username !== undefined) this.state.username = String(username).trim()
    if (password) this.state.password = String(password)
    if (cookies) {
      const parsed = parseCookieString(cookies)
      if (!parsed.uid || !parsed.pass) throw new KinozalError('Нужны оба cookie: uid и pass', 400)
      this.jar.cookies.set('uid', parsed.uid)
      this.jar.cookies.set('pass', parsed.pass)
    }
    this.state.mode = 'fetch'
    this.state.loggedIn = false
    this.cache.clear()
    this._resetTransports()
    this._save()
    await this.ensureLogin(true)
    return this.status()
  }

  async logout () {
    this.state = { baseUrl: this.state.baseUrl, username: '', password: '', cookies: {}, mode: 'fetch', loggedIn: false }
    this.jar.cookies.clear()
    this.cache.clear()
    fs.rmSync(this.browserStateFile, { force: true })
    this._resetTransports()
    this._save()
    return this.status()
  }

  // Requests are serialized and spaced out so the site doesn't see us as a flood.
  _request (pathOrUrl, opts = {}) {
    const run = async () => {
      const wait = this.lastRequest + MIN_INTERVAL - Date.now()
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
      try {
        return await this._doRequest(new URL(pathOrUrl, this.state.baseUrl).href, opts)
      } finally {
        this.lastRequest = Date.now()
      }
    }
    const p = this.queue.then(run, run)
    this.queue = p.catch(() => {})
    return p
  }

  async _doRequest (url, opts) {
    let res
    if (this.state.mode === 'browser' && this.browserTransport) {
      res = await this.browserTransport.request(url, opts)
    } else {
      try {
        res = await this.fetchTransport.request(url, opts)
      } catch (err) {
        if (err instanceof KinozalError) throw err
        throw new KinozalError(`Kinozal недоступен: ${err.cause?.code || err.message}`)
      }
      if (isChallenge(res.status, decode(res.buf), { server: res.server })) {
        if (!this.browserTransport) {
          throw new KinozalError('Сайт требует проверку браузера, а Chromium на сервере не найден. Используйте вход через cookie или образ Docker с Chromium.')
        }
        console.log('[kinozal] browser check detected, switching to headless Chromium')
        this.state.mode = 'browser'
        this._save()
        res = await this.browserTransport.request(url, opts)
      }
    }
    this._save()
    return { ...res, html: decode(res.buf) }
  }

  async ensureLogin (force = false) {
    if (this.state.loggedIn && !force) return
    const cfg = this.status()
    if (!cfg.configured) throw new KinozalError('Kinozal не настроен: укажите логин и пароль в настройках поиска', 400)

    // Existing cookies may already be enough.
    if (this.jar.cookies.get('pass')) {
      const home = await this._request('/')
      if (isLoggedIn(home.html)) return this._setLoggedIn(true)
    }
    if (!this.state.password) {
      this._setLoggedIn(false)
      throw new KinozalError('Cookie устарели — вставьте новые или укажите пароль', 401)
    }
    await this._request('/takelogin.php', {
      method: 'POST',
      body: formBody1251({ username: this.state.username, password: this.state.password, returnto: '' }),
      contentType: 'application/x-www-form-urlencoded'
    })
    const home = await this._request('/')
    if (!isLoggedIn(home.html)) {
      this._setLoggedIn(false)
      this._dump('login', home.html)
      throw new KinozalError(loginError(home.html) || 'Не удалось войти на Kinozal: проверьте логин и пароль', 401)
    }
    this._setLoggedIn(true)
  }

  _setLoggedIn (v) {
    this.state.loggedIn = v
    this._save()
  }

  /** GET a page that requires login; re-login once if the session expired. */
  async _page (p) {
    await this.ensureLogin()
    let res = await this._request(p)
    if (!isLoggedIn(res.html)) {
      this.state.loggedIn = false
      await this.ensureLogin()
      res = await this._request(p)
    }
    return res
  }

  _dump (kind, html) {
    try {
      fs.mkdirSync(this.debugDir, { recursive: true })
      fs.writeFileSync(path.join(this.debugDir, `${kind}-${Date.now()}.html`), html)
      const files = fs.readdirSync(this.debugDir).sort()
      for (const f of files.slice(0, Math.max(0, files.length - 10))) fs.rmSync(path.join(this.debugDir, f))
    } catch {}
  }

  async search (query, page = 0) {
    const q = String(query).trim()
    if (!q) throw new KinozalError('Пустой запрос', 400)
    const key = `s:${q}:${page}`
    const hit = this.cache.get(key)
    if (hit && hit.at > Date.now() - CACHE_MS) return hit.data
    const res = await this._page(`/browse.php?s=${encodeURIComponent1251(q)}&g=0&c=0&v=0&d=0&w=0&t=0&f=0&page=${page}`)
    const releases = parseSearch(res.html)
    if (!releases.length && !/не найден|ничего не найдено|нет раздач/i.test(res.html)) this._dump('search', res.html)
    this.cache.set(key, { at: Date.now(), data: releases })
    return releases
  }

  /** All releases of one movie: search by each of its titles (2 pages), keep matching ones. */
  async releasesForMovie (movie) {
    const byId = new Map()
    const queries = [movie.title, ...(movie.altTitles || []).slice(0, 1)]
    for (const q of queries) {
      for (let page = 0; page < 2; page++) {
        const list = await this.search(q, page)
        for (const r of list) if (sameMovie(r, movie)) byId.set(r.id, r)
        if (list.length < 50) break
      }
    }
    return [...byId.values()]
  }

  async infoHash (id) {
    if (!/^\d+$/.test(String(id))) throw new KinozalError('Bad id', 400)
    const res = await this._page(`/get_srv_details.php?id=${id}&action=2`)
    let hash = parseInfoHash(res.html)
    if (!hash) {
      const details = await this._page(`/details.php?id=${id}`)
      hash = parseInfoHash(details.html)
      if (!hash) this._dump('hash', res.html)
    }
    return hash
  }

  async torrentFile (id) {
    if (!/^\d+$/.test(String(id))) throw new KinozalError('Bad id', 400)
    await this.ensureLogin()
    const base = new URL(this.state.baseUrl)
    const urls = [`${base.protocol}//dl.${base.host}/download.php?id=${id}`, `${base.origin}/download.php?id=${id}`]
    let lastHtml = ''
    for (const url of urls) {
      try {
        const res = await this._request(url)
        if (res.buf[0] === 0x64 /* 'd' */ && res.buf.includes('4:info')) return res.buf
        lastHtml = res.html
      } catch (err) {
        lastHtml = err.message
      }
    }
    this._dump('download', lastHtml)
    if (/лимит|limit/i.test(lastHtml)) throw new KinozalError('Исчерпан дневной лимит скачивания .torrent на Kinozal')
    throw new KinozalError('Не удалось скачать .torrent с Kinozal')
  }

  async close () {
    await this.browserTransport?.close()
  }
}
