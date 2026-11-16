/**
 * JM Reader Web · 前端逻辑
 * 原生 ES 模块，无构建步骤。
 */

const $ = (sel, root = document) => root.querySelector(sel)
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]

const OPEN_GROUPS_KEY = 'jm-open-groups'

/** 记住哪些作品是展开的，刷新后不用重新点。 */
function loadOpenGroups() {
  try {
    const raw = JSON.parse(store.get(OPEN_GROUPS_KEY) || '[]')
    return new Set(Array.isArray(raw) ? raw.map(String).slice(-40) : [])
  } catch {
    return new Set()
  }
}

function saveOpenGroups() {
  store.set(OPEN_GROUPS_KEY, JSON.stringify([...state.openGroups].slice(-40)))
}

/**
 * localStorage 在「隐私模式 / 禁用站点数据 / 某些内嵌浏览器」下会直接抛异常。
 * 一旦在模块顶层抛了，整个 app.js 就不再执行 —— 页面表现就是骨架出来了、
 * 三个统计一直是「–」、点哪儿都没反应。所以所有读写都兜一层。
 */
const store = {
  get(key) {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value)
    } catch {
      /* 存不下就算了，不影响本次使用 */
    }
  },
}

// 兜底：脚本出错时给个看得见的提示，而不是让页面静默变成「什么都点不动」
window.addEventListener('error', (event) => {
  console.error('[jm] 页面脚本出错', event.error || event.message)
  const box = document.getElementById('toasts')
  if (!box) return
  const node = document.createElement('div')
  node.className = 'toast err'
  node.textContent = `页面脚本出错：${event.message || '未知错误'}`
  box.appendChild(node)
})

const el = {
  gate: $('#gate'),
  gateOk: $('#gate-ok'),
  gateClose: $('#gate-close'),
  form: $('#search-form'),
  q: $('#q'),
  grid: $('#grid'),
  empty: $('#empty'),
  emptyText: $('#empty-text'),
  chips: $('#chips'),
  hero: $('#hero'),
  resultsHead: $('#results-head'),
  resultsTitle: $('#results-title'),
  resultsMeta: $('#results-meta'),
  pager: $('#pager'),
  pageInfo: $('#page-info'),
  prev: $('#prev-page'),
  next: $('#next-page'),
  scrim: $('#scrim'),
  drawer: $('#drawer'),
  drawerBody: $('#drawer-body'),
  drawerClose: $('#drawer-close'),
  tasks: $('#tasks'),
  tasksBody: $('#tasks-body'),
  tasksClose: $('#tasks-close'),
  btnTasks: $('#btn-tasks'),
  btnSettings: $('#btn-settings'),
  taskBadge: $('#task-badge'),
  modalScrim: $('#modal-scrim'),
  settings: $('#settings'),
  settingsClose: $('#settings-close'),
  settingsCancel: $('#settings-cancel'),
  settingsSave: $('#settings-save'),
  setProxy: $('#set-proxy'),
  setMode: $('#set-mode'),
  setConcurrency: $('#set-concurrency'),
  setQuality: $('#set-quality'),
  setMaxPages: $('#set-maxpages'),
  setEncrypt: $('#set-encrypt'),
  setPassword: $('#set-password'),
  testProxy: $('#btn-test-proxy'),
  testResult: $('#test-result'),
  authScrim: $('#auth-scrim'),
  auth: $('#auth'),
  authInput: $('#auth-input'),
  authSubmit: $('#auth-submit'),
  authError: $('#auth-error'),
  toasts: $('#toasts'),
  statCache: $('#stat-cache'),
  statJobs: $('#stat-jobs'),
  statProxy: $('#stat-proxy'),
  heroStats: $('#hero-stats'),
}

const state = {
  token: store.get('jm-token') || '',
  authOpen: false,
  query: '',
  page: 1,
  totalPages: 1,
  album: null,
  from: 1,
  to: 1,
  split: 'single',
  encrypt: 'none',
  password: '',
  config: null,
  jobs: new Map(),
  cacheItems: [],
  cacheSig: '',
  openGroups: loadOpenGroups(),
  seq: 0,
  slowHint: 0,
}

// 支持用 ?token=口令 分享直达链接：取一次即存本地，并把地址栏里的口令抹掉，
// 避免留在浏览器历史、截图和后续请求的 Referer 里。
;(() => {
  const url = new URL(location.href)
  const fromUrl = url.searchParams.get('token')
  if (!fromUrl) return
  state.token = fromUrl
  store.set('jm-token', fromUrl)
  url.searchParams.delete('token')
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
})()

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function toast(message, type = '') {
  const node = document.createElement('div')
  node.className = `toast ${type}`
  node.textContent = message
  el.toasts.appendChild(node)
  setTimeout(() => {
    node.style.transition = 'opacity .25s, transform .25s'
    node.style.opacity = '0'
    node.style.transform = 'translateY(8px)'
    setTimeout(() => node.remove(), 260)
  }, type === 'err' ? 5000 : 2800)
}

// 所有请求都带超时：后端要是卡在主机发现/生成 PDF，界面得给个说法，
// 而不是让三个统计数字一直停在「–」。
const DEFAULT_TIMEOUT = 15000

