// A stand-in for Kinozal that serves real (sanitized) pages saved from kinozal.guru,
// with cookie login and optional anti-bot pages:
//   challenge: 'auto'   — JS check that passes by itself after a moment (DDoS-Guard style)
//   challenge: 'manual' — "I'm not a robot" box that only a real click passes
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decode, encode } from '../../src/kinozal/cp1251.js'

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'kinozal')
const fixture = name => fs.readFileSync(path.join(dir, name))
export const hashFor = id => (String(id) + '0'.repeat(40)).slice(0, 40)
// Smallest valid JPEG header is enough for the image sniffer.
export const POSTER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9])

function decode1251Query (s) {
  const bytes = []
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '%') { bytes.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2 } else if (s[i] === '+') bytes.push(32)
    else bytes.push(s.charCodeAt(i))
  }
  return decode(Buffer.from(bytes))
}
const params = str => Object.fromEntries(String(str).split('&').filter(Boolean).map(p => {
  const [k, v = ''] = p.split('=')
  return [k, decode1251Query(v)]
}))
const cookies = req => Object.fromEntries(String(req.headers.cookie || '').split(';').map(s => s.trim().split('=')).filter(p => p[0]))

const AUTO_CHECK = `<html><body>DDoS-Guard: проверка браузера...<script>
  setTimeout(() => { document.cookie = 'bot_ok=1; path=/'; location.reload() }, 300)</script></body></html>`
// No <input>: the box is a plain div at a known spot, so only a real click at (500, 300) passes.
const MANUAL_CHECK = `<html><body style="margin:0">
  <div style="position:absolute;left:0;top:0;width:1000px;text-align:center">Подтвердите, что вы не робот</div>
  <div id="box" style="position:absolute;left:480px;top:280px;width:40px;height:40px;border:2px solid #333"></div>
  <script>document.getElementById('box').addEventListener('click', () => {
    document.cookie = 'bot_ok=1; path=/'; location.reload() })</script></body></html>`

export function startFakeKinozal ({ challenge = false } = {}) {
  const log = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', () => {
      const url = new URL(req.url, 'http://x')
      const c = cookies(req)
      log.push(`${req.method} ${url.pathname}${url.search}`)
      const send = (status, content, headers = {}) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=windows-1251', ...headers })
        res.end(Buffer.isBuffer(content) ? content : encode(content))
      }
      if (challenge && c.bot_ok !== '1') {
        return send(403, challenge === 'manual' ? MANUAL_CHECK : AUTO_CHECK, { Server: 'ddos-guard' })
      }
      const loggedIn = c.uid === '7' && c.pass === 'good'
      if (url.pathname === '/takelogin.php' && req.method === 'POST') {
        const f = params(body)
        if (f.username === 'меня' && f.password === 'пароль123') {
          res.writeHead(302, { Location: '/', 'Set-Cookie': ['uid=7; path=/', 'pass=good; path=/'] })
          return res.end()
        }
        return send(200, fixture('login.html'))
      }
      if (url.pathname.startsWith('/i/poster/')) {
        res.writeHead(200, { 'Content-Type': 'image/jpeg' })
        return res.end(POSTER)
      }
      if (!loggedIn) return send(200, fixture('login.html'))
      if (url.pathname === '/') return send(200, fixture('search.html'))
      if (url.pathname === '/browse.php') {
        const q = decode1251Query(url.search.match(/[?&]s=([^&]*)/)?.[1] || '').toLowerCase()
        if (url.searchParams.get('page') === '0' && /интерстеллар|interstellar/.test(q)) return send(200, fixture('search.html'))
        return send(200, decode(fixture('search.html')).replace(/<tr class='first bg'>[\s\S]*<\/table><\/div>\s*\n\s*<\/div><div class="clr">/, '</table></div></div><div class="clr">').replace('Найдено 48', 'Найдено 0'))
      }
      if (url.pathname === '/details.php') return send(200, fixture('details.html'))
      if (url.pathname === '/get_srv_details.php') {
        return send(200, `<ul><li>Инфо хеш: ${hashFor(url.searchParams.get('id')).toUpperCase()}</li></ul>`)
      }
      if (url.pathname === '/download.php') {
        res.writeHead(200, { 'Content-Type': 'application/x-bittorrent' })
        return res.end(Buffer.from('d4:infod4:name1:xee'))
      }
      send(404, 'not found')
    })
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    resolve({ server, log, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => { server.closeAllConnections(); server.close(r) }) })
  }))
}
