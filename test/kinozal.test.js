import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseName, parseSize, parseSearch, parseInfoHash, isChallenge } from '../src/kinozal/parse.js'
import { rankReleases, groupMovies } from '../src/kinozal/score.js'
import { KinozalClient, parseCookieString } from '../src/kinozal/client.js'
import { encode, decode, encodeURIComponent1251 } from '../src/kinozal/cp1251.js'
import { startFakeKinozal, hashFor } from './helpers/fake-kinozal.js'

const GB = 1024 ** 3

describe('parsing', () => {
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
    const a = parseName('Интерстеллар / Interstellar / 2014 / ПМ, СТ / BDRip (1080p)')
    assert.deepEqual(a.titles, ['Интерстеллар', 'Interstellar'])
    assert.equal(a.year, 2014)
    assert.equal(a.resolution, 1080)
    assert.equal(a.subs, true)
    assert.equal(a.voice, true)
    const b = parseName('Дюна / Dune / 2021 / СТ / UHD WEB-DL (2160p, HDR)')
    assert.equal(b.resolution, 2160)
    assert.equal(b.hdr, true)
    assert.equal(b.voice, false)
    const c = parseName('Сериал (1 сезон: 1-8 серии из 8) / Show / 2019-2020 / ЛМ / WEBRip (720p)')
    assert.equal(c.year, 2019)
    assert.equal(c.resolution, 720)
    assert.equal(c.subs, false)
    // "СТ" inside a word must not count as subtitles
    assert.equal(parseName('Фильм / 2020 / ПМ / BDRip СТАРЫЙ').subs, false)
  })

  test('challenge detection', () => {
    assert.equal(isChallenge(403, '<html>...</html>', { server: 'ddos-guard' }), true)
    assert.equal(isChallenge(200, '<title>DDoS-Guard</title> checking your browser'), true)
    assert.equal(isChallenge(200, '<a href="/details.php?id=1">x</a> ddos-guard in footer'), false)
    assert.equal(isChallenge(200, '<p>normal</p>'), false)
  })

  test('info hash', () => {
    assert.equal(parseInfoHash('<li>Инфо хеш: ABCDEF0123456789ABCDEF0123456789ABCDEF01</li>'), 'abcdef0123456789abcdef0123456789abcdef01')
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

  test('4K in the ideal size range counts like 1080p', () => {
    const [best] = rankReleases([
      r('Фильм / Film / 2020 / ПМ, СТ / WEB-DL (2160p)', 14, 100),
      r('Фильм / Film / 2020 / ПМ, СТ / WEB-DL (1080p)', 14, 100)
    ])
    assert.equal(best.resolution === 2160 || best.resolution === 1080, true)
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

for (const challenge of [false, true]) {
  describe(challenge ? 'client behind a browser check (headless Chromium)' : 'client over plain HTTP', () => {
    let fake, dir, client
    before(async () => {
      fake = await startFakeKinozal({ challenge })
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kz-'))
      client = new KinozalClient({ dataDir: dir })
    })
    after(async () => {
      await client.close()
      await fake.close()
      fs.rmSync(dir, { recursive: true, force: true })
    })

    test('wrong password is reported', { timeout: 90000 }, async () => {
      if (challenge && !client.status().browserAvailable) return
      await assert.rejects(client.configure({ baseUrl: fake.url, username: 'меня', password: 'нет' }), /Неверный пароль|Не удалось войти/)
    })

    test('login, search, movie releases, info hash, torrent', { timeout: 120000 }, async t => {
      if (challenge && !client.status().browserAvailable) return t.skip('no chromium')
      const status = await client.configure({ baseUrl: fake.url, username: 'меня', password: 'пароль123' })
      assert.equal(status.loggedIn, true)
      // Behind the check, the browser-issued cookies may let plain HTTP through again, so either mode is fine.
      if (!challenge) assert.equal(status.mode, 'fetch')
      else assert.ok(fs.existsSync(path.join(dir, 'kinozal-browser.json')), 'headless browser was used')
      assert.equal(status.hasPassword, true)

      const releases = await client.search('интерстеллар')
      assert.equal(releases.length, 5)
      assert.equal(releases[0].gold, true)
      assert.equal(releases[0].seeds, 154)

      const movies = groupMovies(releases)
      assert.equal(movies.length, 2)
      const movie = movies.find(m => m.year === 2014)
      assert.equal(movie.count, 4)
      assert.equal(movie.best.id, '101')

      const all = rankReleases(await client.releasesForMovie(movie))
      assert.deepEqual(all.map(r => r.id).sort(), ['101', '102', '103', '104'])
      assert.equal(all[0].id, '101')

      assert.equal(await client.infoHash('101'), hashFor('101'))
      const buf = await client.torrentFile('101')
      assert.ok(buf.includes('4:info'))

      // state persisted without leaking into the status response
      const saved = JSON.parse(fs.readFileSync(path.join(dir, 'kinozal.json'), 'utf8'))
      assert.equal(saved.cookies.pass, 'good')
      assert.equal('password' in client.status(), false)
    })
  })
}

test('cookie-only login', async () => {
  const fake = await startFakeKinozal()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kz-'))
  const client = new KinozalClient({ dataDir: dir })
  try {
    await assert.rejects(client.configure({ baseUrl: fake.url, cookies: 'uid=7' }), /uid и pass/)
    const s = await client.configure({ baseUrl: fake.url, cookies: 'uid=7; pass=good' })
    assert.equal(s.loggedIn, true)
    assert.equal((await client.search('Interstellar')).length, 5)
    await assert.rejects(client.configure({ cookies: 'uid=7; pass=bad' }), /устарели/)
  } finally {
    await client.close()
    await fake.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('search results page parser ignores non-release rows', () => {
  const html = '<table><tr><td><a href="/details.php?id=5">Фильм / 2020 / СТ / BDRip (1080p)</a></td><td>7,5 ГБ</td><td class="sl_s">12</td><td class="sl_p">1</td></tr>' +
    '<tr><td><a href="/details.php?id=6">Комментарии</a></td><td>нет размера</td></tr></table>'
  const list = parseSearch(html)
  assert.equal(list.length, 1)
  assert.equal(list[0].id, '5')
  assert.equal(list[0].size, Math.round(7.5 * GB))
})