async function api(path, { method = 'GET', body, timeout = DEFAULT_TIMEOUT } = {}) {
  const url = new URL(path, location.origin)
  if (state.token) url.searchParams.set('token', state.token)

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    let res
    try {
      res = await fetch(url, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(state.token ? { 'x-token': state.token } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      })
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new Error(`服务器 ${Math.round(timeout / 1000)} 秒没有响应，可能正在生成 PDF 或网络不通`)
      }
      throw new Error('连不上后端服务，请确认它还在运行')
    }

    const data = await res.json().catch(() => ({}))
    if (res.status === 401) {
      openAuth()
      throw new Error('需要访问口令')
    }
    if (!res.ok || data.ok === false) throw new Error(data.error || `请求失败（HTTP ${res.status}）`)
    return data
  } finally {
    clearTimeout(timer)
  }
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/** 顶部统计的安全写法：失败时标黄，提示「可以点一下重试」。 */
function setStat(node, text, tone = '') {
  if (!node) return
  node.textContent = text
  node.classList.toggle('warn', tone === 'warn')
}

function setProxyStat() {
  const c = state.config
  if (!c) return setStat(el.statProxy, '未连接', 'warn')
  setStat(el.statProxy, c.proxy ? (c.proxyMode === 'off' ? '已禁用' : '代理') : '直连')
}

const fmtSize = (bytes) => {
  if (!bytes) return '—'
  const mb = bytes / 1024 / 1024
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

const fmtNum = (n) => {
  const v = Number(n) || 0
  if (v >= 1e8) return `${(v / 1e8).toFixed(1)} 亿`
  if (v >= 1e4) return `${(v / 1e4).toFixed(1)} 万`
  return String(v)
}

// ---------------------------------------------------------------------------
// 18+ 门槛
// ---------------------------------------------------------------------------

const GATE_KEY = 'jm-gate-accepted'
// 判断「是否已同意」必须看存储，不能看 el.gate.hidden：
// 刷新后 index.html 头部的内联脚本会给 <html> 加 gate-passed，门禁是被 CSS 隐藏的，
// DOM 上的 hidden 属性一直是 false —— 之前拿它做判断，导致刷新后 boot() 一次都不执行，
// 页面永远停在三个「–」上（第一次点「进入」时反而正常，所以很难复现）。
const gateAccepted = store.get(GATE_KEY) === '1'
el.gate.hidden = gateAccepted

el.gateOk?.addEventListener('click', () => {
  store.set(GATE_KEY, '1')
  el.gate.hidden = true
  document.documentElement.classList.add('gate-passed')
  boot()
})
el.gateClose?.addEventListener('click', () => {
  location.href = 'about:blank'
})

// ---------------------------------------------------------------------------
// 访问口令（服务端以 --token 启动时才会出现）
// ---------------------------------------------------------------------------

function openAuth() {
  if (state.authOpen) return
  state.authOpen = true
  el.authScrim.hidden = false
  requestAnimationFrame(() => el.authScrim.classList.add('show'))
  el.auth.classList.add('open')
  el.auth.setAttribute('aria-hidden', 'false')
  setTimeout(() => el.authInput?.focus(), 60)
}

function closeAuth() {
  state.authOpen = false
  el.authScrim.classList.remove('show')
  el.auth.classList.remove('open')
  el.auth.setAttribute('aria-hidden', 'true')
  setTimeout(() => {
    if (!state.authOpen) el.authScrim.hidden = true
  }, 220)
}

async function submitAuth() {
  const value = el.authInput.value.trim()
  if (!value) {
    el.authError.innerHTML = '<div class="bad">请输入口令</div>'
    return
  }
  const prev = state.token
  el.authSubmit.disabled = true
  el.authError.innerHTML = ''
  state.token = value
  try {
    await api('/api/config', { timeout: 8000 }) // 只用于校验口令
    store.set('jm-token', value)
    closeAuth()
    toast('口令正确，已保存到本机', 'ok')
    await warmUp()
  } catch (err) {
    state.token = prev
    // 401 会被 api() 统一成「需要访问口令」，在弹窗里应表述为口令错误；
    // 429（失败次数过多）等其它错误保留服务端原文，避免误导。
    const raw = err?.message || ''
    const msg = !raw || /需要访问口令/.test(raw) ? '口令不正确，请重试' : raw
    el.authError.innerHTML = `<div class="bad">${esc(msg)}</div>`
    el.authInput.select()
  } finally {
    el.authSubmit.disabled = false
  }
}

el.authSubmit?.addEventListener('click', submitAuth)
el.authInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitAuth()
})

// ---------------------------------------------------------------------------
// 搜索与列表
// ---------------------------------------------------------------------------

function renderSkeletons(n = 12) {
  el.empty.hidden = true
  el.pager.hidden = true
  el.resultsHead.hidden = true
  el.grid.innerHTML = Array.from({ length: n }, () => '<div class="skeleton"></div>').join('')
}

function renderEmpty(text, showChips = false) {
  el.grid.innerHTML = ''
  el.pager.hidden = true
  el.resultsHead.hidden = true
  el.empty.hidden = false
  el.emptyText.textContent = text
  el.chips.hidden = !showChips
}

function renderGrid(items, meta) {
  if (!items.length) return renderEmpty('没有找到相关作品，换个关键词试试')

  el.empty.hidden = true
  el.resultsHead.hidden = false
  el.resultsTitle.textContent = meta?.title || '搜索结果'
  el.resultsMeta.textContent = meta?.sub || ''

  el.grid.innerHTML = items
    .map(
      (it, i) => `
      <article class="card" data-id="${esc(it.id)}" style="animation-delay:${Math.min(i * 22, 320)}ms">
        <span class="card-id">JM${esc(it.id)}</span>
        <img src="${esc(it.cover)}" alt="" loading="lazy" decoding="async"
             onerror="this.style.opacity='.25';this.removeAttribute('src')" />
        <div class="card-body">
          <div class="card-title">${esc(it.name)}</div>
          <div class="card-author">${esc(it.author || '佚名')}</div>
        </div>
      </article>`,
    )
    .join('')
}

