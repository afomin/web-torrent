// End-to-end test: local tracker + seeding client + the real server as a child process.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-e2e-'))
const PORT = 3900 + Math.floor(Math.random() * 90)
const BASE = `http://127.0.0.1:${PORT}`
const PASSWORD = 'correct horse battery'
const H = { 'X-Requested-With': 'web-torrent' }

let tracker, seeder, server, torrentBuf, cookie
const payload = crypto.randomBytes(3 * 1024 * 1024 + 123)

before(async () => {
  tracker = new TrackerServer({ udp: false, ws: false, http: true })
  await new Promise(resolve => tracker.listen(0, '127.0.0.1', resolve))
  const announce = `http://127.0.0.1:${tracker.http.address().port}/announce`

  const seedDir = path.join(tmp, 'seed', 'My Movie')
  fs.mkdirSync(seedDir, { recursive: true })
  fs.writeFileSync(path.join(seedDir, 'movie.mp4'), payload)
  fs.writeFileSync(path.join(seedDir, 'notes.txt'), 'hello')

  seeder = new WebTorrent({ dht: false, lsd: false, natUpnp: false, natPmp: false })
  const t = await new Promise(resolve => seeder.seed(seedDir, { announce: [announce] }, resolve))
  torrentBuf = t.torrentFile

  server = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: path.join(tmp, 'data'),
      DOWNLOADS_DIR: path.join(tmp, 'downloads'),
      AUTH_USERNAME: 'me',
      AUTH_PASSWORD: PASSWORD,
      TORRENT_PORT: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  server.stderr.on('data', d => process.stderr.write(d))
  await new Promise((resolve, reject) => {
    server.stdout.on('data', d => { if (String(d).includes('listening')) resolve() })
    server.on('exit', code => reject(new Error('server exited ' + code)))
  })
})

after(async () => {
  server?.kill('SIGTERM')
  await new Promise(resolve => seeder.destroy(resolve))
  await new Promise(resolve => tracker.close(resolve))
  fs.rmSync(tmp, { recursive: true, force: true })
})

const req = (p, opts = {}) => fetch(BASE + p, { redirect: 'manual', ...opts, headers: { ...(cookie ? { cookie } : {}), ...opts.headers } })

test('unauthenticated access is blocked', async () => {
  assert.equal((await fetch(BASE + '/api/torrents')).status, 401)
  const r = await fetch(BASE + '/', { redirect: 'manual' })
  assert.equal(r.status, 302)
  assert.equal(r.headers.get('location'), '/login')
  assert.equal((await fetch(BASE + '/app.js', { redirect: 'manual' })).status, 302)
  assert.equal((await fetch(BASE + '/login')).status, 200)
})

test('wrong password is rejected, CSRF header required', async () => {
  const bad = await fetch(BASE + '/api/login', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'me', password: 'nope' }) })
  assert.equal(bad.status, 401)
  const noHeader = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'me', password: PASSWORD }) })
  assert.equal(noHeader.status, 403)
})

test('login works', async () => {
  const r = await fetch(BASE + '/api/login', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'me', password: PASSWORD }) })
  assert.equal(r.status, 200)
  const setCookie = r.headers.get('set-cookie')
  assert.match(setCookie, /HttpOnly/)
  assert.match(setCookie, /SameSite=Strict/)
  cookie = setCookie.split(';')[0]
  assert.equal((await req('/api/torrents')).status, 200)
})

test('invalid torrent input is rejected', async () => {
  const r = await req('/api/torrents', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ magnet: 'hello' }) })
  assert.equal(r.status, 400)
})

