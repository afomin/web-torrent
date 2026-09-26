import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseName, parseSize, parseSearch, parseDetails, parseInfoHash, isChallenge, isLoggedIn } from '../src/kinozal/parse.js'
import { rankReleases, groupMovies, sameMovie } from '../src/kinozal/score.js'
import { KinozalClient, parseCookieString } from '../src/kinozal/client.js'
import { encode, decode, encodeURIComponent1251 } from '../src/kinozal/cp1251.js'
import { startFakeKinozal, hashFor, POSTER } from './helpers/fake-kinozal.js'

const GB = 1024 ** 3
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'kinozal')
const page = name => decode(fs.readFileSync(path.join(fixtures, name)))
const DEAD_MIRROR = 'http://127.0.0.1:1'

describe('parsing real kinozal.guru pages', () => {
  test('search results', () => {
    const list = parseSearch(page('search.html'))
    assert.equal(list.length, 48)
    const first = list[0]
    assert.equal(first.id, '1322016')
    assert.equal(first.name, 'Интерстеллар / Interstellar / 2014 / ДБ, ПМ, СТ / WEB-DL (1080p)')
    assert.equal(first.size, Math.round(8.21 * GB))
    assert.equal(first.seeds, 67)
    assert.equal(first.peers, 0)
    assert.equal(first.category, 13)
    assert.equal(first.gold, true)
    assert.equal(first.resolution, 1080)
    assert.equal(first.date, '06.02.2023 в 20:17')
    // soundtracks and books are not video
    assert.equal(list.filter(r => !r.video).length, 7)
    assert.ok(list.find(r => r.id === '1355642').gold === false, 'r0 link = normal release')
  })

  test('details page', () => {
    const d = parseDetails(page('details.html'), 'https://kinozal.guru')
    assert.equal(d.poster, 'https://kinozal.guru/i/poster/4/2/1355642.jpg')
    assert.match(d.description, /^Когда засуха/)
    assert.equal(d.genre, 'Фантастика, драма, приключения, фильмы о космосе')
    assert.equal(d.imdb, 8.7)
    assert.equal(d.kinopoisk, 8.7)
    assert.equal(d.similarQuery, 'Интерстеллар / Interstellar (2014)')
    assert.equal(d.gold, true)
  })

  test('login state and anti-bot detection', () => {
    assert.equal(isLoggedIn(page('search.html')), true)
    assert.equal(isLoggedIn(page('login.html')), false)
    for (const f of ['search.html', 'details.html', 'login.html']) assert.equal(isChallenge(200, page(f)), false, f)
    assert.equal(isChallenge(403, '<html>...</html>', { server: 'ddos-guard' }), true)
    assert.equal(isChallenge(200, '<title>Just a moment...</title><div class="cf-turnstile"></div>'), true)
    assert.equal(isChallenge(200, '<p>Подтвердите, что вы не робот</p>'), true)
  })

  test('real ranking picks the gold 1080p WEB-DL with subtitles', () => {
    const [movie] = groupMovies(parseSearch(page('search.html')))
    assert.equal(movie.title, 'Интерстеллар')
    assert.deepEqual(movie.altTitles, ['Interstellar'])
    assert.equal(movie.year, 2014)
    assert.equal(movie.best.id, '1322016')
    assert.deepEqual(movie.best.warnings, [])
  })
})