async function doSearch(q, page = 1) {
  const query = String(q || '').trim()
  if (!query) {
    renderEmpty('输入关键词或 JM 号开始', true)
    return
  }
  state.query = query
  state.page = page
  const token = ++state.seq
  document.body.classList.add('searching')
  renderSkeletons()

  // 首次搜索要发现镜像主机，慢是正常的；但要让人知道「在等什么」
  const hint = setTimeout(() => {
    if (token === state.seq && state.slowHint !== token) {
      state.slowHint = token
      toast('正在连接镜像站，首次可能需要 10 秒左右…')
    }
  }, 4000)

  try {
    const data = await api(`/api/search?q=${encodeURIComponent(query)}&page=${page}`, { timeout: 45000 })
    if (token !== state.seq) return

    if (data.redirectAid) {
      el.grid.innerHTML = ''
      el.empty.hidden = true
      openDetail(data.redirectAid)
      return
    }

    state.totalPages = data.totalPages || 1
    renderGrid(data.items, {
      title: `“${data.query}”`,
      sub: `共 ${fmtNum(data.total)} 条 · 第 ${data.page}/${data.totalPages} 页`,
    })

    el.pager.hidden = state.totalPages <= 1
    el.pageInfo.textContent = `${data.page} / ${data.totalPages}`
    el.prev.disabled = data.page <= 1
    el.next.disabled = data.page >= data.totalPages

    window.scrollTo({ top: 0, behavior: 'smooth' })
  } catch (err) {
    if (token === state.seq) renderEmpty(err.message)
  } finally {
    clearTimeout(hint)
    if (token === state.seq) document.body.classList.remove('searching')
  }
}

el.form.addEventListener('submit', (e) => {
  e.preventDefault()
  doSearch(el.q.value, 1)
  el.q.blur()
})

el.chips.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip')
  if (!chip) return
  el.q.value = chip.dataset.q
  doSearch(chip.dataset.q, 1)
})

el.grid.addEventListener('click', (e) => {
  const card = e.target.closest('.card')
  if (card) openDetail(card.dataset.id)
})

el.prev.addEventListener('click', () => doSearch(state.query, Math.max(1, state.page - 1)))
el.next.addEventListener('click', () => doSearch(state.query, Math.min(state.totalPages, state.page + 1)))

// ---------------------------------------------------------------------------
// 详情抽屉
// ---------------------------------------------------------------------------

function openScrim() {
  el.scrim.hidden = false
  requestAnimationFrame(() => el.scrim.classList.add('show'))
  document.body.classList.add('locked')
}

function closeScrim() {
  el.scrim.classList.remove('show')
  document.body.classList.remove('locked')
  setTimeout(() => {
    if (!el.drawer.classList.contains('open')) el.scrim.hidden = true
  }, 300)
}

async function openDetail(id) {
  el.drawer.classList.add('open')
  el.drawer.setAttribute('aria-hidden', 'false')
  openScrim()
  el.drawerBody.innerHTML = `<div style="padding:26px 22px;display:grid;gap:16px">
    <div class="skeleton" style="width:116px;aspect-ratio:3/4;height:auto"></div>
    <div class="skeleton" style="height:20px;width:70%;aspect-ratio:auto"></div>
    <div class="skeleton" style="height:14px;width:40%;aspect-ratio:auto"></div>
  </div>`

  try {
    const { album } = await api(`/api/album?id=${encodeURIComponent(id)}`, { timeout: 30000 })
    state.album = album
    // 默认整本；多章默认分章打包（大作品合并成一个 PDF 容易崩）
    state.from = album.series[0]?.sort ?? 1
    state.to = album.series[album.series.length - 1]?.sort ?? 1
    state.split = album.series.length > 1 ? 'zip' : 'single'
    state.encrypt = state.config?.encrypt || 'none'
    state.password = state.config?.password || ''
    renderDetail(album)
  } catch (err) {
    el.drawerBody.innerHTML = `<div class="empty"><p>${esc(err.message)}</p></div>`
  }
}