test('downloads a torrent, stops it and moves files', { timeout: 60000 }, async () => {
  const r = await req('/api/torrents', { method: 'POST', headers: { ...H, 'Content-Type': 'application/x-bittorrent' }, body: torrentBuf })
  assert.equal(r.status, 201)
  const added = await r.json()
  assert.equal(added.name, 'My Movie')

  const dup = await req('/api/torrents', { method: 'POST', headers: { ...H, 'Content-Type': 'application/x-bittorrent' }, body: torrentBuf })
  assert.equal(dup.status, 409)

  let data
  for (let i = 0; i < 100; i++) {
    data = await (await req('/api/torrents')).json()
    if (data.history.length) break
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  assert.equal(data.torrents.length, 0, 'torrent removed from active list')
  assert.equal(data.history[0].name, 'My Movie')
  assert.equal(data.history[0].path, 'My Movie')
  // .torrent file cleaned up
  assert.deepEqual(fs.readdirSync(path.join(tmp, 'data', 'torrents')), [])

  const list = await (await req('/api/files')).json()
  assert.deepEqual(list.items.map(i => i.name), ['My Movie'])
  const inner = await (await req('/api/files?path=' + encodeURIComponent('My Movie'))).json()
  assert.deepEqual(inner.items.map(i => [i.name, i.kind]), [['movie.mp4', 'video'], ['notes.txt', 'file']])
})

test('file download, range streaming and zip', async () => {
  const p = encodeURIComponent('My Movie/movie.mp4')
  const full = await req('/api/download?path=' + p)
  assert.equal(full.status, 200)
  assert.match(full.headers.get('content-disposition'), /attachment/)
  assert.ok(Buffer.from(await full.arrayBuffer()).equals(payload))

  const part = await req('/api/stream?path=' + p, { headers: { Range: 'bytes=100-199' } })
  assert.equal(part.status, 206)
  assert.ok(Buffer.from(await part.arrayBuffer()).equals(payload.subarray(100, 200)))

  const zip = await req('/api/download?path=' + encodeURIComponent('My Movie'))
  assert.equal(zip.status, 200)
  const zbuf = Buffer.from(await zip.arrayBuffer())
  assert.equal(zbuf.readUInt32LE(0), 0x04034b50)
  assert.ok(zbuf.length > payload.length)
})

test('path traversal is blocked', async () => {
  for (const bad of ['../data/sessions.json', '/etc/passwd', '.incomplete', '..']) {
    const r = await req('/api/download?path=' + encodeURIComponent(bad))
    assert.ok([400, 404].includes(r.status), `${bad} -> ${r.status}`)
  }
  const del = await req('/api/files?path=', { method: 'DELETE', headers: H })
  assert.equal(del.status, 400)
})

test('share links work without cookie and reject tampering', async () => {
  const r = await req('/api/share', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'My Movie/notes.txt', hours: 1 }) })
  const { url } = await r.json()
  const ok = await fetch(BASE + url)
  assert.equal(ok.status, 200)
  assert.equal(await ok.text(), 'hello')
  const tampered = url.replace(/\/s\/([^.]+)/, (m, p) => '/s/' + Buffer.from(JSON.stringify({ p: 'My Movie/movie.mp4', e: Date.now() + 1e9 })).toString('base64url'))
  assert.equal((await fetch(BASE + tampered)).status, 404)
})

test('pause, resume and cancel a download', async () => {
  const magnet = 'magnet:?xt=urn:btih:' + crypto.randomBytes(20).toString('hex') + '&dn=Nothing'
  const r = await req('/api/torrents', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ magnet }) })
  assert.equal(r.status, 201)
  const { id } = await r.json()
  let t = (await (await req('/api/torrents')).json()).torrents.find(x => x.id === id)
  assert.equal(t.status, 'metadata')
  t = await (await req(`/api/torrents/${id}/pause`, { method: 'POST', headers: H })).json()
  assert.equal(t.status, 'paused')
  t = await (await req(`/api/torrents/${id}/resume`, { method: 'POST', headers: H })).json()
  assert.equal(t.status, 'metadata')
  assert.equal((await req(`/api/torrents/${id}`, { method: 'DELETE', headers: H })).status, 200)
  assert.equal((await (await req('/api/torrents')).json()).torrents.length, 0)
  assert.deepEqual(fs.readdirSync(path.join(tmp, 'downloads', '.incomplete')), [])
})

test('delete files, then logout', async () => {
  const del = await req('/api/files?path=' + encodeURIComponent('My Movie'), { method: 'DELETE', headers: H })
  assert.equal(del.status, 200)
  const list = await (await req('/api/files')).json()
  assert.equal(list.items.length, 0)

  assert.equal((await req('/api/logout', { method: 'POST', headers: H })).status, 200)
  assert.equal((await req('/api/torrents')).status, 401)
})
