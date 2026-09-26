// Parsers for Kinozal HTML. Written to be lenient: the markup is matched by
// meaning (links to details.php, size-looking cells, seed/peer classes) rather
// than exact positions, so small layout changes don't break it.
import * as cheerio from 'cheerio'
import { decode } from './cp1251.js'

const GB = 1024 ** 3
const UNITS = { б: 1, b: 1, кб: 1024, kb: 1024, мб: 1024 ** 2, mb: 1024 ** 2, гб: GB, gb: GB, тб: 1024 ** 4, tb: 1024 ** 4 }
const SIZE_RE = /^([\d\s.,]+)\s*(тб|гб|мб|кб|б|tb|gb|mb|kb|b)$/i

export function parseSize (text) {
  const m = String(text).trim().match(SIZE_RE)
  if (!m) return null
  const n = parseFloat(m[1].replace(/\s/g, '').replace(',', '.'))
  return Number.isFinite(n) ? Math.round(n * UNITS[m[2].toLowerCase()]) : null
}

const int = s => {
  const n = parseInt(String(s).replace(/\D/g, ''), 10)
  return Number.isFinite(n) ? n : 0
}

// Kinozal translation codes. Cyrillic isn't a "word" char for \b, so use explicit letter boundaries.
const tag = codes => new RegExp(`(?<![\\p{L}])(?:${codes})(?![\\p{L}])`, 'u')
const VOICE_RE = tag('ДБ|ДУБ|ПМ|ПД|ПО|АП|ЛМ|ЛД|ЛО|АО|ЛА')
const SUBS_RE = tag('СТ|Субтитры')
const DUB_RE = tag('ДБ|ДУБ')

/**
 * "Интерстеллар / Interstellar / 2014 / ПМ, СТ / BDRip (1080p)" →
 * { titles: ['Интерстеллар', 'Interstellar'], year: 2014, resolution: 1080, subs: true, ... }
 */
export function parseName (name) {
  const parts = String(name).split(' / ').map(s => s.trim()).filter(Boolean)
  const yearIdx = parts.findIndex(p => /^(19|20)\d{2}(\s*-\s*((19|20)\d{2})?)?$/.test(p))
  const titles = yearIdx > 0 ? parts.slice(0, yearIdx) : parts.slice(0, 1)
  const year = yearIdx >= 0 ? parseInt(parts[yearIdx], 10) : null
  const rest = yearIdx >= 0 ? parts.slice(yearIdx + 1).join(' / ') : parts.slice(1).join(' / ')

  let resolution = null
  if (/2160p|\b4K\b|UHD/i.test(rest)) resolution = 2160
  else if (/1080[pi]/i.test(rest)) resolution = 1080
  else if (/720p/i.test(rest)) resolution = 720
  // Kinozal leaves SD rips without a resolution: "BDRip", "BDRip (AVC)", "DVDRip", "DVD-9"...
  else if (/\b(BDRip|HDRip|WEBRip|WEB-DLRip|DVDRip|SATRip|TVRip|DVD-?5|DVD-?9|480p|576p)\b/i.test(rest)) resolution = 480

  return {
    titles,
    year,
    resolution,
    hdr: /HDR|Dolby Vision|\bDV\b/i.test(rest),
    subs: SUBS_RE.test(rest),
    voice: VOICE_RE.test(rest),
    dub: DUB_RE.test(rest),
    source: (rest.match(/\b(Blu-?Ray Remux|Remux|BDRip|BDRemux|WEB-DLRip|WEB-DL|WEBRip|HDTVRip|HDRip|DVDRip|HDTV|TS|CAMRip)\b/i) || [])[1] || null
  }
}

// Kinozal colours release links by download bonus: r1 = gold ("Золотая раздача": download
// isn't counted), r2 = silver, r0 = normal. Confirmed on a real details page.
function bonusOf (cls = '') {
  const c = ` ${cls} `
  return { gold: / r1 /.test(c), silver: / r2 /.test(c) }
}

// Video sections of the tracker (films, series, cartoons, shows); everything else is
// music, books, games, software.
export const VIDEO_CATEGORIES = new Set([45, 46, 8, 6, 15, 17, 35, 39, 13, 14, 24, 11, 10, 9, 47, 18, 37, 12, 7, 48, 49, 50, 38, 16, 21, 22, 20])

function categoryOf ($, tr) {
  const img = $(tr).find('td.bt img, img[src*="/pic/cat/"]').first()
  const m = (img.attr('onclick') || '').match(/cat\((\d+)\)/) || (img.attr('src') || '').match(/\/pic\/cat\/(\d+)\./)
  return m ? Number(m[1]) : null
}