function renderDetail(album) {
  const chapterCount = album.series.length
  const badges = [
    `<span class="pill accent">JM${esc(album.id)}</span>`,
    `<span class="pill">${chapterCount} 章</span>`,
    album.totalPages ? `<span class="pill">约 ${album.totalPages} 页</span>` : '',
    album.likes ? `<span class="pill">${fmtNum(album.likes)} 赞</span>` : '',
    album.totalViews ? `<span class="pill">${fmtNum(album.totalViews)} 浏览</span>` : '',
  ]
    .filter(Boolean)
    .join('')

  const chapterOptions = album.series
    .map(
      (s) =>
        `<option value="${s.sort}">第${s.sort}章 · ${esc(s.name)}${s.totalPage ? ` (${s.totalPage}P)` : ''}</option>`,
    )
    .join('')

  const tagHtml = (album.tags || [])
    .slice(0, 8)
    .map((t) => `<span class="tag">${esc(t)}</span>`)
    .join('')

  el.drawerBody.innerHTML = `
    <div class="detail-hero">
      <div class="detail-cover"><img src="${esc(album.cover)}" alt="" onerror="this.style.display='none'" /></div>
      <div class="detail-meta">
        <h2 class="detail-title">${esc(album.name)}</h2>
        <p class="detail-author">${esc((album.authors || []).join(' / ') || '佚名')}</p>
        <div class="detail-badges">${badges}</div>
      </div>
    </div>

    ${album.description ? `<p class="detail-desc" id="desc">${esc(album.description)}</p>` : ''}
    ${tagHtml ? `<div class="tag-row">${tagHtml}</div>` : ''}

    <div class="section">
      <h3 class="section-title">下载范围 <span id="range-hint">整本</span></h3>
      <div class="range-row">
        <label class="range-field">
          <span>从</span>
          <select id="ch-from">${chapterOptions}</select>
        </label>
        <label class="range-field">
          <span>到</span>
          <select id="ch-to">${chapterOptions}</select>
        </label>
      </div>
    </div>

    <div class="section">
      <h3 class="section-title">输出方式</h3>
      <div class="radio-group" id="split-group">
        <label class="radio ${state.split === 'zip' ? 'checked' : ''}">
          <input type="radio" name="split" value="zip" ${state.split === 'zip' ? 'checked' : ''} />
          <span>每章一个 PDF，打包 ZIP <small>同一作品一个文件夹，按章节顺序编号</small></span>
        </label>
        <label class="radio ${state.split === 'single' ? 'checked' : ''}">
          <input type="radio" name="split" value="single" ${state.split === 'single' ? 'checked' : ''} />
          <span>合并成一个 PDF <small>单文件上限 350 页</small></span>
        </label>
      </div>
    </div>

    <div class="section">
      <h3 class="section-title">PDF 加密</h3>
      <div class="radio-group" id="encrypt-group">
        <label class="radio ${state.encrypt === 'none' ? 'checked' : ''}">
          <input type="radio" name="enc" value="none" ${state.encrypt === 'none' ? 'checked' : ''} />
          <span>不加密 <small>打开即读</small></span>
        </label>
        <label class="radio ${state.encrypt === 'id' ? 'checked' : ''}">
          <input type="radio" name="enc" value="id" ${state.encrypt === 'id' ? 'checked' : ''} />
          <span>用 JM 号作密码 <small>密码 = ${esc(album.id)}</small></span>
        </label>
        <label class="radio ${state.encrypt === 'custom' ? 'checked' : ''}">
          <input type="radio" name="enc" value="custom" ${state.encrypt === 'custom' ? 'checked' : ''} />
          <span>自定义密码</span>
        </label>
      </div>
      <div class="password-row" id="password-wrap" ${state.encrypt === 'custom' ? '' : 'hidden'}>
        <input id="pdf-password" type="text" maxlength="32" placeholder="设置打开密码（最多 32 字符）" value="${esc(state.password || '')}" />
      </div>
    </div>

    <div class="drawer-foot">
      <div class="summary" id="job-summary">整本</div>
      <button class="btn primary" id="btn-build">开始生成</button>
    </div>`

  // 章节范围：两个下拉，互相钳制，保证 from <= to
  const fromSel = $('#ch-from', el.drawerBody)
  const toSel = $('#ch-to', el.drawerBody)
  fromSel.value = String(state.from)
  toSel.value = String(state.to)
  fromSel.addEventListener('change', () => {
    state.from = Number(fromSel.value)
    if (state.from > state.to) {
      state.to = state.from
      toSel.value = String(state.to)
    }
    updateSummary()
  })
  toSel.addEventListener('change', () => {
    state.to = Number(toSel.value)
    if (state.to < state.from) {
      state.from = state.to
      fromSel.value = String(state.from)
    }
    updateSummary()
  })

  // 输出方式
  const splitGroup = $('#split-group', el.drawerBody)
  splitGroup.addEventListener('change', (e) => {
    if (e.target.name !== 'split') return
    state.split = e.target.value
    $$('.radio', splitGroup).forEach((n) => n.classList.toggle('checked', $('input', n).checked))
    updateSummary()
  })

  // 加密方式
  const group = $('#encrypt-group', el.drawerBody)
  group.addEventListener('change', (e) => {
    if (e.target.name !== 'enc') return
    state.encrypt = e.target.value
    $$('.radio', group).forEach((n) => n.classList.toggle('checked', $('input', n).checked))
    $('#password-wrap', el.drawerBody).hidden = state.encrypt !== 'custom'
    if (state.encrypt === 'custom') setTimeout(() => $('#pdf-password', el.drawerBody)?.focus(), 60)
    updateSummary()
  })

  const pwd = $('#pdf-password', el.drawerBody)
  pwd?.addEventListener('input', () => {
    state.password = pwd.value
    updateSummary()
  })

  const desc = $('#desc', el.drawerBody)
  if (desc && desc.scrollHeight > desc.clientHeight + 4) {
    desc.style.cursor = 'pointer'
    desc.addEventListener('click', () => desc.classList.toggle('expanded'))
  }

  $('#btn-build', el.drawerBody).addEventListener('click', startJob)
  updateSummary()
}

/** 当前选中的章节列表（按 sort 升序）。 */
function selectedChapters() {
  const album = state.album
  if (!album) return []
  return album.series.filter((s) => s.sort >= state.from && s.sort <= state.to)
}

const MERGE_LIMIT = 350

