// Kinozal client.
// - Mirrors: kinozal.guru / kinozal.me / kinozal.tv, the first one that answers is used.
// - Plain HTTP by default. If the site answers with a browser check, a headless Chromium
//   takes over and performs all requests from inside the page, so cookies and fingerprint
//   match. If the check needs a human ("I'm not a robot" checkbox), the page is exposed
//   to the UI as a live screenshot the user can click on (see screenshot()/click()).
import fs from 'node:fs'
import path from 'node:path'
import { decode, encodeURIComponent1251, formBody1251 } from './cp1251.js'
import { parseSearch, parseDetails, parseInfoHash, isLoggedIn, loginError, isChallenge } from './parse.js'
import { sameMovie } from './score.js'

export const MIRRORS = ['https://kinozal.guru', 'https://kinozal.me', 'https://kinozal.tv']

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const PAGE_INTERVAL = 1000 // between page requests
const ASSET_INTERVAL = 250 // between poster image requests
const CACHE_MS = 10 * 60 * 1000
const DETAILS_CACHE_MS = 6 * 60 * 60 * 1000
const BROWSER_IDLE_MS = 10 * 60 * 1000
const AUTO_PASS_MS = 20000 // how long to wait for a check to pass by itself
const VIEWPORT = { width: 1000, height: 700 }

export class KinozalError extends Error {
  constructor (msg, status = 502, code) {
    super(msg)
    this.status = status
    if (code) this.code = code
  }
}

const captchaError = () => new KinozalError('Kinozal просит подтвердить, что вы не робот', 409, 'CAPTCHA')

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

  async request (url, { method = 'GET', body, contentType, cookies = true } = {}) {
    let current = url
    for (let i = 0; i < 6; i++) {
      const headers = { 'User-Agent': UA, 'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8', Accept: 'text/html,application/xhtml+xml,image/*,*/*;q=0.8' }
      const cookie = cookies ? this.jar.header() : ''
      if (cookie) headers.Cookie = cookie
      if (body) headers['Content-Type'] = contentType
      const res = await fetch(current, { method, body, headers, redirect: 'manual', signal: AbortSignal.timeout(30000) })
      if (cookies) this.jar.store(res.headers.getSetCookie())
      const loc = res.headers.get('location')
      if (res.status >= 300 && res.status < 400 && loc) {
        current = new URL(loc, current).href
        if (res.status === 303 || method === 'POST') { method = 'GET'; body = undefined }
        continue
      }
      return {
        status: res.status,
        url: current,
        server: res.headers.get('server'),
        type: res.headers.get('content-type'),
        buf: Buffer.from(await res.arrayBuffer())
      }
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
    this.challenge = false
  }

  get isOpen () { return !!(this.page && !this.page.isClosed()) }

  async _ensure () {
    this._touch()
    if (this.isOpen) return
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
      viewport: VIEWPORT,
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

  async _pageIsChallenge () {
    const html = await this.page.content().catch(() => '')
    return isChallenge(200, html)
  }

  /**
   * Navigate and wait until the browser check (if any) is passed. If it doesn't pass by itself,
   * try ticking the checkbox once; if that doesn't help either, leave the page open for the
   * user (CAPTCHA error) — they solve it through screenshot()/click().
   */
  async open (url) {
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
    if (await this._waitPass(AUTO_PASS_MS)) return
    await this._tryTick()
    if (await this._waitPass(8000)) return
    this.challenge = true
    throw captchaError()
  }

  async _waitPass (ms) {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (!await this._pageIsChallenge()) {
        this.challenge = false
        await this._saveState()
        return true
      }
      await this.page.waitForTimeout(1000)
    }
    return false
  }

  // Best effort: click a visible checkbox, including inside challenge iframes.
  async _tryTick () {
    for (const frame of this.page.frames()) {
      const box = frame.locator('input[type=checkbox], [role=checkbox], label:has(input[type=checkbox])').first()
      try {
        if (await box.isVisible({ timeout: 500 })) {
          await box.click({ timeout: 2000 })
          return
        }
      } catch {}
    }
  }

  async _saveState () {
    const state = await this.context.storageState()
    fs.writeFileSync(this.statePath, JSON.stringify(state), { mode: 0o600 })
    for (const c of state.cookies) this.jar.cookies.set(c.name, c.value)
  }

  async request (url, { method = 'GET', body, contentType } = {}, retried = false) {
    await this._ensure()
    if (this.challenge) {
      if (await this._pageIsChallenge()) throw captchaError()
      this.challenge = false
    }
    const pageOrigin = new URL(this.page.url()).origin
    let res
    if (new URL(url).origin === pageOrigin) {
      res = await this.page.evaluate(async ({ url, method, body, contentType }) => {
        const r = await fetch(url, { method, body, headers: body ? { 'Content-Type': contentType } : {}, credentials: 'include' })
        const bytes = new Uint8Array(await r.arrayBuffer())
        let s = ''
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
        return { status: r.status, url: r.url, server: r.headers.get('server'), type: r.headers.get('content-type'), b64: btoa(s) }
      }, { url, method, body, contentType })
      res.buf = Buffer.from(res.b64, 'base64')
      delete res.b64
    } else {
      // Other subdomain (e.g. dl.): cross-origin fetch would be blocked by CORS, use the context's HTTP client.
      const r = await this.context.request.fetch(url, { method, data: body, headers: body ? { 'Content-Type': contentType } : {}, maxRedirects: 5, timeout: 30000 })
      res = { status: r.status(), url: r.url(), server: r.headers().server, type: r.headers()['content-type'], buf: await r.body() }
    }
    const isHtml = !res.type || /html/i.test(res.type)
    if (!retried && isHtml && isChallenge(res.status, decode(res.buf), { server: res.server })) {
      await this.open(new URL(url).origin === pageOrigin && method === 'GET' ? url : this.baseUrl + '/')
      return this.request(url, { method, body, contentType }, true)
    }
    await this._saveState()
    return res
  }

  // ----- remote control for the "I'm not a robot" step -----

  async screenshot () {
    if (!this.isOpen) return null
    this._touch()
    // The page may be closing (e.g. settings were just saved) — no picture is fine then.
    return this.page.screenshot({ type: 'jpeg', quality: 70 }).catch(() => null)
  }

  async click (x, y) {
    if (!this.isOpen) return
    this._touch()
    await this.page.mouse.click(x, y)
  }

  async checkSolved () {
    if (!this.isOpen) return true
    if (await this._pageIsChallenge()) return false
    this.challenge = false
    await this._saveState()
    return true
  }

  async close () {
    clearTimeout(this.idleTimer)
    const b = this.browser
    this.browser = this.context = this.page = null
    this.challenge = false
    if (b) await b.close()
  }
}

