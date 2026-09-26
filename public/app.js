'use strict'

// ---------- helpers ----------

const $ = sel => document.querySelector(sel)

/** Tiny DOM builder. Text is always set via textContent, so torrent/file names can't inject HTML. */
function h (tag, attrs = {}, ...children) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue
    if (k === 'class') el.className = v
    else if (k === 'text') el.textContent = v
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else el.setAttribute(k, v === true ? '' : v)
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue
    el.append(c instanceof Node ? c : document.createTextNode(String(c)))
  }
  return el
}

const ICONS = {
  pause: 'M8 5v14M16 5v14',
  play: 'M7 4.5v15l12-7.5z',
  x: 'M18 6 6 18M6 6l12 12',
  trash: 'M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6M10 11v6M14 11v6',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5',
  video: 'M4 5h11a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM17 10l5-3v10l-5-3',
  audio: 'M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  check: 'M20 6 9 17l-5-5',
  open: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 11v5M9.5 13.5 12 11l2.5 2.5',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z'
}

function icon (name) {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', name === 'play' ? 'currentColor' : 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  const path = document.createElementNS(ns, 'path')
  path.setAttribute('d', ICONS[name])
  svg.append(path)
  return svg
}

function iconBtn (name, title, onclick, extra = '') {
  return h('button', { class: `icon-btn ${extra}`, title, 'aria-label': title, onclick }, icon(name))
}