function updateSummary() {
  const album = state.album
  if (!album) return
  const node = $('#job-summary', el.drawerBody)
  if (!node) return

  const list = selectedChapters()
  const pages = list.reduce((n, s) => n + (Number(s.totalPage) || 0), 0)
  const whole = list.length === album.series.length
  const rangeLabel =
    list.length === 1
      ? `第 ${list[0].sort} 章 · ${list[0].name}`
      : whole
        ? `整本（${list.length} 章）`
        : `第 ${state.from}–${state.to} 章（${list.length} 章）`

  // 合并模式超过上限就禁用，并自动切到分章，避免用户点了才发现失败。
  // 页数为 0 表示章节元信息没给 total_page，多章合并必然超限，同样按「不能合并」处理。
  const singleRadio = $(`input[name="split"][value="single"]`, el.drawerBody)
  const unknownHeavy = pages === 0 && list.length > 4
  const tooMany = pages > MERGE_LIMIT || unknownHeavy
  if (singleRadio) {
    singleRadio.disabled = tooMany
    if (tooMany && state.split === 'single') {
      state.split = 'zip'
      $('input[name="split"][value="zip"]', el.drawerBody).checked = true
      $$('.radio', $('#split-group', el.drawerBody)).forEach((n) =>
        n.classList.toggle('checked', $('input', n).checked),
      )
    }
  }

  const modeText =
    state.split === 'zip'
      ? `${list.length} 个 PDF · ZIP 打包${unknownHeavy ? '（已锁定分章）' : ''}`
      : tooMany
        ? unknownHeavy
          ? `${list.length} 章页数未知，请改用分章`
          : `超过 ${MERGE_LIMIT} 页，请改用分章`
        : '1 个 PDF'

  const hint = $('#range-hint', el.drawerBody)
  if (hint) hint.textContent = list.length === 1 ? `第 ${list[0].sort} 章` : `${list.length} 章`

  const encLabel =
    state.encrypt === 'none'
      ? '不加密'
      : state.encrypt === 'id'
        ? `密码 ${album.id}`
        : state.password
          ? `密码 ${state.password.replace(/./g, '•')}`
          : '自定义密码（待填写）'

  const pagesText = pages > 0 ? `约 ${pages} 页` : '页数未知'
  node.innerHTML =
    `${esc(rangeLabel)} · ${pagesText}<br/>` +
    `<span style="opacity:.7">${esc(encLabel)} · ${esc(modeText)}</span>`

  const btn = $('#btn-build', el.drawerBody)
  if (btn) btn.disabled = tooMany && state.split === 'single'
}

el.drawerClose.addEventListener('click', closeDrawer)
el.scrim.addEventListener('click', closeDrawer)

function closeDrawer() {
  el.drawer.classList.remove('open')
  el.drawer.setAttribute('aria-hidden', 'true')
  closeScrim()
}

// ---------------------------------------------------------------------------
// 任务
// ---------------------------------------------------------------------------

async function startJob() {
  const album = state.album
  if (!album) return
  if (state.encrypt === 'custom' && !String(state.password || '').trim()) {
    toast('请先填写自定义密码', 'err')
    $('#pdf-password', el.drawerBody)?.focus()
    return
  }

  const btn = $('#btn-build', el.drawerBody)
  btn.disabled = true
  btn.textContent = '创建任务…'

  try {
    const { job } = await api('/api/jobs', {
      method: 'POST',
      timeout: 60000, // 服务端要先拿详情校验页数，首个请求可能触发主机发现
      body: {
        id: album.id,
        from: state.from,
        to: state.to,
        mode: state.split,
        encrypt: state.encrypt,
        password: state.password,
      },
    })
    trackJob(job)
    openTasks()
    closeDrawer()
    toast(job.mode === 'zip' ? '已加入队列，将按章打包 ZIP' : '已加入队列，将合并为一个 PDF', 'ok')
  } catch (err) {
    toast(err.message, 'err')
  } finally {
    btn.disabled = false
    btn.textContent = '开始生成'
  }
}

function trackJob(job) {
  const prev = state.jobs.get(job.id) || {}
  state.jobs.set(job.id, { ...prev, ...job })
  if (job.status === 'queued' || job.status === 'running') {
    state.openGroups.add(String(job.albumId))
    saveOpenGroups()
  }
  renderJobs()
  if (job.status === 'done' || job.status === 'error') return

  if (prev.es) prev.es.close()
  const params = state.token ? `?token=${encodeURIComponent(state.token)}` : ''
  const es = new EventSource(`/api/jobs/${job.id}/events${params}`)
  state.jobs.get(job.id).es = es

  const onData = (ev) => {
    try {
      updateJob(JSON.parse(ev.data))
    } catch {
      /* 忽略坏帧 */
    }
  }
  es.addEventListener('progress', onData)
  es.addEventListener('done', (ev) => {
    onData(ev)
    es.close()
    const j = state.jobs.get(job.id)
    if (j) {
      j.status = 'done'
      renderJobs()
      toast(`《${j.title}》PDF 已生成`, 'ok')
    }
  })
  es.addEventListener('error', (ev) => {
    if (!ev.data) return // 连接层错误，交给浏览器自动重连
    onData(ev)
    es.close()
    toast('任务失败，详情见任务列表', 'err')
  })
}

function updateJob(snapshot) {
  const prev = state.jobs.get(snapshot.id) || {}
  state.jobs.set(snapshot.id, { ...prev, ...snapshot })
  renderJobs()
}