describe('parsing helpers', () => {
  test('cp1251 round trip', () => {
    assert.equal(decode(encode('Интерстеллар ё Ё')), 'Интерстеллар ё Ё')
    assert.equal(encodeURIComponent1251('Ая 1'), '%C0%FF%201')
  })

  test('sizes', () => {
    assert.equal(parseSize('10.43 ГБ'), Math.round(10.43 * GB))
    assert.equal(parseSize('700 МБ'), 700 * 1024 ** 2)
    assert.equal(parseSize('1,5 ТБ'), Math.round(1.5 * 1024 ** 4))
    assert.equal(parseSize('154'), null)
  })

  test('release names', () => {
    const a = parseName('Интерстеллар / Interstellar (IMAX Edition) / 2014 / ДБ, ПМ, АП (Есарев), СТ / BDRip (1080p)')
    assert.deepEqual(a.titles, ['Интерстеллар', 'Interstellar (IMAX Edition)'])
    assert.equal(a.year, 2014)
    assert.equal(a.resolution, 1080)
    assert.equal(a.subs, true)
    assert.equal(a.voice, true)
    const b = parseName('Дюна / Dune / 2021 / СТ / 4K, HEVC, HDR / WEB-DL (2160p)')
    assert.equal(b.resolution, 2160)
    assert.equal(b.hdr, true)
    assert.equal(b.voice, false)
    assert.equal(parseName('Интерстеллар / Interstellar / 2014 / ДБ / BDRip').resolution, 480)
    const c = parseName('Сериал (1 сезон: 1-8 серии из 8) / Show / 2019-2020 / ЛМ / WEBRip (720p)')
    assert.equal(c.year, 2019)
    assert.equal(c.resolution, 720)
    // "СТ" inside a word must not count as subtitles
    assert.equal(parseName('Фильм / 2020 / ПМ / BDRip СТАРЫЙ').subs, false)
  })

  test('info hash', () => {
    assert.equal(parseInfoHash('<li>Инфо хеш: ABCDEF0123456789ABCDEF0123456789ABCDEF01</li>'), 'abcdef0123456789abcdef0123456789abcdef01')
  })

  test('IMAX Edition is the same movie', () => {
    const r = { titles: ['Интерстеллар', 'Interstellar (IMAX Edition)'], year: 2014, video: true }
    assert.equal(sameMovie(r, { title: 'Interstellar', year: 2014 }), true)
    assert.equal(sameMovie(r, { title: 'Интерстеллар', year: 2015 }), false)
    assert.equal(sameMovie({ ...r, video: false }, { title: 'Интерстеллар', year: 2014 }), false)
  })
})

describe('scoring', () => {
  const r = (name, sizeGb, seeds, gold = false) => ({ id: name, name, size: sizeGb * GB, seeds, peers: 0, gold, ...parseName(name) })

  test('prefers 1080p, 7–15 GB, subtitles, gold, seeds', () => {
    const ranked = rankReleases([
      r('Фильм / Film / 2020 / ПМ / BDRip (1080p)', 12, 300),
      r('Фильм / Film / 2020 / ПМ, СТ / BDRip (1080p)', 10, 150, true),
      r('Фильм / Film / 2020 / ПМ, СТ / BDRip (720p)', 4, 800),
      r('Фильм / Film / 2020 / ДБ, СТ / UHD BDRemux (2160p)', 80, 50),
      r('Фильм / Film / 2020 / ПМ, СТ / BDRip (1080p) ', 11, 0)
    ])
    assert.equal(ranked[0].name, 'Фильм / Film / 2020 / ПМ, СТ / BDRip (1080p)')
    assert.ok(ranked[0].reasons.includes('золотая'))
    assert.ok(ranked[0].reasons.includes('субтитры'))
    assert.equal(ranked.at(-1).seeds, 0, 'no seeds ranks last')
  })

  test('4K in the ideal size range scores like 1080p', () => {
    assert.equal(rankReleases([r('A / 2020 / СТ / WEB-DL (2160p)', 14, 100)])[0].score,
      rankReleases([r('A / 2020 / СТ / WEB-DL (1080p)', 14, 100)])[0].score)
  })

  test('original with subtitles gets a bonus over a voice-over with subtitles', () => {
    const [best] = rankReleases([
      r('Фильм / Film / 2020 / ПМ, СТ / BDRip (1080p)', 10, 100),
      r('Фильм / Film / 2020 / СТ / BDRip (1080p)', 10, 100)
    ])
    assert.ok(best.reasons.includes('оригинал'))
  })
})

test('cookie string parsing', () => {
  assert.deepEqual(parseCookieString('uid=7; pass=good'), { uid: '7', pass: 'good' })
  assert.deepEqual(parseCookieString('uid=7\npass=good\n'), { uid: '7', pass: 'good' })
})

