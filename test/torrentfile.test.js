// .torrent files with junk outside the info dict (as served by Kinozal) must still be accepted.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import bencode from 'bencode'
import parseTorrent from 'parse-torrent'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-tf-'))
process.env.DATA_DIR = path.join(tmp, 'data')
process.env.DOWNLOADS_DIR = path.join(tmp, 'downloads')
const { normalizeTorrentFile } = await import('../src/torrents.js')

const info = {
  name: Buffer.from('Show.S01'),
  'piece length': 16384,
  pieces: crypto.randomBytes(20),
  files: [{ length: 100, path: [Buffer.from('S01'), Buffer.from('E01.mkv')] }]
}
const sha1 = b => crypto.createHash('sha1').update(b).digest('hex')
const infoHash = sha1(bencode.encode(info))
const enc = t => Buffer.from(bencode.encode(t))

test('Kinozal-style announce: {} and a {} inside announce-list', async () => {
  const raw = enc({
    announce: {},
    'announce-list': [[{}, Buffer.from('http://tr.example/ann?uk=x'), Buffer.from('http://tr2.example/ann')], [Buffer.from('udp://open.example:6969/announce')]],
    comment: Buffer.from('https://kinozal.guru/details.php?id=1'),
    info
  })
  await assert.rejects(parseTorrent(raw), 'the raw file really breaks the parser')
  const p = await parseTorrent(normalizeTorrentFile(raw))
  assert.equal(p.infoHash, infoHash, 'info hash unchanged')
  assert.deepEqual(p.announce, ['http://tr.example/ann?uk=x', 'http://tr2.example/ann', 'udp://open.example:6969/announce'])
})

test('other junk: nested url-list, non-string created by, empty announce-list', async () => {
  const raw = enc({ announce: {}, 'announce-list': [[{}]], 'url-list': [[Buffer.from('http://seed.example/f')]], 'created by': 42, info })
  const p = await parseTorrent(normalizeTorrentFile(raw))
  assert.equal(p.infoHash, infoHash)
  assert.deepEqual(p.announce, [])
  assert.deepEqual(p.urlList, ['http://seed.example/f'])
})

test('a normal torrent is passed through untouched', () => {
  const raw = enc({ announce: Buffer.from('http://tr.example/ann'), info })
  assert.equal(normalizeTorrentFile(raw), raw)
  const notTorrent = Buffer.from('<html>')
  assert.equal(normalizeTorrentFile(notTorrent), notTorrent)
})

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