function renderJobs() {
  const jobs = [...state.jobs.values()].sort((a, b) => b.createdAt - a.createdAt)
  const cacheItems = (state.cacheItems || []).slice(0, 60)
  const groups = buildGroups(jobs, cacheItems)

  el.tasksBody.innerHTML = groups.length
    ? groups.map(renderGroup).join('')
    : `<div class="empty" style="padding:34px 18px"><p>还没有任务</p></div>`

  const active = jobs.some((j) => j.status === 'queued' || j.status === 'running')
  el.taskBadge.hidden = !active
  updateStats()
}

/** 任务对应的缓存键，用来和缓存列表去重（同一个 PDF 不重复显示两次）。 */
function jobCacheKey(j) {
  if (j.kind && j.kind !== 'pdf') return null
  if (j.whole || (j.from == null && j.to == null)) return String(j.albumId)
  if (j.from === j.to) return `${j.albumId}_c${j.from}`
  return `${j.albumId}_r${j.from ?? 1}-${j.to ?? 'end'}`
}

/** 组内条目排序：按起始章节号，整本排最后。 */
function entryOrder(e) {
  if (e.job) {
    if (e.job.whole || e.job.from == null) return 1e9
    return Number(e.job.from) || 0
  }
  const it = e.cache
  if (it.chapter != null) return Number(it.chapter) || 0
  const m = /^r(\d+)-(?:\d+|end)$/.exec(it.tag || '')
  if (m) return Number(m[1])
  return 1e9
}

const pickTitle = (a, b) => (!a || /^JM\d+$/.test(a) ? b : a)

/** 旧缓存里的名字可能是「作品名 第2話」，作为组标题时去掉章节后缀。 */
function stripChapterSuffix(title) {
  const out = String(title || '').replace(/\s*第\s*[0-9一二三四五六七八九十百]+\s*[話话章卷回节節]\s*$/, '').trim()
  return out || title
}

/** 按作品（JM 号）把任务和缓存归到同一组。 */
function buildGroups(jobs, cacheItems) {
  const map = new Map()
  const get = (id, title) => {
    const key = String(id)
    let g = map.get(key)
    if (!g) {
      g = { albumId: key, title: '', jobs: [], cache: [], time: 0 }
      map.set(key, g)
    }
    if (title) g.title = pickTitle(g.title, title)
    return g
  }

  for (const j of jobs) {
    const g = get(j.albumId, j.title)
    g.jobs.push(j)
    g.time = Math.max(g.time, j.finishedAt || j.createdAt || 0)
  }

  // 已由任务覆盖的缓存不再单列，否则同一个 PDF 会出现两遍
  const jobKeys = new Set(jobs.map(jobCacheKey).filter(Boolean))
  for (const it of cacheItems) {
    if (jobKeys.has(it.key)) continue
    const g = get(it.id, it.name)
    g.cache.push(it)
    g.time = Math.max(g.time, it.time || 0)
  }

  return [...map.values()]
    .map((g) => {
      g.entries = [
        ...g.jobs.map((job) => ({ job })),
        ...g.cache.map((cache) => ({ cache })),
      ].sort((a, b) => entryOrder(a) - entryOrder(b))
      if (g.entries.length > 1) g.title = stripChapterSuffix(g.title)
      g.active = g.jobs.filter((j) => j.status === 'queued' || j.status === 'running')
      g.failed = g.jobs.filter((j) => j.status === 'error')
      g.size = g.entries.reduce((sum, e) => sum + (e.job?.size || e.cache?.size || 0), 0)
      return g
    })
    .sort((a, b) => b.time - a.time)
}

/** 组内条目的章节标签。 */
function chapterLabel(e) {
  if (e.job) {
    const j = e.job
    if (j.whole || (j.from == null && j.to == null)) return '整本'
    if (j.from === j.to) return `第 ${j.from} 章`
    return `第 ${j.from}-${j.to} 章`
  }
  const it = e.cache
  if (it.chapter != null) return `第 ${it.chapter} 章`
  const m = /^r(\d+)-(\d+|end)$/.exec(it.tag || '')
  if (m) return `第 ${m[1]}-${m[2] === 'end' ? '末' : m[2]} 章`
  return '整本'
}

function renderGroup(g) {
  const open = state.openGroups.has(g.albumId)
  const count = g.entries.length

  let cls = 'ok'
  let stateText = '已完成'
  let percent = 0
  let indeterminate = false

  if (g.active.length) {
    cls = 'run'
    stateText = `${g.active.length} 进行中`
    const cur = g.active[0]
    percent = cur.percent || 0
    indeterminate = cur.status === 'queued' || !cur.total
  } else if (g.failed.length) {
    cls = 'err'
    stateText = `${g.failed.length} 个失败`
  }

  const meta = [`JM${g.albumId}`, `${count} 个文件`, g.size ? fmtSize(g.size) : '']
    .filter(Boolean)
    .join(' · ')

  const body = open
    ? `<div class="group-body">${g.entries
        .map((e) => (e.job ? renderJob(e.job) : renderCacheItem(e.cache)))
        .join('')}</div>`
    : ''

  return `<div class="group${open ? ' open' : ''}" data-album="${esc(g.albumId)}">
    <button class="group-head" type="button">
      <span class="group-arrow" aria-hidden="true">›</span>
      <span class="group-main">
        <span class="group-name" title="${esc(g.title)}">${esc(g.title)}</span>
        <span class="group-sub">${esc(meta)}</span>
      </span>
      <span class="group-state ${cls}">${esc(stateText)}</span>
    </button>
    ${g.active.length && !open ? `<div class="group-bar${indeterminate ? ' indeterminate' : ''}"><i style="width:${percent}%"></i></div>` : ''}
    ${body}
  </div>`
}