/** Parse browse.php results. */
export function parseSearch (html) {
  const $ = cheerio.load(html)
  const releases = []
  const seen = new Set()
  $('tr').each((_, tr) => {
    const link = $(tr).find('a[href*="details.php?id="]').first()
    if (!link.length) return
    const id = (link.attr('href').match(/id=(\d+)/) || [])[1]
    if (!id || seen.has(id)) return
    const name = link.text().replace(/\s+/g, ' ').trim()
    if (!name) return

    const cells = $(tr).children('td')
    let size = null
    let date = ''
    cells.each((_, td) => {
      const text = $(td).text().replace(/\s+/g, ' ').trim()
      if (size === null) size = parseSize(text)
      if (!date && /(сегодня|вчера|\d{2}\.\d{2}\.\d{4})/i.test(text)) date = text
    })
    if (size === null) return

    const seedsCell = $(tr).find('td.sl_s')
    const peersCell = $(tr).find('td.sl_p')
    const category = categoryOf($, tr)
    seen.add(id)
    releases.push({
      id,
      name,
      size,
      seeds: seedsCell.length ? int(seedsCell.text()) : 0,
      peers: peersCell.length ? int(peersCell.text()) : 0,
      date,
      category,
      video: category === null || VIDEO_CATEGORIES.has(category),
      ...bonusOf(link.attr('class')),
      ...parseName(name)
    })
  })
  return releases
}

/** details.php: poster, description, genre, ratings and the site's own "similar releases" query. */
export function parseDetails (html, baseUrl) {
  const $ = cheerio.load(html)
  const abs = u => { try { return u ? new URL(u, baseUrl).href : null } catch { return null } }

  const poster = abs($('img.p200').first().attr('src') || $('meta[property="og:image"]').attr('content'))
  let description = null
  $('.bx1 p, .bx1.justify p').each((_, p) => {
    const t = $(p).text().replace(/\s+/g, ' ').trim()
    if (!description && /^О (фильме|сериале|мультфильме|передаче|концерте)\s*:/i.test(t)) description = t.replace(/^[^:]+:\s*/, '')
  })
  if (!description) {
    const d = $('.bx1.justify p').first().text().replace(/\s+/g, ' ').trim()
    description = d || null
  }

  let genre = null
  $('.bx1 h2 b').each((_, b) => {
    if (/^Жанр/i.test($(b).text())) genre = $(b).next('span').text().trim() || null
  })

  const rating = re => {
    const a = $('a').filter((_, el) => re.test($(el).attr('href') || '')).first()
    const v = parseFloat(a.find('.floatright').text().replace(',', '.'))
    return Number.isFinite(v) && v > 0 ? v : null
  }

  let similarQuery = null
  $('a[href*="browse.php?s="]').each((_, a) => {
    if (similarQuery || !/Подобные раздачи/i.test($(a).text())) return
    const raw = ($(a).attr('href').match(/[?&]s=([^&]*)/) || [])[1]
    if (raw) similarQuery = decode(Buffer.from(percentDecodeBytes(raw)))
  })

  const title = $('h1 a').first()
  return {
    name: title.text().trim() || null,
    poster,
    description,
    genre,
    imdb: rating(/imdb\.com/),
    kinopoisk: rating(/kinopoisk\.ru\/film\/\d+\/?$/),
    similarQuery,
    ...bonusOf(title.attr('class'))
  }
}

// "%C8%ED+%2F" → bytes (the site percent-encodes windows-1251)
function percentDecodeBytes (s) {
  const out = []
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '%' && /^[0-9a-f]{2}$/i.test(s.slice(i + 1, i + 3))) { out.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2 } else if (s[i] === '+') out.push(32)
    else out.push(s.charCodeAt(i) & 0xff)
  }
  return out
}

/** Info hash from get_srv_details.php?action=2 or a details page. */
export function parseInfoHash (html) {
  const text = cheerio.load(html).text()
  const m = text.match(/(?:Инфо\s*хеш|Info\s*hash)\s*:?\s*([0-9a-f]{40})/i) || text.match(/\b([0-9a-f]{40})\b/i)
  return m ? m[1].toLowerCase() : null
}

export function isLoggedIn (html) {
  return /logout\.php/i.test(html)
}

export function loginError (html) {
  const $ = cheerio.load(html)
  const red = $('.red, .error, .bx1 .red').first().text().trim()
  return red || null
}

/** Anti-bot pages: DDoS-Guard / Cloudflare "checking your browser", "I'm not a robot" checkboxes. */
export function isChallenge (status, html, headers = {}) {
  const server = String(headers.server || '').toLowerCase()
  const text = String(html)
  // A real Kinozal page always has the site menu with the browse link.
  const isSitePage = /href="\/browse\.php"|takelogin\.php|details\.php\?id=|get_srv_details|Инфо хеш/i.test(text)
  if (isSitePage) return false
  if ((server.includes('ddos-guard') || server.includes('cloudflare')) && (status === 403 || status === 503 || status === 429)) return true
  return /ddos-guard|checking your browser|проверка браузера|проверяем ваш браузер|cf-browser-verification|challenge-platform|cf-turnstile|turnstile|captcha|не робот|just a moment|__ddg/i.test(text.slice(0, 50000))
}
