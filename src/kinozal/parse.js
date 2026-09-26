// Parsers for Kinozal HTML. Written to be lenient: the markup is matched by
// meaning (links to details.php, size-looking cells, seed/peer classes) rather
// than exact positions, so small layout changes don't break it.
import * as cheerio from 'cheerio'

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
  else if (/\b(DVDRip|SATRip|TVRip|DVD5|DVD9|480p|576p)\b/i.test(rest)) resolution = 480

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

function looksGold ($, el) {
  let gold = false
  $(el).find('img, span, a, div, i').each((_, e) => {
    const s = [e.attribs?.src, e.attribs?.class, e.attribs?.title, e.attribs?.alt].filter(Boolean).join(' ')
    if (/gold|золот/i.test(s)) gold = true
  })
  const cls = $(el).attr('class') || ''
  return gold || /gold/i.test(cls)
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
    seen.add(id)
    releases.push({
      id,
      name,
      size,
      seeds: seedsCell.length ? int(seedsCell.text()) : 0,
      peers: peersCell.length ? int(peersCell.text()) : 0,
      date,
      gold: looksGold($, tr),
      ...parseName(name)
    })
  })
  return releases
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

/** DDoS-Guard / Cloudflare style "checking your browser" pages. */
export function isChallenge (status, html, headers = {}) {
  const server = String(headers.server || '').toLowerCase()
  if (server.includes('ddos-guard') && (status === 403 || status === 503)) return true
  const head = String(html).slice(0, 20000)
  return /ddos-guard|checking your browser|проверка браузера|проверяем ваш браузер|cf-browser-verification|challenge-platform|__ddg/i.test(head) &&
    !/details\.php\?id=|logout\.php|takelogin\.php/i.test(head)
}