function renderJob(j) {
  const statusMap = {
    queued: ['排队中', ''],
    running: ['下载中', ''],
    done: ['已完成', 'ok'],
    error: ['失败', 'err'],
    canceled: ['已取消', ''],
  }
  const [label, cls] = statusMap[j.status] || [j.status, '']
  const percent = j.status === 'done' ? 100 : j.percent || 0
  const indeterminate = j.status === 'queued' || (j.status === 'running' && !j.total)
  const sub =
    j.status === 'error'
      ? esc(j.error || j.message || '未知错误')
      : j.status === 'done'
        ? j.kind === 'zip'
          ? `${j.files || j.chapterCount || 0} 个 PDF · ${fmtSize(j.size)}${j.cached ? ' · 缓存' : ''}${
              j.failedChapters?.length ? ` · ${j.failedChapters.length} 章失败` : ''
            }`
          : `${j.total || j.done || 0} 页 · ${fmtSize(j.size)}${j.cached ? ' · 缓存' : ''}`
        : esc(j.message || '')

  const action =
    j.status === 'done'
      ? `<a class="btn primary" href="/api/jobs/${j.id}/download${state.token ? `?token=${encodeURIComponent(state.token)}` : ''}">下载 ${j.kind === 'zip' ? 'ZIP' : 'PDF'}</a>`
      : ''

  return `<div class="job" data-id="${j.id}">
    <div class="job-top">
      <div class="job-name" title="${esc(j.title)}">${esc(chapterLabel({ job: j }))}${
        j.kind === 'zip' ? '<span class="job-tag">ZIP</span>' : ''
      }</div>
      <div class="job-state ${cls}">${label}</div>
    </div>
    ${j.status === 'done' ? '' : `<div class="bar ${indeterminate ? 'indeterminate' : ''}"><i style="width:${percent}%"></i></div>`}
    <div class="job-sub">${sub}</div>
    ${action ? `<div class="job-actions">${action}</div>` : ''}
  </div>`
}

/** 缓存里的 PDF：任务记录丢了也能直接下载。 */
function renderCacheItem(it) {
  const href = `/api/cache/${encodeURIComponent(it.key)}/download${state.token ? `?token=${encodeURIComponent(state.token)}` : ''}`
  const day = it.time ? new Date(it.time).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : ''
  const sub = [it.pageCount ? `${it.pageCount} 页` : '', fmtSize(it.size), day].filter(Boolean).join(' · ')
  return `<div class="job">
    <div class="job-top">
      <div class="job-name" title="${esc(it.name)}">${esc(chapterLabel({ cache: it }))}</div>
      <div class="job-state ok">已生成</div>
    </div>
    <div class="job-sub">${sub}</div>
    <div class="job-actions"><a class="btn primary" href="${href}">下载 PDF</a></div>
  </div>`
}

function updateStats() {
  const jobs = [...state.jobs.values()]
  const running = jobs.filter((j) => j.status === 'running' || j.status === 'queued').length
  el.statJobs.textContent = running || '0'
}

function openTasks() {
  el.tasks.classList.add('open')
  el.tasks.setAttribute('aria-hidden', 'false')
}
function closeTasks() {
  el.tasks.classList.remove('open')
  el.tasks.setAttribute('aria-hidden', 'true')
}

el.btnTasks.addEventListener('click', () => (el.tasks.classList.contains('open') ? closeTasks() : openTasks()))
el.tasksClose.addEventListener('click', closeTasks)

// 点作品行展开 / 收起该作品的章节列表
el.tasksBody.addEventListener('click', (e) => {
  const head = e.target.closest('.group-head')
  if (!head) return
  const group = head.closest('.group')
  const id = group?.dataset.album
  if (!id) return
  if (state.openGroups.has(id)) state.openGroups.delete(id)
  else state.openGroups.add(id)
  saveOpenGroups()
  renderJobs()
})

