// Seeding is off by default: a second peer must get nothing from the server until it is enabled.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import WebTorrent from 'webtorrent'
import { Server as TrackerServer } from 'bittorrent-tracker'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-seed-'))
const PORT = 3800 + Math.floor(Math.random() * 90)
const BASE = `http://127.0.0.1:${PORT}`
const H = { 'X-Requested-With': 'web-torrent', 'Content-Type': 'application/json' }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const opts = { dht: false, lsd: false, natUpnp: false, natPmp: false }

let tracker, seeder, leecher, server, cookie, torrentBuf

before(async () => {
  tracker = new TrackerServer({ udp: false, ws: false, http: true })
  await new Promise(resolve => tracker.listen(0, '127.0.0.1', resolve))
  const announce = `http://127.0.0.1:${tracker.http.address().port}/announce`
  const file = path.join(tmp, 'big.bin')
  fs.writeFileSync(file, crypto.randomBytes(4 * 1024 * 1024))
  seeder = new WebTorrent(opts)
  const t = await new Promise(resolve => seeder.seed(file, { announce: [announce], pieceLength: 16384 }, resolve))
  torrentBuf = t.torrentFile

  server = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: path.join(tmp, 'data'),
      DOWNLOADS_DIR: path.join(tmp, 'downloads'),
      AUTH_PASSWORD: 'seeding-test-password',
      TORRENT_PORT: '0',
      DOWNLOAD_LIMIT_KBPS: '300'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  server.stderr.on('data', d => process.stderr.write(d))
  await new Promise((resolve, reject) => {
    server.stdout.on('data', d => { if (String(d).includes('listening')) resolve() })
    server.on('exit', code => reject(new Error('server exited ' + code)))
  })
  const r = await fetch(BASE + '/api/login', { method: 'POST', headers: H, body: JSON.stringify({ username: 'admin', password: 'seeding-test-password' }) })
  cookie = r.headers.get('set-cookie').split(';')[0]
})

after(async () => {
  server?.kill('SIGTERM')
  await Promise.all([seeder, leecher].filter(Boolean).map(c => new Promise(resolve => c.destroy(resolve))))
  await new Promise(resolve => tracker.close(resolve))
  fs.rmSync(tmp, { recursive: true, force: true })
})

const api = async (method, p, body) => {
  const r = await fetch(BASE + p, { method, headers: { ...H, cookie }, body: body && JSON.stringify(body) })
  return r.json()
}

test('no upload while seeding is off, upload after enabling it', { timeout: 90000 }, async () => {
  assert.deepEqual(await api('GET', '/api/settings'), { seeding: false, uploadLimitKB: 500 })

  const add = await fetch(BASE + '/api/torrents', { method: 'POST', headers: { ...H, cookie, 'Content-Type': 'application/x-bittorrent' }, body: torrentBuf })
  assert.equal(add.status, 201)

  // Let the server get part of the data, then take the original seeder away.
  let progress = 0
  for (let i = 0; i < 60 && progress < 0.3; i++) {
    await sleep(500)
    progress = (await api('GET', '/api/torrents')).torrents[0].progress
  }
  assert.ok(progress >= 0.3 && progress < 1, `progress ${progress}`)
  await new Promise(resolve => seeder.destroy(resolve))
  seeder = null

  leecher = new WebTorrent(opts)
  const lt = leecher.add(torrentBuf, { path: path.join(tmp, 'leech') })
  await sleep(8000)
  assert.ok(lt.numPeers >= 1, 'leecher connected to the server')
  assert.equal(lt.downloaded, 0, 'server must not upload while seeding is off')

  const s = await api('PUT', '/api/settings', { seeding: true, uploadLimitKB: 0 })
  assert.equal(s.seeding, true)
  for (let i = 0; i < 30 && lt.downloaded === 0; i++) await sleep(500)
  assert.ok(lt.downloaded > 0, 'server uploads once seeding is on')

  // Turning it back off stops the flow.
  await api('PUT', '/api/settings', { seeding: false })
  await sleep(1500)
  const before = lt.downloaded
  await sleep(4000)
  assert.ok(lt.downloaded - before < 64 * 1024, `still uploading: ${lt.downloaded - before}`)
})
