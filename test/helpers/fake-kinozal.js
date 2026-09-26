// A tiny stand-in for kinozal: windows-1251 pages, cookie login, optional DDoS-Guard style JS check.
import http from 'node:http'
import { encode } from '../../src/kinozal/cp1251.js'

export const RELEASES = [
  { id: 101, name: 'Интерстеллар / Interstellar / 2014 / ПМ, СТ / BDRip (1080p)', size: '10.43 ГБ', seeds: 154, peers: 3, gold: true },
  { id: 102, name: 'Интерстеллар / Interstellar / 2014 / ПМ / BDRip (1080p)', size: '12 ГБ', seeds: 300, peers: 12 },
  { id: 103, name: 'Интерстеллар / Interstellar / 2014 / ДБ, СТ / UHD BDRemux (2160p, HDR)', size: '80.1 ГБ', seeds: 40, peers: 2 },
  { id: 104, name: 'Интерстеллар / Interstellar / 2014 / ПМ, СТ / BDRip (720p)', size: '4.4 ГБ', seeds: 500, peers: 30 },
  { id: 105, name: 'Интерстеллар: Наука / The Science of Interstellar / 2015 / СТ / WEB-DL (1080p)', size: '3 ГБ', seeds: 10, peers: 0 }
]
export const hashFor = id => String(id).repeat(20).slice(0, 40).padEnd(40, 'a').replace(/[^0-9a]/g, 'a')

function decode1251Query (s) {
  const bytes = []
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '%') { bytes.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2 } else if (s[i] === '+') bytes.push(32)
    else bytes.push(s.charCodeAt(i))
  }
  return new TextDecoder('windows-1251').decode(Buffer.from(bytes))
}
const params = str => Object.fromEntries(String(str).split('&').filter(Boolean).map(p => {
  const [k, v = ''] = p.split('=')
  return [k, decode1251Query(v)]
}))
const cookies = req => Object.fromEntries(String(req.headers.cookie || '').split(';').map(s => s.trim().split('=')).filter(p => p[0]))

const page = (body, loggedIn) => `<html><head><meta charset="windows-1251"><title>Кинозал</title></head><body>
<div class="menu">${loggedIn ? '<a href="/logout.php?hash4u=x">Выход</a>' : '<form action="/takelogin.php" method="post"><input name="username"><input name="password" type="password"></form>'}</div>
${body}</body></html>`

function results (list) {
  const rows = list.map(r => `<tr class="bg"><td class="bt"><img src="/pic/cat/8.gif" onclick="cat(8);"></td>
<td class="nam"><a href="/details.php?id=${r.id}" class="r1">${r.name}</a>${r.gold ? ' <img src="/pic/gold.gif" title="Золотая раздача">' : ''}</td>
<td class="s">2</td><td class="s">${r.size}</td><td class="sl_s">${r.seeds}</td><td class="sl_p">${r.peers}</td>
<td class="s">сегодня в 10:15</td><td class="sl"><a href="/userdetails.php?id=5">uploader</a></td></tr>`).join('\n')
  return `<table class="t_peer w100p"><tr class="mn"><td>Кат</td><td>Название</td><td>Ком</td><td>Размер</td><td>Сиды</td><td>Пиры</td><td>Залит</td><td>Раздает</td></tr>${rows}</table>`
}

export function startFakeKinozal ({ challenge = false, torrentFor } = {}) {
  const log = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', () => {
      const url = new URL(req.url, 'http://x')
      const c = cookies(req)
      log.push(`${req.method} ${url.pathname}`)
      const send = (status, html, headers = {}) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=windows-1251', ...headers })
        res.end(encode(html))
      }
      if (challenge && c.__ddg_ok !== '1') {
        return send(403, `<html><body>DDoS-Guard: проверка браузера...<script>
          setTimeout(() => { document.cookie = '__ddg_ok=1; path=/'; location.reload() }, 300)</script></body></html>`, { Server: 'ddos-guard' })
      }
      const loggedIn = c.uid === '7' && c.pass === 'good'
      if (url.pathname === '/takelogin.php' && req.method === 'POST') {
        const f = params(body)
        if (f.username === 'меня' && f.password === 'пароль123') {
          res.writeHead(302, { Location: '/', 'Set-Cookie': ['uid=7; path=/', 'pass=good; path=/'] })
          return res.end()
        }
        return send(200, page('<div class="bx1"><div class="red">Неверный пароль</div></div>', false))
      }
      if (url.pathname === '/') return send(200, page('<p>Главная</p>', loggedIn))
      if (!loggedIn) return send(200, page('<p>Войдите</p>', false))
      if (url.pathname === '/browse.php') {
        const q = decode1251Query(url.search.match(/[?&]s=([^&]*)/)?.[1] || '').toLowerCase()
        const page0 = url.searchParams.get('page') === '0'
        const list = page0 ? RELEASES.filter(r => r.name.toLowerCase().includes(q)) : []
        return send(200, page(list.length ? results(list) : '<div>Ничего не найдено</div>', true))
      }
      if (url.pathname === '/get_srv_details.php') {
        return send(200, `<ul><li>Инфо хеш: ${hashFor(url.searchParams.get('id')).toUpperCase()}</li></ul>`)
      }
      if (url.pathname === '/download.php') {
        res.writeHead(200, { 'Content-Type': 'application/x-bittorrent' })
        return res.end(torrentFor ? torrentFor(url.searchParams.get('id')) : Buffer.from('d4:infod4:name1:xee'))
      }
      send(404, page('404', true))
    })
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    resolve({ server, log, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) })
  }))
}