function fmtBytes (n) {
  if (!n || n < 0) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1)
  const v = n / 1024 ** i
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`
}

const fmtSpeed = n => `${fmtBytes(n)}/s`

function fmtEta (ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '∞'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} с`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} мин`
  const hrs = Math.floor(m / 60)
  if (hrs < 48) return `${hrs} ч ${m % 60} мин`
  return `${Math.floor(hrs / 24)} д`
}

function fmtDate (ms) {
  return new Date(ms).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function toast (msg, type = '') {
  const el = h('div', { class: `toast ${type}`, text: msg })
  $('#toasts').append(el)
  setTimeout(() => el.remove(), 3500)
}

async function api (method, url, body, headers = {}) {
  const opts = { method, headers: { 'X-Requested-With': 'web-torrent', ...headers } }
  if (body instanceof Blob || body instanceof ArrayBuffer) {
    opts.body = body
  } else if (body !== undefined) {
    opts.body = JSON.stringify(body)
    opts.headers['Content-Type'] = 'application/json'
  }
  const res = await fetch(url, opts)
  if (res.status === 401) {
    location.href = '/login'
    throw new Error('Unauthorized')
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

function confirmDialog (title, text, okLabel = 'Удалить') {
  const dlg = $('#confirm-dlg')
  $('#confirm-title').textContent = title
  $('#confirm-text').textContent = text
  $('#confirm-ok').textContent = okLabel
  dlg.returnValue = ''
  dlg.showModal()
  return new Promise(resolve => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }))
}

const q = p => encodeURIComponent(p)

// ---------- tabs ----------

let currentTab = 'downloads'

function showTab (tab) {
  currentTab = tab
  for (const b of document.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.tab === tab)
  $('#view-downloads').classList.toggle('hidden', tab !== 'downloads')
  $('#view-files').classList.toggle('hidden', tab !== 'files')
  $('#view-search').classList.toggle('hidden', tab !== 'search')
  if (tab === 'files') loadFiles(currentPath)
  if (tab === 'search') loadKinozalStatus()
  try { localStorage.setItem('tab', tab) } catch {}
}

for (const b of document.querySelectorAll('.tab')) b.addEventListener('click', () => showTab(b.dataset.tab))

// ---------- adding torrents ----------

async function addMagnet (magnet) {
  const btn = $('#add-btn')
  btn.disabled = true
  try {
    const t = await api('POST', '/api/torrents', { magnet })
    toast(`Добавлено: ${t.name}`, 'ok')
    $('#magnet').value = ''
    refreshTorrents()
  } catch (err) {
    toast(err.message, 'error')
  } finally {
    btn.disabled = false
  }
}

async function addFiles (files) {
  for (const f of files) {
    if (!/\.torrent$/i.test(f.name) && f.type !== 'application/x-bittorrent') {
      toast(`${f.name}: это не .torrent-файл`, 'error')
      continue
    }
    try {
      const t = await api('POST', '/api/torrents', f, { 'Content-Type': 'application/x-bittorrent' })
      toast(`Добавлено: ${t.name}`, 'ok')
    } catch (err) {
      toast(`${f.name}: ${err.message}`, 'error')
    }
  }
  refreshTorrents()
}

$('#add-form').addEventListener('submit', e => {
  e.preventDefault()
  const v = $('#magnet').value.trim()
  if (v) addMagnet(v)
})
$('#pick-file').addEventListener('click', () => $('#file-input').click())
$('#file-input').addEventListener('change', e => {
  addFiles([...e.target.files])
  e.target.value = ''
})

// Paste a magnet anywhere on the downloads tab.
document.addEventListener('paste', e => {
  if (currentTab !== 'downloads' || e.target.closest('input, textarea')) return
  const text = e.clipboardData.getData('text').trim()
  if (/^magnet:\?/i.test(text)) {
    e.preventDefault()
    addMagnet(text)
  }
})

// Drag & drop .torrent files onto the page.
let dragDepth = 0
const overlay = $('#drop-overlay')
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files')
window.addEventListener('dragenter', e => { if (hasFiles(e)) { dragDepth++; overlay.classList.remove('hidden') } })
window.addEventListener('dragleave', e => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; overlay.classList.add('hidden') } })
window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault() })
window.addEventListener('drop', e => {
  if (!hasFiles(e)) return
  e.preventDefault()
  dragDepth = 0
  overlay.classList.add('hidden')
  showTab('downloads')
  addFiles([...e.dataTransfer.files])
})

// ---------- torrent list ----------

const STATUS_LABEL = {
  downloading: 'Загрузка',
  metadata: 'Получение метаданных',
  paused: 'На паузе',
  error: 'Ошибка',
  finishing: 'Завершение',
  active: 'Запуск'
}

function renderTorrent (t) {
  const pct = (t.progress * 100)
  const paused = t.status === 'paused' || t.status === 'error'
  const bar = h('div')
  bar.style.width = `${pct.toFixed(1)}%`

  const meta = []
  meta.push(h('span', { class: `status-pill ${t.status}`, text: STATUS_LABEL[t.status] || t.status }))
  if (t.length) meta.push(h('span', {}, h('b', { text: `${pct.toFixed(1)}%` }), ` · ${fmtBytes(t.downloaded)} из ${fmtBytes(t.length)}`))
  if (t.status === 'downloading') {
    meta.push(h('span', {}, '↓ ', h('b', { text: fmtSpeed(t.downloadSpeed) })))
    meta.push(h('span', {}, '↑ ', fmtSpeed(t.uploadSpeed)))
    meta.push(h('span', {}, 'Пиры: ', h('b', { text: t.peers })))
    meta.push(h('span', {}, 'Осталось: ', h('b', { text: t.downloadSpeed > 0 ? fmtEta(t.timeRemaining) : '—' })))
  } else if (t.status === 'metadata') {
    meta.push(h('span', {}, 'Пиры: ', h('b', { text: t.peers })))
  }

  const actions = h('div', { class: 't-actions' },
    t.status === 'finishing'
      ? null
      : paused
        ? iconBtn('play', 'Продолжить', () => control(t.id, 'resume'))
        : iconBtn('pause', 'Пауза', () => control(t.id, 'pause')),
    t.status === 'finishing' ? null : iconBtn('x', 'Отменить и удалить', () => cancelTorrent(t), 'danger')
  )

  return h('div', { class: `card torrent ${t.status}` },
    h('div', { class: 't-head' }, h('div', { class: 't-name', text: t.name }), actions),
    h('div', { class: 'progress' }, bar),
    h('div', { class: 't-meta' }, meta),
    t.error ? h('div', { class: 't-error', text: t.error }) : null
  )
}

function renderHistory (item) {
  return h('div', { class: 'card history-item' },
    h('div', { class: 'check' }, icon('check')),
    h('div', { class: 'h-body' },
      h('div', { class: 'h-name', text: item.name, title: item.name }),
      h('div', { class: 'h-meta', text: `${fmtBytes(item.length)} · ${fmtDate(item.completedAt)}` })
    ),
    iconBtn('open', 'Открыть в файлах', () => openInFiles(item)),
    iconBtn('x', 'Убрать из списка', async () => {
      await api('DELETE', `/api/history/${q(item.id)}`).catch(err => toast(err.message, 'error'))
      refreshTorrents()
    })
  )
}

function openInFiles (item) {
  // For a single top-level item, jump to its parent folder (the root) or into it if it's a folder.
  currentPath = ''
  showTab('files')
  if (item.path) {
    loadFiles('').then(list => {
      const entry = list?.items.find(i => i.path === item.path)
      if (entry?.type === 'dir') loadFiles(entry.path)
    })
  }
}

async function control (id, action) {
  try {
    await api('POST', `/api/torrents/${q(id)}/${action}`)
    refreshTorrents()
  } catch (err) {
    toast(err.message, 'error')
  }
}

async function cancelTorrent (t) {
  const ok = await confirmDialog('Отменить загрузку?', `«${t.name}» будет остановлен, а уже скачанные части — удалены.`, 'Отменить загрузку')
  if (!ok) return
  try {
    await api('DELETE', `/api/torrents/${q(t.id)}`)
    toast('Загрузка отменена')
    refreshTorrents()
  } catch (err) {
    toast(err.message, 'error')
  }
}

let lastHistoryCount = null

async function refreshTorrents () {
  let data
  try {
    data = await api('GET', '/api/torrents')
  } catch {
    return
  }
  const list = $('#torrent-list')
  list.replaceChildren(
    ...(data.torrents.length
      ? data.torrents.map(renderTorrent)
      : [h('div', { class: 'empty' }, icon('inbox'), h('div', { text: 'Нет активных загрузок. Вставьте magnet-ссылку выше.' }))])
  )

  $('#history-section').classList.toggle('hidden', !data.history.length)
  $('#history-list').replaceChildren(...data.history.map(renderHistory))

  const active = data.torrents.length
  $('#active-count').textContent = active
  $('#active-count').classList.toggle('hidden', !active)
  $('#total-down').textContent = `↓ ${fmtSpeed(data.totals.downloadSpeed)}`
  $('#total-up').textContent = `↑ ${fmtSpeed(data.totals.uploadSpeed)}`
  renderSeeding(data.settings, data.totals.uploadSpeed)
  document.title = active ? `(${active}) Web Torrent` : 'Web Torrent'

  if (lastHistoryCount !== null && data.history.length > lastHistoryCount) {
    toast(`Готово: ${data.history[0].name}`, 'ok')
    refreshDisk()
    if (currentTab === 'files') loadFiles(currentPath)
  }
  lastHistoryCount = data.history.length
}

$('#clear-history').addEventListener('click', async () => {
  await api('DELETE', '/api/history').catch(err => toast(err.message, 'error'))
  refreshTorrents()
})

// ---------- seeding ----------

// Slider positions -> KB/s (0 = unlimited)
const UPLOAD_STEPS = [10, 25, 50, 100, 250, 500, 1024, 2048, 5120, 10240, 0]
let seedSettings = null
let seedDirty = false // user is interacting; don't overwrite from polling

const fmtLimit = kb => (kb === 0 ? 'без лимита' : fmtSpeed(kb * 1024))

function stepIndexFor (kb) {
  if (kb === 0) return UPLOAD_STEPS.length - 1
  let best = 0
  UPLOAD_STEPS.forEach((v, i) => { if (v && Math.abs(v - kb) < Math.abs(UPLOAD_STEPS[best] - kb)) best = i })
  return best
}

function renderSeeding (settings, uploadSpeed) {
  $('#seed-speed').textContent = fmtSpeed(uploadSpeed || 0)
  if (!settings || seedDirty) return
  seedSettings = settings
  $('#seed-card').classList.toggle('on', settings.seeding)
  $('#seed-toggle').checked = settings.seeding
  $('#seed-state').textContent = settings.seeding ? 'включена' : 'выключена'
  $('#seed-hint').textContent = settings.seeding
    ? 'Сервер отдаёт части скачиваемых торрентов. После завершения загрузки раздача всё равно останавливается.'
    : 'Сервер только скачивает и ничего не отдаёт другим пирам.'
  $('#seed-range').value = stepIndexFor(settings.uploadLimitKB)
  $('#seed-range').disabled = !settings.seeding
  $('#seed-limit-label').textContent = fmtLimit(settings.uploadLimitKB)
}

async function saveSeeding (patch) {
  try {
    const s = await api('PUT', '/api/settings', patch)
    seedDirty = false
    renderSeeding(s)
  } catch (err) {
    seedDirty = false
    toast(err.message, 'error')
    refreshTorrents()
  }
}

$('#seed-toggle').addEventListener('change', e => {
  seedDirty = true
  saveSeeding({ seeding: e.target.checked }).then(() => {
    toast(e.target.checked ? 'Раздача включена' : 'Раздача выключена')
  })
})
$('#seed-range').addEventListener('input', e => {
  seedDirty = true
  $('#seed-limit-label').textContent = fmtLimit(UPLOAD_STEPS[e.target.value])
})
$('#seed-range').addEventListener('change', e => {
  saveSeeding({ uploadLimitKB: UPLOAD_STEPS[e.target.value] })
})

// ---------- disk ----------

async function refreshDisk () {
  try {
    const d = await api('GET', '/api/disk')
    const used = d.total - d.free
    const pct = d.total ? used / d.total : 0
    $('#disk-text').textContent = `Свободно ${fmtBytes(d.free)} из ${fmtBytes(d.total)}`
    const bar = $('#disk-bar')
    bar.firstElementChild.style.width = `${(pct * 100).toFixed(1)}%`
    bar.classList.toggle('warn', pct > 0.8 && pct <= 0.93)
    bar.classList.toggle('crit', pct > 0.93)
  } catch {}
}

// ---------- files ----------

let currentPath = ''

function renderCrumbs (p) {
  const parts = p ? p.split('/') : []
  const crumbs = [h('button', { text: 'Загрузки', onclick: () => loadFiles('') })]
  parts.forEach((part, i) => {
    const target = parts.slice(0, i + 1).join('/')
    crumbs.push(h('span', { class: 'sep', text: '/' }))
    crumbs.push(h('button', { text: part, title: part, onclick: () => loadFiles(target) }))
  })
  $('#crumbs').replaceChildren(...crumbs)
}

function renderFile (item) {
  const playable = item.kind === 'video' || item.kind === 'audio'
  const open = item.type === 'dir' ? () => loadFiles(item.path) : playable ? () => play(item) : null
  const iconName = item.type === 'dir' ? 'folder' : item.kind === 'video' ? 'video' : item.kind === 'audio' ? 'audio' : 'file'

  return h('div', { class: `file-row ${open ? 'clickable' : ''}` },
    h('div', { class: `file-icon ${item.kind}` }, icon(iconName)),
    h('div', { class: 'file-main', onclick: open },
      h('div', { class: 'file-name', text: item.name, title: item.name }),
      h('div', { class: 'file-meta', text: `${fmtBytes(item.size)} · ${fmtDate(item.mtime)}` })
    ),
    h('div', { class: 'file-actions' },
      playable ? iconBtn('play', 'Смотреть', () => play(item)) : null,
      iconBtn('download', item.type === 'dir' ? 'Скачать папку (zip)' : 'Скачать', () => download(item.path)),
      iconBtn('link', 'Прямая ссылка', () => share(item.path)),
      iconBtn('trash', 'Удалить', () => deleteFile(item), 'danger')
    )
  )
}

async function loadFiles (p) {
  try {
    const data = await api('GET', `/api/files?path=${q(p)}`)
    currentPath = data.path
    renderCrumbs(data.path)
    $('#file-list').classList.toggle('card', !!data.items.length)
    $('#file-list').replaceChildren(
      ...(data.items.length
        ? data.items.map(renderFile)
        : [h('div', { class: 'empty' }, icon('folder'), h('div', { text: 'Здесь пока пусто' }))])
    )
    return data
  } catch (err) {
    toast(err.message, 'error')
    if (p) return loadFiles('')
  }
}

function download (p) {
  // A plain navigation lets the browser handle the download (with resume support for files).
  const a = h('a', { href: `/api/download?path=${q(p)}`, download: '' })
  document.body.append(a)
  a.click()
  a.remove()
}

async function deleteFile (item) {
  const what = item.type === 'dir' ? 'Папка и всё её содержимое будут удалены' : 'Файл будет удалён'
  const ok = await confirmDialog(`Удалить «${item.name}»?`, `${what} с сервера безвозвратно (${fmtBytes(item.size)}).`)
  if (!ok) return
  try {
    await api('DELETE', `/api/files?path=${q(item.path)}`)
    toast('Удалено')
    loadFiles(currentPath)
    refreshDisk()
  } catch (err) {
    toast(err.message, 'error')
  }
}

$('#refresh-files').addEventListener('click', () => { loadFiles(currentPath); refreshDisk() })
$('#download-folder').addEventListener('click', () => download(currentPath))

// ---------- share links ----------

let sharePath = null

async function makeShareLink (hours) {
  const { url } = await api('POST', '/api/share', { path: sharePath, hours })
  return location.origin + url
}

async function share (p) {
  sharePath = p
  const dlg = $('#share-dlg')
  $('#share-url').value = 'Создаю ссылку…'
  for (const b of document.querySelectorAll('#share-ttl button')) b.classList.toggle('active', b.dataset.hours === '24')
  if (!dlg.open) dlg.showModal()
  try {
    $('#share-url').value = await makeShareLink(24)
  } catch (err) {
    toast(err.message, 'error')
    dlg.close()
  }
}

for (const b of document.querySelectorAll('#share-ttl button')) {
  b.addEventListener('click', async () => {
    for (const x of document.querySelectorAll('#share-ttl button')) x.classList.toggle('active', x === b)
    try {
      $('#share-url').value = await makeShareLink(Number(b.dataset.hours))
    } catch (err) {
      toast(err.message, 'error')
    }
  })
}

async function copyText (text) {
  try {
    await navigator.clipboard.writeText(text)
    toast('Скопировано', 'ok')
  } catch {
    toast('Не удалось скопировать — выделите и скопируйте вручную', 'error')
  }
}

$('#share-copy').addEventListener('click', () => {
  $('#share-url').select()
  copyText($('#share-url').value)
})

// ---------- player ----------

let playing = null

function play (item) {
  playing = item
  const dlg = $('#player-dlg')
  const media = h(item.kind === 'audio' ? 'audio' : 'video', {
    controls: true,
    autoplay: true,
    preload: 'metadata',
    playsinline: true,
    src: `/api/stream?path=${q(item.path)}`
  })
  media.addEventListener('error', () => $('#player-note').classList.add('error'))
  $('#player-title').textContent = item.name
  $('#player-slot').replaceChildren(media)
  dlg.showModal()
}

function stopPlayer () {
  const media = $('#player-slot').firstElementChild
  if (media) {
    media.pause()
    media.removeAttribute('src')
    media.load()
  }
  $('#player-slot').replaceChildren()
}

$('#player-close').addEventListener('click', () => $('#player-dlg').close())
$('#player-dlg').addEventListener('close', stopPlayer)
$('#player-link').addEventListener('click', () => {
  if (!playing) return
  $('#player-dlg').close()
  share(playing.path)
})

// ---------- kinozal search ----------

let kz = null // status
let kzMovies = []
let kzMovie = null // { movie, releases }
let kzSort = { key: 'score', dir: -1 }

const loadingEl = text => h('div', { class: 'loading' }, h('div', { class: 'spinner' }), h('div', { text }))
const kzLink = id => kz ? `${kz.baseUrl}/details.php?id=${encodeURIComponent(id)}` : '#'
const resLabel = r => r ? (r === 2160 ? '4K' : `${r}p`) : null

async function loadKinozalStatus () {
  try {
    kz = await api('GET', '/api/kinozal/status')
  } catch {
    return
  }
  $('#kz-setup').classList.toggle('hidden', kz.configured)
  const dot = $('#kz-dot')
  dot.classList.toggle('ok', kz.configured && kz.loggedIn)
  dot.classList.toggle('bad', kz.configured && !kz.loggedIn)
}

function openKinozalSettings () {
  const s = kz || { baseUrl: 'https://kinozal.guru' }
  $('#kz-base').value = s.baseUrl || ''
  $('#kz-user').value = s.username || ''
  $('#kz-pass').value = ''
  $('#kz-pass').placeholder = s.hasPassword ? 'Сохранён — оставьте пустым, чтобы не менять' : ''
  $('#kz-cookies').value = ''
  $('#kz-cfg-status').textContent = !s.configured
    ? 'Не подключено'
    : s.loggedIn
      ? `Подключено${s.username ? ' как ' + s.username : ''}${s.mode === 'browser' ? ' (через встроенный браузер)' : ''}`
      : 'Вход не выполнен — проверьте данные'
  $('#kz-dlg').showModal()
}

$('#kz-settings-btn').addEventListener('click', openKinozalSettings)
$('#kz-setup-btn').addEventListener('click', openKinozalSettings)
$('#kz-cancel').addEventListener('click', () => $('#kz-dlg').close())

$('#kz-cfg-form').addEventListener('submit', async e => {
  e.preventDefault()
  const btn = $('#kz-save')
  btn.disabled = true
  $('#kz-cfg-status').textContent = 'Вхожу на Kinozal… (первый раз может занять до минуты)'
  const body = { baseUrl: $('#kz-base').value.trim() || 'https://kinozal.guru', username: $('#kz-user').value.trim() }
  if ($('#kz-pass').value) body.password = $('#kz-pass').value
  if ($('#kz-cookies').value.trim()) body.cookies = $('#kz-cookies').value.trim()
  try {
    kz = await api('PUT', '/api/kinozal/config', body)
    toast('Kinozal подключён', 'ok')
    $('#kz-dlg').close()
  } catch (err) {
    $('#kz-cfg-status').textContent = err.message
  } finally {
    btn.disabled = false
    loadKinozalStatus()
  }
})

$('#kz-forget').addEventListener('click', async () => {
  await api('POST', '/api/kinozal/logout').catch(err => toast(err.message, 'error'))
  $('#kz-dlg').close()
  loadKinozalStatus()
})

$('#kz-form').addEventListener('submit', async e => {
  e.preventDefault()
  const q = $('#kz-query').value.trim()
  if (!q) return
  if (kz && !kz.configured) return openKinozalSettings()
  showKzResults()
  $('#kz-results').replaceChildren(loadingEl('Ищу на Kinozal…'))
  $('#kz-search-btn').disabled = true
  try {
    const data = await api('GET', `/api/kinozal/search?q=${q_(q)}`)
    kzMovies = data.movies
    renderKzResults()
  } catch (err) {
    $('#kz-results').replaceChildren(h('div', { class: 'empty', text: err.message }))
  } finally {
    $('#kz-search-btn').disabled = false
    loadKinozalStatus()
  }
})

function q_ (s) { return encodeURIComponent(s) }

function showKzResults () {
  $('#kz-results').classList.remove('hidden')
  $('#kz-movie').classList.add('hidden')
}

function renderKzResults () {
  if (!kzMovies.length) {
    $('#kz-results').replaceChildren(h('div', { class: 'empty', text: 'Ничего не найдено' }))
    return
  }
  $('#kz-results').replaceChildren(h('div', { class: 'list' }, kzMovies.map(m => {
    const b = m.best
    return h('div', { class: 'card movie-card', onclick: () => openMovie(m) },
      h('div', { class: 'movie-title', text: m.title }),
      h('div', { class: 'movie-sub', text: [m.altTitles.join(' / '), m.year].filter(Boolean).join(' · ') }),
      h('div', { class: 'chips' },
        h('span', { class: 'chip', text: `${m.count} ${plural(m.count, 'раздача', 'раздачи', 'раздач')}` }),
        h('span', { class: 'chip', text: `до ${m.maxSeeds} сидов` }),
        m.resolutions.map(r => h('span', { class: 'chip res', text: resLabel(r) })),
        m.hasGold ? h('span', { class: 'chip gold', text: '★ золотая' }) : null
      ),
      b ? h('div', { class: 'movie-sub', text: `Лучшая здесь: ${fmtBytes(b.size)} · ${resLabel(b.resolution) || '?'} · ${b.seeds} сидов` }) : null
    )
  })))
}

function plural (n, one, few, many) {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}

async function openMovie (m) {
  $('#kz-results').classList.add('hidden')
  const view = $('#kz-movie')
  view.classList.remove('hidden')
  view.replaceChildren(backBtn(), loadingEl('Ищу все раздачи этого фильма…'))
  window.scrollTo({ top: 0 })
  const params = new URLSearchParams({ title: m.title, year: m.year || '' })
  for (const a of m.altTitles) params.append('alt', a)
  try {
    kzMovie = await api('GET', `/api/kinozal/movie?${params}`)
    kzSort = { key: 'score', dir: -1 }
    renderMovie()
  } catch (err) {
    view.replaceChildren(backBtn(), h('div', { class: 'empty', text: err.message }))
  }
}

function backBtn () {
  return h('button', { class: 'btn ghost back-btn', text: '← К результатам', onclick: showKzResults })
}

async function kzDownload (r, mode, btn) {
  if (btn) btn.disabled = true
  try {
    const t = await api('POST', '/api/kinozal/download', { id: r.id, name: r.name, mode })
    toast(`Загрузка добавлена${t.via === 'magnet' ? ' (magnet)' : ' (.torrent)'}: ${t.name}`, 'ok')
    refreshTorrents()
  } catch (err) {
    toast(err.message, 'error')
  } finally {
    if (btn) btn.disabled = false
  }
}

function releaseChips (r) {
  return h('div', { class: 'chips' },
    r.reasons.map(x => h('span', { class: `chip ${x === 'золотая' ? 'gold' : 'good'}`, text: x === 'золотая' ? '★ золотая' : x })),
    r.warnings.map(x => h('span', { class: 'chip warn', text: x }))
  )
}

function renderMovie () {
  const { movie, releases } = kzMovie
  const view = $('#kz-movie')
  const best = releases[0]
  const head = h('div', { class: 'movie-head' },
    h('h2', { text: movie.title }),
    h('div', { class: 'movie-sub', text: [movie.altTitles.join(' / '), movie.year, `${releases.length} ${plural(releases.length, 'раздача', 'раздачи', 'раздач')}`].filter(Boolean).join(' · ') })
  )
  if (!best) {
    view.replaceChildren(backBtn(), head, h('div', { class: 'empty', text: 'Раздачи не найдены' }))
    return
  }

  const dlBtn = h('button', { class: 'btn primary' }, icon('download'), 'Скачать')
  dlBtn.addEventListener('click', () => kzDownload(best, 'magnet', dlBtn))
  const torBtn = h('button', { class: 'btn', text: 'Через .torrent', title: 'Если magnet долго не стартует' })
  torBtn.addEventListener('click', () => kzDownload(best, 'torrent', torBtn))

  const bestCard = h('div', { class: 'card best-card' },
    h('div', { class: 'best-label', text: 'Лучший вариант' }),
    h('div', { class: 'best-name', text: best.name }),
    h('div', { class: 'best-meta' },
      h('b', { text: fmtBytes(best.size) }), ' · сиды ', h('b', { text: best.seeds }), ' · пиры ', h('b', { text: best.peers }),
      best.date ? ` · ${best.date}` : ''
    ),
    releaseChips(best),
    h('div', { class: 'best-actions' }, dlBtn, torBtn,
      h('a', { href: kzLink(best.id), target: '_blank', rel: 'noopener noreferrer', text: 'Открыть на Kinozal ↗' }))
  )

  const cols = [
    { key: 'gold', label: '★' },
    { key: 'name', label: 'Раздача' },
    { key: 'size', label: 'Размер', num: true },
    { key: 'seeds', label: 'Сиды', num: true },
    { key: 'peers', label: 'Пиры', num: true },
    { key: 'score', label: 'Оценка', num: true }
  ]
  const sorted = [...releases].sort((a, b) => {
    const k = kzSort.key
    const av = a[k]
    const bv = b[k]
    const c = typeof av === 'string' ? av.localeCompare(bv) : (Number(av) - Number(bv))
    return c * kzSort.dir
  })
  const table = h('table', { class: 'rel-table' },
    h('thead', {}, h('tr', {}, cols.map(c => h('th', {
      class: `${c.num ? 'num' : ''} ${kzSort.key === c.key ? 'sorted' : ''}`,
      text: c.label + (kzSort.key === c.key ? (kzSort.dir < 0 ? ' ↓' : ' ↑') : ''),
      onclick: () => {
        kzSort = kzSort.key === c.key ? { key: c.key, dir: -kzSort.dir } : { key: c.key, dir: c.key === 'name' ? 1 : -1 }
        renderMovie()
      }
    })), h('th', {}))),
    h('tbody', {}, sorted.map(r => {
      const b = iconBtn('download', 'Скачать', () => kzDownload(r, 'magnet', b))
      return h('tr', { class: r === best ? 'is-best' : '' },
        h('td', { class: 'gold-star', title: r.gold ? 'Золотая раздача' : '', text: r.gold ? '★' : '' }),
        h('td', { class: 'rel-name' },
          h('a', { href: kzLink(r.id), target: '_blank', rel: 'noopener noreferrer', text: r.name }),
          r.resolution ? h('span', { class: 'chip res', text: resLabel(r.resolution) }) : null),
        h('td', { class: 'num', 'data-label': 'Размер', text: fmtBytes(r.size) }),
        h('td', { class: 'num seeds', 'data-label': 'Сиды', text: r.seeds }),
        h('td', { class: 'num', 'data-label': 'Пиры', text: r.peers }),
        h('td', { class: 'num', 'data-label': 'Оценка', text: Math.round(r.score) }),
        h('td', { class: 'rel-actions' }, b)
      )
    }))
  )

  view.replaceChildren(backBtn(), head, bestCard,
    h('div', { class: 'section-title' }, h('span', { text: 'Все варианты' })),
    h('div', { class: 'card' }, table))
}

// ---------- misc ----------

$('#logout').addEventListener('click', async () => {
  await api('POST', '/api/logout').catch(() => {})
  location.href = '/login'
})

// Close dialogs by clicking the backdrop.
for (const dlg of document.querySelectorAll('dialog')) {
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close() })
}

// ---------- boot ----------

let initialTab = 'downloads'
try { initialTab = localStorage.getItem('tab') || 'downloads' } catch {}
showTab(['files', 'search'].includes(initialTab) ? initialTab : 'downloads')
refreshTorrents()
refreshDisk()
setInterval(() => { if (!document.hidden) refreshTorrents() }, 1500)
setInterval(() => { if (!document.hidden) refreshDisk() }, 30000)
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshTorrents() })