function withClient (opts, fn) {
  let fake, dir, client
  before(async () => {
    fake = await startFakeKinozal(opts)
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kz-'))
    client = new KinozalClient({ dataDir: dir, mirrors: [DEAD_MIRROR, fake.url] })
  })
  after(async () => {
    await client.close()
    await fake.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  fn(() => ({ fake, dir, client }))
}

describe('client over plain HTTP', () => {
  withClient({}, ctx => {
    test('skips a dead mirror, rejects a wrong password', async () => {
      const { client, fake } = ctx()
      await assert.rejects(client.configure({ mirror: 'auto', username: 'меня', password: 'нет' }), /Не удалось войти/)
      assert.equal(client.status().baseUrl, fake.url)
    })

    test('login, search, movie, poster, hash, torrent', { timeout: 60000 }, async () => {
      const { client, dir } = ctx()
      const status = await client.configure({ username: 'меня', password: 'пароль123' })
      assert.equal(status.loggedIn, true)
      assert.equal(status.mode, 'fetch')

      const movies = groupMovies(await client.search('интерстеллар'))
      const movie = movies[0]
      assert.equal(movie.best.id, '1322016')

      const details = await client.details(movie.best.id)
      assert.equal(details.similarQuery, 'Интерстеллар / Interstellar (2014)')
      const all = rankReleases(await client.releasesForMovie(movie, details.similarQuery))
      assert.equal(all.length, 39)
      assert.equal(all[0].id, '1322016')

      const poster = await client.poster('1322016')
      assert.equal(poster.type, 'image/jpeg')
      assert.ok(poster.buf.equals(POSTER))
      assert.ok(fs.existsSync(path.join(dir, 'kinozal-posters', '1322016.img')), 'poster cached on disk')

      assert.equal(await client.infoHash('1322016'), hashFor('1322016'))
      assert.ok((await client.torrentFile('1322016')).includes('4:info'))

      const saved = JSON.parse(fs.readFileSync(path.join(dir, 'kinozal.json'), 'utf8'))
      assert.equal(saved.cookies.pass, 'good')
      assert.equal('password' in client.status(), false)
    })
  })
})

describe('client behind an automatic browser check (headless Chromium)', () => {
  withClient({ challenge: 'auto' }, ctx => {
    test('passes the check and works', { timeout: 120000 }, async t => {
      const { client, dir } = ctx()
      if (!client.status().browserAvailable) return t.skip('no chromium')
      const status = await client.configure({ username: 'меня', password: 'пароль123' })
      assert.equal(status.loggedIn, true)
      assert.ok(fs.existsSync(path.join(dir, 'kinozal-browser.json')), 'headless browser was used')
      assert.equal((await client.search('Interstellar')).length, 48)
    })
  })
})

describe('client behind an "I\'m not a robot" check', () => {
  withClient({ challenge: 'manual' }, ctx => {
    test('asks the user, replays their click, then works', { timeout: 120000 }, async t => {
      const { client } = ctx()
      if (!client.status().browserAvailable) return t.skip('no chromium')
      await assert.rejects(client.configure({ username: 'меня', password: 'пароль123' }), err => err.code === 'CAPTCHA')
      assert.equal(client.status().captcha, true)

      const shot = await client.captchaScreenshot()
      assert.equal(shot[0], 0xff, 'jpeg screenshot of the server-side page')
      assert.equal(await client.captchaSolved(), false)
      await assert.rejects(client.captchaClick(5000, 10), /Bad coordinates/)

      await client.captchaClick(500, 300)
      let solved = false
      for (let i = 0; i < 20 && !solved; i++) {
        await new Promise(resolve => setTimeout(resolve, 250))
        solved = await client.captchaSolved()
      }
      assert.equal(solved, true)

      await client.ensureLogin(true)
      assert.equal(client.status().loggedIn, true)
      assert.equal((await client.search('Interstellar')).length, 48)
    })
  })
})

test('cookie-only login', async () => {
  const fake = await startFakeKinozal()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kz-'))
  const client = new KinozalClient({ dataDir: dir, mirrors: [fake.url] })
  try {
    await assert.rejects(client.configure({ cookies: 'uid=7' }), /uid и pass/)
    const s = await client.configure({ cookies: 'uid=7; pass=good' })
    assert.equal(s.loggedIn, true)
    assert.equal((await client.search('Interstellar')).length, 48)
    assert.equal((await client.search('Такого фильма нет')).length, 0)
    await assert.rejects(client.configure({ cookies: 'uid=7; pass=bad' }), /устарели/)
  } finally {
    await client.close()
    await fake.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