// 刷新后恢复任务列表
function applyJobs(list) {
  for (const job of list) {
    if (job.status === 'queued' || job.status === 'running') trackJob(job)
    else state.jobs.set(job.id, job)
  }
  renderJobs()
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

async function loadConfig({ timeout = 8000 } = {}) {
  const { config } = await api('/api/config', { timeout })
  state.config = config
  setProxyStat()
  fillSettings(config)
  return config
}

function applyCache(data) {
  setStat(el.statCache, String(data.total ?? 0))
  // 缓存列表变了才重绘，避免轮询时面板闪烁
  const sig = (data.items || []).map((it) => it.key).join(',')
  if (sig !== state.cacheSig) {
    state.cacheSig = sig
    state.cacheItems = data.items || []
    renderJobs()
  }
}

async function refreshCacheStat() {
  try {
    applyCache(await api('/api/cache', { timeout: 10000 }))
  } catch {
    setStat(el.statCache, '—', 'warn')
  }
}

function fillSettings(cfg) {
  el.setProxy.value = cfg.proxyMasked || cfg.proxy || ''
  el.setMode.value = cfg.proxyMode || 'all'
  el.setConcurrency.value = cfg.concurrency ?? 4
  el.setQuality.value = cfg.quality ?? 82
  el.setMaxPages.value = cfg.maxPages ?? 0
  el.setEncrypt.value = cfg.encrypt || 'none'
  el.setPassword.value = cfg.password || ''
  el.setPassword.hidden = (cfg.encrypt || 'none') !== 'custom'
}

el.setEncrypt.addEventListener('change', () => {
  el.setPassword.hidden = el.setEncrypt.value !== 'custom'
})

function openSettings() {
  loadConfig().catch(() => {
    /* 配置读不到不影响打开设置面板，只是回显为空 */
  })
  el.modalScrim.hidden = false
  requestAnimationFrame(() => el.modalScrim.classList.add('show'))
  el.settings.classList.add('open')
  el.settings.setAttribute('aria-hidden', 'false')
}

function closeSettings() {
  el.modalScrim.classList.remove('show')
  el.settings.classList.remove('open')
  el.settings.setAttribute('aria-hidden', 'true')
  setTimeout(() => {
    if (!el.settings.classList.contains('open')) el.modalScrim.hidden = true
  }, 260)
}

el.btnSettings.addEventListener('click', openSettings)
el.settingsClose.addEventListener('click', closeSettings)
el.settingsCancel.addEventListener('click', closeSettings)
el.modalScrim.addEventListener('click', closeSettings)

el.settingsSave.addEventListener('click', async () => {
  el.settingsSave.disabled = true
  try {
    const payload = {
      proxy: el.setProxy.value.trim(),
      proxyMode: el.setMode.value,
      concurrency: Number(el.setConcurrency.value) || 4,
      quality: Number(el.setQuality.value) || 82,
      maxPages: Number(el.setMaxPages.value) || 0,
      encrypt: el.setEncrypt.value,
      password: el.setPassword.value,
    }
    const { config } = await api('/api/config', { method: 'POST', body: payload, timeout: 15000 })
    state.config = config
    setProxyStat()
    toast('设置已保存', 'ok')
    closeSettings()
  } catch (err) {
    toast(err.message, 'err')
  } finally {
    el.settingsSave.disabled = false
  }
})

el.testProxy.addEventListener('click', async () => {
  el.testProxy.disabled = true
  el.testResult.innerHTML = '正在测试…'
  try {
    const { results } = await api('/api/proxy/test', {
      method: 'POST',
      body: { proxy: el.setProxy.value.trim() },
    })
    el.testResult.innerHTML = results
      .map((r) =>
        r.ok
          ? `<div class="ok">✓ ${esc(r.proxy)} · ${r.ms}ms · 出口 ${esc(r.ip || '?')}${r.loc ? ` (${esc(r.loc)})` : ''}</div>`
          : `<div class="bad">✕ ${esc(r.proxy)} · ${esc(r.error)}</div>`,
      )
      .join('')
  } catch (err) {
    el.testResult.innerHTML = `<div class="bad">${esc(err.message)}</div>`
  } finally {
    el.testProxy.disabled = false
  }
})

// ---------------------------------------------------------------------------
// 快捷键与初始化
// ---------------------------------------------------------------------------

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (el.settings.classList.contains('open')) closeSettings()
    else if (el.drawer.classList.contains('open')) closeDrawer()
    else if (el.tasks.classList.contains('open')) closeTasks()
  }
  if (e.key === '/' && document.activeElement !== el.q && el.gate.hidden) {
    e.preventDefault()
    el.q.focus()
  }
})

let booted = false
let refreshTimer = null
let offlineNotified = false

/**
 * 一次性把首屏需要的三个接口并行拉回来。
 * 以前是「先 await 配置，再 await 任务，再请求缓存」，串行三跳，
 * 只要第一跳卡住，整页就一直空着。
 */
async function warmUp() {
  setStat(el.statCache, '…')
  setStat(el.statProxy, '…')

  const [cfg, jobRes, cacheRes] = await Promise.allSettled([
    api('/api/config', { timeout: 6000 }),
    api('/api/jobs', { timeout: 6000 }),
    api('/api/cache', { timeout: 8000 }),
  ])

  if (cfg.status === 'fulfilled') {
    state.config = cfg.value.config
    fillSettings(state.config)
    setProxyStat()
    delete document.body.dataset.offline
  } else {
    setStat(el.statProxy, '未连接', 'warn')
    document.body.dataset.offline = '1'
    const msg = cfg.reason?.message || ''
    // 没带口令时弹窗已经够清楚，不用再弹一条
    if (!offlineNotified && !/口令/.test(msg)) {
      offlineNotified = true
      toast('后端没有响应，点顶部「网络模式」可重试', 'err')
    }
  }

  if (jobRes.status === 'fulfilled') applyJobs(jobRes.value.jobs)
  else setStat(el.statJobs, '—', 'warn')
  if (cacheRes.status === 'fulfilled') applyCache(cacheRes.value)
  else setStat(el.statCache, '—', 'warn')
}

async function boot() {
  if (booted) return
  booted = true
  // 先把界面铺出来，一帧都不等网络：网络慢只影响数字，不影响「能操作」
  renderEmpty('输入关键词或 JM 号开始', true)

  await warmUp()

  if (refreshTimer) clearInterval(refreshTimer)
  refreshTimer = setInterval(refreshCacheStat, 60000)
}

// 统计区点一下重连（离线时才会生效）
el.heroStats?.addEventListener('click', async () => {
  if (document.body.dataset.offline !== '1') return
  toast('正在重新连接…')
  await warmUp()
  if (document.body.dataset.offline !== '1') toast('已连接', 'ok')
})

// 已确认过 18+ 才立即初始化，否则等点「进入」后再加载，避免口令框被遮罩挡住
if (gateAccepted) boot()