// ---------- client ----------

export class KinozalClient {
  constructor ({ dataDir, mirrors = MIRRORS }) {
    this.mirrors = mirrors
    this.stateFile = path.join(dataDir, 'kinozal.json')
    this.debugDir = path.join(dataDir, 'kinozal-debug')
    this.posterDir = path.join(dataDir, 'kinozal-posters')
    this.browserStateFile = path.join(dataDir, 'kinozal-browser.json')
    this.chromium = findChromium()
    this.state = { mirror: 'auto', baseUrl: mirrors[0], username: '', password: '', cookies: {}, mode: 'fetch', loggedIn: false }
    try { Object.assign(this.state, JSON.parse(fs.readFileSync(this.stateFile, 'utf8'))) } catch {}
    this.jar = new CookieJar(this.state.cookies)
    this.tasks = []
    this.seq = 0
    this.pumping = false
    this.lastRequest = 0
    this.cache = new Map()
    this.detailsCache = new Map()
    this._resetTransports()
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
      mirror: s.mirror,
      mirrors: this.mirrors,
      baseUrl: s.baseUrl,
      username: s.username,
      hasPassword: !!s.password,
      hasCookies: !!(this.jar.cookies.get('uid') && this.jar.cookies.get('pass')),
      configured: !!(s.password || this.jar.cookies.get('pass')),
      loggedIn: s.loggedIn,
      mode: s.mode,
      browserAvailable: !!this.chromium,
      captcha: !!this.browserTransport?.challenge
    }
  }

  // ----- mirrors -----

  _mirrorCandidates () {
    if (this.state.mirror !== 'auto') return [this.state.mirror]
    // Last working mirror first, then the rest in the default order.
    return [...new Set([this.state.baseUrl, ...this.mirrors])].filter(m => this.mirrors.includes(m))
  }

  /** Pick the first mirror that answers at all (a browser check page counts as alive). */
  async _pickMirror (exclude) {
    const errors = []
    for (const base of this._mirrorCandidates()) {
      if (base === exclude) continue
      try {
        await fetch(base + '/', { headers: { 'User-Agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(10000) })
        if (base !== this.state.baseUrl) {
          console.log(`[kinozal] using mirror ${base}`)
          this.state.baseUrl = base
          this.state.loggedIn = false
          this._resetTransports()
          this._save()
        }
        return base
      } catch (err) {
        errors.push(`${new URL(base).host}: ${err.cause?.code || err.name}`)
      }
    }
    throw new KinozalError(`Ни одно зеркало Kinozal не отвечает (${errors.join(', ')})`)
  }

  async configure ({ mirror, username, password, cookies }) {
    if (mirror !== undefined) {
      if (mirror !== 'auto' && !this.mirrors.includes(mirror)) throw new KinozalError('Неизвестное зеркало', 400)
      this.state.mirror = mirror
      if (mirror !== 'auto') this.state.baseUrl = mirror
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
    await this._pickMirror()
    await this.ensureLogin(true)
    return this.status()
  }

  async logout () {
    this.state = { mirror: this.state.mirror, baseUrl: this.state.baseUrl, username: '', password: '', cookies: {}, mode: 'fetch', loggedIn: false }
    this.jar.cookies.clear()
    this.cache.clear()
    fs.rmSync(this.browserStateFile, { force: true })
    this._resetTransports()
    this._save()
    return this.status()
  }

  // ----- request queue -----
  // Requests are serialized and spaced out so the site doesn't see a flood.
  // Page requests (priority 1) go before background poster loads (priority 0).

  _request (pathOrUrl, opts = {}) {
    return new Promise((resolve, reject) => {
      this.tasks.push({ pathOrUrl, opts, resolve, reject, priority: opts.priority ?? 1, seq: this.seq++ })
      this._pump()
    })
  }

  async _pump () {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.tasks.length) {
        this.tasks.sort((a, b) => b.priority - a.priority || a.seq - b.seq)
        const task = this.tasks.shift()
        const interval = task.opts.asset ? ASSET_INTERVAL : PAGE_INTERVAL
        const wait = this.lastRequest + interval - Date.now()
        if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
        try {
          task.resolve(await this._doRequest(task.pathOrUrl, task.opts))
        } catch (err) {
          task.reject(err)
        } finally {
          this.lastRequest = Date.now()
        }
      }
    } finally {
      this.pumping = false
    }
  }

  async _doRequest (pathOrUrl, opts, retried = false) {
    const url = typeof pathOrUrl === 'function' ? pathOrUrl(this.state.baseUrl) : new URL(pathOrUrl, this.state.baseUrl).href
    let res
    try {
      res = await this._transportRequest(url, opts)
    } catch (err) {
      // Network failure: the mirror may be down or blocked — try another one (once).
      if (!(err instanceof KinozalError) && !retried && this.state.mirror === 'auto') {
        const before = this.state.baseUrl
        await this._pickMirror(before)
        if (this.state.baseUrl !== before) {
          this.state.loggedIn = false
          return this._doRequest(pathOrUrl, opts, true)
        }
      }
      if (err instanceof KinozalError) throw err
      throw new KinozalError(`Kinozal недоступен: ${err.cause?.code || err.message}`)
    }
    this._save()
    return { ...res, html: decode(res.buf) }
  }

  async _transportRequest (url, opts) {
    if (this.state.mode === 'browser' && this.browserTransport) {
      return this.browserTransport.request(url, opts)
    }
    const res = await this.fetchTransport.request(url, opts)
    const isHtml = !res.type || /html/i.test(res.type)
    if (isHtml && isChallenge(res.status, decode(res.buf), { server: res.server })) {
      if (!this.browserTransport) {
        throw new KinozalError('Сайт требует проверку браузера, а Chromium на сервере не найден. Используйте вход через cookie или образ Docker с Chromium.')
      }
      console.log('[kinozal] browser check detected, switching to headless Chromium')
      this.state.mode = 'browser'
      this._save()
      return this.browserTransport.request(url, opts)
    }
    return res
  }

  // ----- remote browser for the captcha step -----

  async captchaScreenshot () {
    return this.browserTransport ? this.browserTransport.screenshot() : null
  }

  async captchaClick (x, y) {
    const nx = Math.round(Number(x))
    const ny = Math.round(Number(y))
    if (!Number.isFinite(nx) || !Number.isFinite(ny) || nx < 0 || ny < 0 || nx > VIEWPORT.width || ny > VIEWPORT.height) {
      throw new KinozalError('Bad coordinates', 400)
    }
    await this.browserTransport?.click(nx, ny)
  }

  async captchaSolved () {
    return this.browserTransport ? this.browserTransport.checkSolved() : true
  }

  get viewport () { return VIEWPORT }

  // ----- login -----

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
      throw new KinozalError('Cookie устарели — вставьте новые или укажите пароль', 422)
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
      throw new KinozalError(loginError(home.html) || 'Не удалось войти на Kinozal: проверьте логин и пароль', 422)
    }
    this._setLoggedIn(true)
  }

  _setLoggedIn (v) {
    this.state.loggedIn = v
    this._save()
  }

  /** GET a page that requires login; re-login once if the session expired. */
  async _page (p, opts) {
    await this.ensureLogin()
    let res = await this._request(p, opts)
    if (!isLoggedIn(res.html)) {
      this.state.loggedIn = false
      await this.ensureLogin()
      res = await this._request(p, opts)
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

  // ----- search -----

  async search (query, page = 0) {
    const q = String(query).trim()
    if (!q) throw new KinozalError('Пустой запрос', 400)
    const key = `s:${q}:${page}`
    const hit = this.cache.get(key)
    if (hit && hit.at > Date.now() - CACHE_MS) return hit.data
    // t=1: sort by seeders, like the site's own search form
    const res = await this._page(`/browse.php?s=${encodeURIComponent1251(q)}&g=0&c=0&v=0&d=0&w=0&t=1&f=0&page=${page}`)
    const releases = parseSearch(res.html)
    if (!releases.length && !/не найден|ничего не найдено|нет раздач|Найдено 0/i.test(res.html)) this._dump('search', res.html)
    this.cache.set(key, { at: Date.now(), data: releases })
    return releases
  }

  /**
   * All releases of one movie. Uses the site's own "similar releases" query from the details
   * page when available, plus a search by title; keeps releases of the same movie and year.
   */
  async releasesForMovie (movie, similarQuery) {
    const byId = new Map()
    const queries = [...new Set([similarQuery, movie.title, ...(movie.altTitles || []).slice(0, 1)].filter(Boolean))]
    for (const q of queries) {
      for (let page = 0; page < 2; page++) {
        const list = await this.search(q, page)
        for (const r of list) if (sameMovie(r, movie)) byId.set(r.id, r)
        if (list.length < 50) break
      }
    }
    return [...byId.values()]
  }

  async details (id, { priority = 1 } = {}) {
    if (!/^\d+$/.test(String(id))) throw new KinozalError('Bad id', 400)
    const hit = this.detailsCache.get(id)
    if (hit && hit.at > Date.now() - DETAILS_CACHE_MS) return hit.data
    const res = await this._page(`/details.php?id=${id}`, { priority })
    const data = parseDetails(res.html, this.state.baseUrl)
    if (!data.name) this._dump('details', res.html)
    this.detailsCache.set(id, { at: Date.now(), data })
    return data
  }

  /** Poster image for a release, cached on disk. Returns { buf, type } or null. */
  async poster (id) {
    if (!/^\d+$/.test(String(id))) throw new KinozalError('Bad id', 400)
    const file = path.join(this.posterDir, `${id}.img`)
    try {
      const buf = fs.readFileSync(file)
      return { buf, type: sniffImage(buf) }
    } catch {}
    const d = await this.details(id, { priority: 0 })
    if (!d.poster) return null
    const siteHost = new URL(this.state.baseUrl).hostname
    const res = new URL(d.poster).hostname === siteHost
      ? await this._request(d.poster, { priority: 0, asset: true })
      : await this.fetchTransport.request(d.poster, { cookies: false })
    const type = sniffImage(res.buf)
    if (res.status !== 200 || !type) return null
    fs.mkdirSync(this.posterDir, { recursive: true })
    fs.writeFileSync(file, res.buf)
    return { buf: res.buf, type }
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
    const urls = [
      base => { const u = new URL(base); return `${u.protocol}//dl.${u.host}/download.php?id=${id}` },
      base => `${base}/download.php?id=${id}`
    ]
    let lastHtml = ''
    for (const url of urls) {
      try {
        const res = await this._request(url)
        if (res.buf[0] === 0x64 /* 'd' */ && res.buf.includes('4:info')) return res.buf
        lastHtml = res.html
      } catch (err) {
        if (err.code === 'CAPTCHA') throw err
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

function sniffImage (buf) {
  if (!buf || buf.length < 4) return null
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png'
  if (buf.slice(0, 4).toString() === 'GIF8') return 'image/gif'
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp'
  return null
}
