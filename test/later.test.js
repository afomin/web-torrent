// "На потом": torrents kept without downloading, and the disk space check.
// The server runs with an absurd disk reserve, so anything that would download "doesn't fit".
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import createTorrent from 'create-torrent'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-later-'))
const PORT = 3700 + Math.floor(Math.random() * 90)
const BASE = `http://127.0.0.1:${PORT}`
const H = { 'X-Requested-With': 'web-torrent' }
let server, cookie, single, multi

const make = (p, opts = {}) => new Promise((resolve, reject) => createTorrent(p, opts, (err, buf) => err ? reject(err) : resolve(buf)))

before(async () => {
  const dir = path.join(tmp, 'src', 'Season 1')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'e1.mkv'), crypto.randomBytes(5000))
  fs.writeFileSync(path.join(dir, 'e2.mkv'), crypto.randomBytes(7000))
  fs.writeFileSync(path.join(tmp, 'src', 'film.mkv'), crypto.randomBytes(9000))
  multi = await make(dir)
  single = await make(path.join(tmp, 'src', 'film.mkv'))

  server = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: path.join(tmp, 'data'), DOWNLOADS_DIR: path.join(tmp, 'dl'), AUTH_PASSWORD: 'later-test-password', TORRENT_PORT: '0', DISK_RESERVE_MB: String(1024 ** 3) },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  server.stderr.on('data', d => process.stderr.write(d))
  await new Promise((resolve, reject) => {
    server.stdout.on('data', d => { if (String(d).includes('listening')) resolve() })
    server.on('exit', code => reject(new Error('server exited ' + code)))
  })
  const r = await fetch(BASE + '/api/login', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'later-test-password' }) })
  cookie = r.headers.get('set-cookie').split(';')[0]
})

after(async () => {
  // Wait for the server to finish saving its state before removing its folder.
  if (server && server.exitCode === null) {
    const exited = new Promise(resolve => server.once('exit', resolve))
    server.kill('SIGTERM')
    await exited
  }
  fs.rmSync(tmp, { recursive: true, force: true })
})

const call = async (method, p, body, raw) => {
  const headers = { ...H, cookie }
  if (raw) headers['Content-Type'] = 'application/x-bittorrent'
  else if (body) headers['Content-Type'] = 'application/json'
  const r = await fetch(BASE + p, { method, headers, body: raw || (body && JSON.stringify(body)) })
  return { status: r.status, data: await r.json().catch(() => null) }
}
const list = async () => (await call('GET', '/api/torrents')).data.torrents

test('a torrent that does not fit asks to be postponed', async () => {
  const r = await call('POST', '/api/torrents', null, single)
  assert.equal(r.status, 409)
  assert.equal(r.data.code, 'NO_SPACE')
  assert.match(r.data.error, /Не хватает места/)
  assert.equal((await list()).length, 0, 'nothing was added')
})

test('"later" keeps it without downloading, files can be chosen in advance', async () => {
  const a = await call('POST', '/api/torrents?later=1', null, single)
  assert.equal(a.status, 201)
  assert.equal(a.data.status, 'later')
  const b = await call('POST', '/api/torrents?later=1', null, multi)
  assert.equal(b.data.status, 'later')
  assert.equal(b.data.files, 2)

  const files = (await call('GET', `/api/torrents/${b.data.id}/files`)).data.files
  assert.deepEqual(files.map(f => f.path), ['Season 1/e1.mkv', 'Season 1/e2.mkv'])
  const sel = await call('PUT', `/api/torrents/${b.data.id}/files`, { files: [1] })
  assert.equal(sel.data.status, 'later', 'choosing files does not start it')
  assert.equal(sel.data.selectedFiles, 1)
  assert.equal(sel.data.length, 7000)

  const t = (await list()).find(x => x.id === b.data.id)
  assert.equal(t.status, 'later')
  assert.equal(t.peers, 0)
})

test('starting checks space again; force starts anyway; postpone stops it', async () => {
  const id = (await list()).find(x => x.files === 2).id
  const r = await call('POST', `/api/torrents/${id}/resume`)
  assert.equal(r.data.code, 'NO_SPACE')
  const f = await call('POST', `/api/torrents/${id}/resume`, { force: true })
  assert.equal(f.status, 200)
  assert.notEqual(f.data.status, 'later')
  const p = await call('POST', `/api/torrents/${id}/later`)
  assert.equal(p.data.status, 'later')
  assert.equal(p.data.selectedFiles, 1, 'file choice kept')
})

test('later items can be removed', async () => {
  for (const t of await list()) assert.equal((await call('DELETE', `/api/torrents/${t.id}`)).status, 200)
  assert.equal((await list()).length, 0)
})
