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
  remove(key) {
    try {
      localStorage.removeItem(key)
    } catch {
      /* 隐私模式下删不掉也无所谓 */
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
  btnFavorites: $('#btn-favorites'),
  favBadge: $('#fav-badge'),
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
  setPageCache: $('#set-pagecache'),
  btnClearPages: $('#btn-clear-pages'),
  pagesStat: $('#pages-stat'),
  setEncrypt: $('#set-encrypt'),
  setPassword: $('#set-password'),
  testProxy: $('#btn-test-proxy'),
  testResult: $('#test-result'),
  authwall: $('#authwall'),
  authwallInput: $('#authwall-input'),
  authwallMsg: $('#authwall-msg'),
  setTokens: $('#set-tokens'),
  toasts: $('#toasts'),
  statCache: $('#stat-cache'),
  statJobs: $('#stat-jobs'),
  statProxy: $('#stat-proxy'),
  heroStats: $('#hero-stats'),
  reader: $('#reader'),
  readerBack: $('#reader-back'),
  readerTitle: $('#reader-title'),
  readerSub: $('#reader-sub'),
  readerChapter: $('#reader-chapter'),
  readerWidth: $('#reader-width'),
  readerFull: $('#reader-full'),
  readerStage: $('#reader-stage'),
  readerScroll: $('#reader-scroll'),
  readerPages: $('#reader-pages'),
  readerEnd: $('#reader-end'),
  readerState: $('#reader-state'),
  readerStateText: $('#reader-state-text'),
  readerRetry: $('#reader-retry'),
  readerPrevCh: $('#reader-prev-ch'),
  readerNextCh: $('#reader-next-ch'),
  readerPos: $('#reader-pos'),
  readerProgress: $('#reader-progress'),
  readerTip: $('#reader-tip'),
}

const state = {
  token: store.get('jm-token') || '',
  authOpen: false, // 口令墙是否正在前台
  authBusy: false,
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
  view: 'search', // search | favorites：决定「取消收藏」后是删卡片还是留在原地
  favorites: new Map(), // id -> { id, name, author, time }
  jobs: new Map(),
  cacheItems: [],
  cacheSig: '',
  openGroups: loadOpenGroups(),
  seq: 0,
  slowHint: 0,
  reader: {
    open: false,
    albumId: '',
    sort: null,
    chapters: [],
    pages: [],
    current: 1,
    pushed: false,
    observer: null,
    posObserver: null,
    token: 0,
    saveTimer: null,
  },
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

// 同一句话短时间内只提醒一次：一次刷新会并发好几个请求，
// 全部 429 时能叠出六七条一模一样的红色提示。
const lastToast = new Map()
function toastOnce(message, type = '') {
  const key = `${type}|${message}`
  if (Date.now() - (lastToast.get(key) || 0) < 4000) return
  lastToast.set(key, Date.now())
  toast(message, type)
}

// 所有请求都带超时：后端要是卡在主机发现/生成 PDF，界面得给个说法，
// 而不是让三个统计数字一直停在「–」。
const DEFAULT_TIMEOUT = 15000

/**
 * 口令要同时放 header 时才用这个：header 只接受 ISO-8859-1，
 * 中文 / emoji 口令直接写进去会让 fetch 当场抛错。这类口令走 query 就够了。
 */
const tokenHeader = (t) => (/^[\x20-\x7e]+$/.test(t) ? { 'x-token': t } : {})

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
          ...(state.token ? tokenHeader(state.token) : {}),
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
      // 本机存的口令对不上（服务端换过口令 / 把这一条删了）：先扔掉，否则之后
      // 每个请求都会带着这个错口令再撞一次，几次刷新就把自己送进锁定名单。
      const had = !!state.token
      if (had) {
        state.token = ''
        store.remove('jm-token')
      }
      showAuthWall(had ? '本机保存的口令已失效，请重新输入' : '')
      throw new Error('需要访问口令')
    }
    if (res.status === 429) {
      // 被限流说明口令试错太多次。服务端对「口令正确」是立刻放行的，
      // 所以这里仍把输入框露出来：输对一次就能当场解锁，不用干等十分钟。
      const msg = data.error || '口令错误次数过多，请稍后再试'
      showAuthWall(`${msg}；输入正确口令可立即恢复`)
      throw new Error(msg)
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
// 访问口令墙
//
// 服务端可以挂多个口令（命令行 --token 甲,乙 或在设置里加）。在通过之前整页只有
// 一个输入框：html.auth-locked 会把 body 的其它直接子元素全部隐藏，连 18+ 门禁
// 也不露 —— 口令正确才谈得上"页面存在"。
// ---------------------------------------------------------------------------

function unlockUI() {
  document.documentElement.classList.remove('auth-locked')
  el.authwall.hidden = true
  el.authwallMsg.textContent = '' // 下次再锁屏时不带上一轮的「正在验证…」
  state.authOpen = false
}

/** 显示口令墙。message 为空就只留一个输入框。 */
function showAuthWall(message = '') {
  // 已经在墙上时不拿空消息把现有错误擦掉（401 会并发来好几条）
  if (state.authOpen && !message) return
  state.authOpen = true
  document.documentElement.classList.add('auth-locked')
  el.authwall.hidden = false
  el.authwallMsg.textContent = message
  el.authwallMsg.classList.toggle('bad', !!message)
  setTimeout(() => {
    if (!el.authwallInput?.disabled) el.authwallInput?.focus()
  }, 40)
}

const lockText = (sec) => `错误次数过多，约 ${Math.max(1, Math.ceil(sec / 60))} 分钟后可重试`

/**
 * 问服务端：要不要口令、手上这个对不对。
 * /api/auth 本身不需要口令 —— 否则没口令的人连"该不该显示输入框"都不知道。
 */
async function authProbe(token = '') {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    // 口令同时放 query 和 header：header 在 Node 里按 latin1 解，中文口令会乱码
    const url = new URL('/api/auth', location.origin)
    if (token) url.searchParams.set('token', token)
    const res = await fetch(url, {
      cache: 'no-store',
      headers: token ? tokenHeader(token) : {},
      signal: ctrl.signal,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    return data
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error('服务器 8 秒没有响应')
    throw err
  } finally {
    clearTimeout(timer)
  }
}

async function submitAuth() {
  if (state.authBusy) return
  const value = el.authwallInput.value.trim()
  if (!value) {
    el.authwallMsg.textContent = '请输入口令'
    el.authwallMsg.classList.add('bad')
    el.authwallInput.focus()
    return
  }

  state.authBusy = true
  el.authwallInput.disabled = true
  el.authwallMsg.textContent = '正在验证…'
  el.authwallMsg.classList.remove('bad')

  try {
    const r = await authProbe(value)
    if (r.required && !r.valid) {
      el.authwallMsg.textContent = r.lockLeft ? lockText(r.lockLeft) : '口令不正确'
      el.authwallMsg.classList.add('bad')
      el.authwallInput.select()
      return
    }
    state.token = value
    store.set('jm-token', value)
    el.authwallInput.value = ''
    unlockUI()
    afterAuth()
    toast('口令正确', 'ok')
  } catch (err) {
    el.authwallMsg.textContent = err?.message || '验证失败，请重试'
    el.authwallMsg.classList.add('bad')
  } finally {
    state.authBusy = false
    el.authwallInput.disabled = false
    if (state.authOpen) el.authwallInput.focus()
  }
}

el.authwallInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitAuth()
})

/** 口令通过（或本来就不需要口令）之后，才轮到 18+ 门禁和主界面。 */
function afterAuth() {
  el.gate.hidden = gateAccepted
  if (gateAccepted) boot()
}

async function startApp() {
  let info = null
  try {
    // 本机存过口令就一起带上，省一次往返
    info = await authProbe(state.token)
  } catch {
    // 服务连不上时鉴权无从判断：先放开，让原有的「连不上后端」提示去解释
    unlockUI()
    afterAuth()
    return
  }

  if (!info.required || info.valid) {
    unlockUI()
    afterAuth()
    return
  }

  // 本机存的口令已经不在服务端列表里（被删掉或整体换过）
  if (state.token) {
    state.token = ''
    store.remove('jm-token')
  }
  showAuthWall(info.lockLeft ? lockText(info.lockLeft) : '')
}

// ---------------------------------------------------------------------------
// 搜索与列表
// ---------------------------------------------------------------------------

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
  // 三步引导只属于「还没搜过」的首页，收藏夹空了不该再教人怎么搜索
  const steps = $('.steps', el.empty)
  if (steps) steps.hidden = false
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
      <article class="card" data-id="${esc(it.id)}" data-name="${esc(it.name)}" data-author="${esc(it.author || '')}"
               style="animation-delay:${Math.min(i * 22, 320)}ms">
        <span class="card-id">JM${esc(it.id)}</span>
        <button class="card-fav ${isFavorite(it.id) ? 'on' : ''}" data-fav="${esc(it.id)}" type="button"
                title="${isFavorite(it.id) ? '取消收藏' : '收藏'}" aria-pressed="${isFavorite(it.id)}"
                aria-label="收藏">${HEART_SVG}</button>
        <img src="${esc(withToken(it.cover))}" alt="" loading="lazy" decoding="async"
             onerror="this.style.opacity='.25';this.removeAttribute('src')" />
        <div class="card-body">
          <div class="card-title">${esc(it.name)}</div>
          <div class="card-author">${esc(it.author || '佚名')}${it.note ? ` · ${esc(it.note)}` : ''}</div>
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
  state.view = 'search'
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
  const favBtn = e.target.closest('.card-fav')
  if (favBtn) {
    e.preventDefault()
    e.stopPropagation()
    const card = favBtn.closest('.card')
    if (card) toggleFavorite({ id: card.dataset.id, name: card.dataset.name, author: card.dataset.author })
    return
  }
  const card = e.target.closest('.card')
  if (card) openDetail(card.dataset.id)
})

el.prev.addEventListener('click', () => doSearch(state.query, Math.max(1, state.page - 1)))
el.next.addEventListener('click', () => doSearch(state.query, Math.min(state.totalPages, state.page + 1)))

// ---------------------------------------------------------------------------
// 收藏（本地收藏夹，存在服务端 data/favorites.json）
// ---------------------------------------------------------------------------

const HEART_SVG =
  '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
  '<path d="M12 20.2S4.8 15.6 4.8 10.6a4.2 4.2 0 0 1 7.2-2.9 4.2 4.2 0 0 1 7.2 2.9c0 5-7.2 9.6-7.2 9.6Z" ' +
  'stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/></svg>'

const isFavorite = (id) => state.favorites.has(String(id || ''))

/** 收藏数挂在顶栏图标上，0 时藏起来，免得空收藏夹也挂个「0」。 */
function refreshFavBadge() {
  const n = state.favorites.size
  if (el.favBadge) {
    el.favBadge.hidden = n === 0
    el.favBadge.textContent = n > 99 ? '99+' : String(n)
  }
  if (el.btnFavorites) el.btnFavorites.title = n ? `我的收藏（${n}）` : '我的收藏'
}

/** 把某一部作品的收藏状态同步到所有已经渲染出来的按钮上。 */
function syncFavoriteUI(id) {
  const key = String(id)
  const on = state.favorites.has(key)
  $$(`.card-fav[data-fav="${key}"]`).forEach((btn) => {
    btn.classList.toggle('on', on)
    btn.setAttribute('aria-pressed', on ? 'true' : 'false')
    btn.title = on ? '取消收藏' : '收藏'
  })
  const btn = $('#btn-fav', el.drawerBody)
  if (btn && btn.dataset.id === key) {
    btn.classList.toggle('on', on)
    btn.setAttribute('aria-pressed', on ? 'true' : 'false')
    btn.innerHTML = `${HEART_SVG}<span>${on ? '已收藏' : '收藏'}</span>`
  }
  refreshFavBadge()
}

const favBusy = new Set()

/**
 * 收藏 / 取消收藏。先改界面再发请求，点一下立刻有反馈；
 * 失败就回滚，绝不留下「看着收藏了、其实没存上」的假状态。
 */
async function toggleFavorite(item) {
  const id = String(item?.id || '')
  if (!id || favBusy.has(id)) return

  const prev = state.favorites.get(id)
  const adding = !prev
  favBusy.add(id)

  if (adding) {
    state.favorites.set(id, { id, name: item.name || '', author: item.author || '', time: Date.now() })
  } else {
    state.favorites.delete(id)
  }
  syncFavoriteUI(id)

  try {
    if (adding) {
      const r = await api('/api/favorites', {
        method: 'POST',
        body: { id, name: item.name || '', author: item.author || '', totalPages: item.totalPages || 0 },
        timeout: 20000,
      })
      if (r.item) state.favorites.set(id, r.item) // 收藏时间以服务端为准
      syncFavoriteUI(id)
      toast('已加入收藏', 'ok')
    } else {
      await api(`/api/favorites/${id}`, { method: 'DELETE', timeout: 15000 })
      toast('已取消收藏')
    }

    if (state.view === 'favorites') {
      if (adding) renderFavorites()
      else removeFavoriteCard(id)
    }
  } catch (err) {
    if (adding) state.favorites.delete(id)
    else if (prev) state.favorites.set(id, prev)
    syncFavoriteUI(id)
    toast(err.message || '收藏操作失败', 'err')
  } finally {
    favBusy.delete(id)
  }
}

/** 收藏页里取消收藏：只拿掉这一张卡片，不整页重排（避免滚动位置跳走）。 */
function removeFavoriteCard(id) {
  const card = $(`.card[data-id="${id}"]`, el.grid)
  if (!card) return
  card.style.transition = 'opacity .2s var(--ease), transform .2s var(--ease)'
  card.style.opacity = '0'
  card.style.transform = 'scale(.95)'
  setTimeout(() => {
    card.remove()
    const left = el.grid.querySelectorAll('.card').length
    if (!left) return renderFavorites()
    el.resultsMeta.textContent = `共 ${state.favorites.size} 部 · 点心形可取消`
  }, 200)
}

function renderFavorites() {
  state.view = 'favorites'
  state.query = ''

  const items = [...state.favorites.values()]
    .sort((a, b) => (b.time || 0) - (a.time || 0))
    .map((f) => {
      const prog = readProgressOf(f.id)
      return {
        id: f.id,
        name: f.name || `JM${f.id}`,
        author: f.author || '',
        cover: `/api/cover?id=${f.id}&v=0`,
        note: prog && prog.sort ? `读到第 ${prog.sort} 章` : '',
      }
    })

  const total = state.favorites.size
  const shown = items.slice(0, 200)

  if (!items.length) {
    renderEmpty('收藏夹还是空的。搜索结果里点封面右上角的心形，或在详情页点「收藏」。')
    const steps = $('.steps', el.empty)
    if (steps) steps.hidden = true
    el.resultsHead.hidden = false
    el.resultsTitle.textContent = '我的收藏'
    el.resultsMeta.textContent = '共 0 部'
    window.scrollTo({ top: 0, behavior: 'smooth' })
    return
  }

  renderGrid(shown, {
    title: '我的收藏',
    sub:
      total > shown.length
        ? `共 ${total} 部，只显示最近 ${shown.length} 部`
        : `共 ${total} 部 · 点心形可取消`,
  })
  el.pager.hidden = true
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

function applyFavorites(list) {
  state.favorites = new Map((Array.isArray(list) ? list : []).map((it) => [String(it.id), it]))
  refreshFavBadge()
  // 首屏可能已经渲染过卡片（缓存/任务面板），把心形状态补上
  $$('.card-fav').forEach((btn) => {
    const on = state.favorites.has(btn.dataset.fav)
    btn.classList.toggle('on', on)
    btn.setAttribute('aria-pressed', on ? 'true' : 'false')
    btn.title = on ? '取消收藏' : '收藏'
  })
}

el.btnFavorites?.addEventListener('click', async () => {
  // 先用手上这份渲染，别让人对着空白等网络
  renderFavorites()
  try {
    const r = await api('/api/favorites', { timeout: 8000 })
    const before = state.favorites.size
    applyFavorites(r.items)
    if (state.view === 'favorites' && state.favorites.size !== before) renderFavorites()
  } catch {
    /* 拉不到就继续用本地这份 */
  }
})

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
    `<button class="fav-toggle ${isFavorite(album.id) ? 'on' : ''}" id="btn-fav" data-id="${esc(album.id)}"
             type="button" aria-pressed="${isFavorite(album.id)}">${HEART_SVG}<span>${
               isFavorite(album.id) ? '已收藏' : '收藏'
             }</span></button>`,
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
      <div class="detail-cover"><img src="${esc(withToken(album.cover))}" alt="" onerror="this.style.display='none'" /></div>
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
      <button class="btn ghost" id="btn-read">在线阅读</button>
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

  $('#btn-fav', el.drawerBody)?.addEventListener('click', () => {
    toggleFavorite({
      id: album.id,
      name: album.name,
      author: (album.authors || [])[0] || '',
      totalPages: album.totalPages,
    })
  })

  $('#btn-build', el.drawerBody).addEventListener('click', startJob)

  // 在线阅读：有历史记录就从上次那一章接着看
  const readBtn = $('#btn-read', el.drawerBody)
  const prog = readProgressOf(album.id)
  const resume = prog && album.series.some((s) => Number(s.sort) === Number(prog.sort))
  if (resume) {
    readBtn.textContent = '继续阅读'
    readBtn.title = `上次读到第 ${prog.sort} 章`
  }
  readBtn.addEventListener('click', () => {
    openReader(album.id, resume ? prog.sort : state.from)
  })

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
  // 连接层错误浏览器会自动重连；但口令不对、服务重启这类情况会一直失败，
  // 重连的每个请求都算一次口令错误，几次之后就把自己锁了 —— 失败几次就放弃，
  // 下次刷新任务列表再重建。
  let sseFails = 0
  es.addEventListener('open', () => {
    sseFails = 0
  })
  es.addEventListener('error', (ev) => {
    if (!ev.data) {
      if (++sseFails >= 3) {
        es.close()
        const j = state.jobs.get(job.id)
        if (j) j.es = null
      }
      return
    }
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

  const actions = []
  if (j.status === 'done') {
    actions.push(
      `<a class="btn primary" href="/api/jobs/${j.id}/download${state.token ? `?token=${encodeURIComponent(state.token)}` : ''}">下载 ${j.kind === 'zip' ? 'ZIP' : 'PDF'}</a>`,
    )
    // 只有「单章 PDF」能对应到具体章节去在线看；整本 / 区间 / ZIP 没有唯一章节
    if (j.kind !== 'zip' && j.from != null && j.from === j.to) {
      actions.push(
        `<button class="btn ghost" data-read="${esc(j.albumId)}" data-chapter="${j.from}">在线阅读</button>`,
      )
    }
  }

  return `<div class="job" data-id="${j.id}">
    <div class="job-top">
      <div class="job-name" title="${esc(j.title)}">${esc(chapterLabel({ job: j }))}${
        j.kind === 'zip' ? '<span class="job-tag">ZIP</span>' : ''
      }</div>
      <div class="job-state ${cls}">${label}</div>
    </div>
    ${j.status === 'done' ? '' : `<div class="bar ${indeterminate ? 'indeterminate' : ''}"><i style="width:${percent}%"></i></div>`}
    <div class="job-sub">${sub}</div>
    ${actions.length ? `<div class="job-actions">${actions.join('')}</div>` : ''}
  </div>`
}

/** 缓存里的 PDF：任务记录丢了也能直接下载。 */
function renderCacheItem(it) {
  const href = `/api/cache/${encodeURIComponent(it.key)}/download${state.token ? `?token=${encodeURIComponent(state.token)}` : ''}`
  const day = it.time ? new Date(it.time).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : ''
  const sub = [it.pageCount ? `${it.pageCount} 页` : '', fmtSize(it.size), day].filter(Boolean).join(' · ')
  const read =
    it.chapter != null
      ? `<button class="btn ghost" data-read="${esc(it.id)}" data-chapter="${it.chapter}">在线阅读</button>`
      : ''
  return `<div class="job">
    <div class="job-top">
      <div class="job-name" title="${esc(it.name)}">${esc(chapterLabel({ cache: it }))}</div>
      <div class="job-state ok">已生成</div>
    </div>
    <div class="job-sub">${sub}</div>
    <div class="job-actions"><a class="btn primary" href="${href}">下载 PDF</a>${read}</div>
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
  const readBtn = e.target.closest('[data-read]')
  if (readBtn) {
    openReader(readBtn.dataset.read, Number(readBtn.dataset.chapter))
    return
  }
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
// 在线阅读器
//
// 竖排连续滚动（条漫 / 页漫都适用）：页面容器先按 2:3 占位，图片到位后
// 用真实宽高覆盖，避免「图片一张张加载、滚动条不停乱跳」。
// 只有进入视口前后各 1400px 的页才会真正发请求，30 页的章节也只先拉 3~4 张。
// ---------------------------------------------------------------------------

const READ_PROGRESS_KEY = 'jm-read-progress'
const READ_WIDTH_KEY = 'jm-reader-width'
const WIDTH_MODES = ['fit', 'wide', 'full']
const WIDTH_LABEL = { fit: '适宽', wide: '宽屏', full: '全宽' }

function loadProgressMap() {
  try {
    const raw = JSON.parse(store.get(READ_PROGRESS_KEY) || '{}')
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

function readProgressOf(albumId) {
  const rec = loadProgressMap()[String(albumId)]
  return rec && typeof rec === 'object' ? rec : null
}

function saveReadProgress(albumId, patch) {
  if (!albumId) return
  const all = loadProgressMap()
  all[String(albumId)] = { ...(all[String(albumId)] || {}), ...patch, time: Date.now() }
  // 只留最近 80 部，别让 localStorage 无限长
  const keys = Object.keys(all).sort((a, b) => (all[b].time || 0) - (all[a].time || 0))
  for (const k of keys.slice(80)) delete all[k]
  store.set(READ_PROGRESS_KEY, JSON.stringify(all))
}

/** 给图片地址补口令；服务端有时已经带过，别重复拼。 */
function withToken(url) {
  if (!state.token || /[?&]token=/.test(url)) return url
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(state.token)}`
}

const readerHash = (albumId, sort) => `#/read/${albumId}/${sort}`

function showReader() {
  el.reader.classList.add('open')
  el.reader.setAttribute('aria-hidden', 'false')
  document.body.classList.add('reading')
}

function hideReader() {
  el.reader.classList.remove('open')
  el.reader.setAttribute('aria-hidden', 'true')
  document.body.classList.remove('reading')
}

function setReaderState(text, { spinner = true, retry = false } = {}) {
  el.readerStage.classList.add('loading')
  el.readerStateText.textContent = text
  el.readerState.querySelector('.reader-spinner').hidden = !spinner
  el.readerRetry.hidden = !retry
  el.readerRetry.onclick = retry ? () => loadReaderChapter(state.reader.sort) : null
}

function clearReaderState() {
  el.readerStage.classList.remove('loading')
  el.readerRetry.hidden = true
}

function applyReaderWidth(mode) {
  const m = WIDTH_MODES.includes(mode) ? mode : 'fit'
  el.readerStage.dataset.width = m
  store.set(READ_WIDTH_KEY, m)
}

function readerTip(text) {
  el.readerTip.textContent = text
  el.readerTip.classList.add('show')
  clearTimeout(readerTip.timer)
  readerTip.timer = setTimeout(() => el.readerTip.classList.remove('show'), 2600)
}

/** 打开阅读器：同一部作品重复调用只会切章。 */
async function openReader(albumId, sort, { fromHistory = false } = {}) {
  const id = String(albumId || '').replace(/\D/g, '')
  if (!id) return
  const start = Number(sort) || 1

  closeDrawer()
  closeTasks()

  const wasOpen = state.reader.open
  state.reader.open = true
  state.reader.albumId = id
  showReader()
  applyReaderWidth(store.get(READ_WIDTH_KEY) || 'fit')

  if (!wasOpen) {
    if (fromHistory) {
      state.reader.pushed = false
    } else if (location.hash.startsWith('#/read/')) {
      // 已经在一个阅读地址上（分享链接 / 从别的作品跳过来）：
      // 直接替换，别再加一条历史记录，否则关不掉、返回还会绕回阅读器
      state.reader.pushed = false
      try {
        history.replaceState({ jmReader: 1 }, '', readerHash(id, start))
      } catch {
        /* 忽略 */
      }
    } else {
      state.reader.pushed = true
      try {
        history.pushState({ jmReader: 1 }, '', readerHash(id, start))
      } catch {
        /* 某些内嵌浏览器不允许，忽略即可 */
      }
    }
    readerTip('滚动阅读 · ← → 切换章节 · Esc 退出')
  }

  await loadReaderChapter(start)

  if (!wasOpen) el.readerScroll.focus?.()
}

async function loadReaderChapter(sort) {
  const r = state.reader
  const albumId = r.albumId
  const want = Number(sort) || 1
  const token = ++r.token

  setReaderState('正在加载章节…')
  r.observer?.disconnect()
  r.posObserver?.disconnect()
  el.readerPages.innerHTML = ''
  el.readerEnd.hidden = true
  el.readerEnd.innerHTML = ''

  try {
    const data = await api(
      `/api/read?id=${encodeURIComponent(albumId)}&chapter=${encodeURIComponent(want)}`,
      { timeout: 45000 },
    )
    if (token !== r.token) return

    r.chapters = data.chapters || []
    r.sort = data.chapter.sort
    r.pages = (data.pages || []).map((p) => ({ ...p, state: '' }))
    r.current = 1
    r.loaded = 0

    renderReaderHeader(data)

    // 章节切换不新增历史记录，否则连看十话要按十次返回到列表
    try {
      history.replaceState({ jmReader: 1 }, '', readerHash(albumId, r.sort))
    } catch {
      /* 同上 */
    }

    renderReaderPages()
    clearReaderState()
    el.readerScroll.scrollTop = 0
    updateReaderProgress()

    const prog = readProgressOf(albumId)
    // 同一章才恢复页码；换章当然从头看
    const resumePage =
      prog && Number(prog.sort) === Number(r.sort) ? Math.max(1, Number(prog.page) || 1) : 1
    if (resumePage > 1) {
      const box = el.readerPages.children[resumePage - 1]
      if (box) {
        // 等占位高度生效再跳，否则会跳到错误位置
        requestAnimationFrame(() => {
          el.readerScroll.scrollTop = box.offsetTop - 8
          updateReaderProgress()
        })
      }
    }

    saveReadProgress(albumId, { sort: r.sort, page: resumePage })
  } catch (err) {
    if (token !== r.token) return
    setReaderState(err.message || '章节加载失败', { spinner: false, retry: true })
  }
}

function renderReaderHeader(data) {
  const c = data.chapter
  el.readerTitle.textContent = data.album.name || `JM${data.album.id}`
  el.readerSub.textContent = `第 ${c.sort} 章 · ${c.name} · ${c.pageCount} 页`

  const narrow = window.matchMedia('(max-width: 640px)').matches
  el.readerChapter.innerHTML = (data.chapters || [])
    .map(
      (s) =>
        `<option value="${s.sort}">${narrow ? `第${s.sort}章` : `第${s.sort}章 · ${esc(s.name)}`}</option>`,
    )
    .join('')
  el.readerChapter.value = String(c.sort)

  const idx = state.reader.chapters.findIndex((s) => Number(s.sort) === Number(c.sort))
  const prev = idx > 0 ? state.reader.chapters[idx - 1] : null
  const next = idx >= 0 && idx < state.reader.chapters.length - 1 ? state.reader.chapters[idx + 1] : null

  el.readerPrevCh.disabled = !prev
  el.readerNextCh.disabled = !next
  el.readerPrevCh.title = prev ? `第 ${prev.sort} 章 · ${prev.name}` : '已经是第一章'
  el.readerNextCh.title = next ? `第 ${next.sort} 章 · ${next.name}` : '已经是最后一章'

  el.readerEnd.hidden = false
  el.readerEnd.innerHTML = `
    <p>第 ${c.sort} 章 · ${esc(c.name)} · 已读完</p>
    ${
      next
        ? `<button class="btn primary" data-next="${next.sort}">继续阅读 第 ${next.sort} 章</button>`
        : '<p style="opacity:.6">已经是最后一章了</p>'
    }
    <button class="btn ghost" data-top="1">回到开头</button>`
  el.readerEnd.querySelector('[data-next]')?.addEventListener('click', (e) => {
    loadReaderChapter(Number(e.currentTarget.dataset.next))
  })
  el.readerEnd.querySelector('[data-top]')?.addEventListener('click', () => {
    el.readerScroll.scrollTo({ top: 0, behavior: 'smooth' })
  })
}

function renderReaderPages() {
  const r = state.reader
  const frag = document.createDocumentFragment()
  r.pages.forEach((p, i) => {
    const box = document.createElement('div')
    box.className = 'rpage'
    box.dataset.i = String(i)
    // 服务端预量过的页直接按真实比例占位，图片到位前后版面一致，不会跳
    if (p.w && p.h) box.style.aspectRatio = `${p.w} / ${p.h}`
    frag.appendChild(box)
  })
  el.readerPages.appendChild(frag)

  // 预加载：视口上下各 1400px 内的页
  r.observer = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (en.isIntersecting) loadReaderPage(Number(en.target.dataset.i))
      }
    },
    { root: el.readerScroll, rootMargin: '1400px 0px' },
  )
  // 当前页：只认穿过视口中线附近的那一页
  r.posObserver = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue
        const n = Number(en.target.dataset.i) + 1
        if (n !== r.current) {
          r.current = n
          updateReaderProgress()
          scheduleProgressSave()
        }
      }
    },
    { root: el.readerScroll, rootMargin: '-42% 0px -52% 0px' },
  )

  for (const node of el.readerPages.children) {
    r.observer.observe(node)
    r.posObserver.observe(node)
  }
}

function loadReaderPage(i) {
  const r = state.reader
  const pg = r.pages[i]
  const box = el.readerPages.children[i]
  if (!pg || !box) return
  if (pg.state === 'ok' || pg.state === 'loading') return
  pg.state = 'loading'
  box.classList.remove('failed')
  box.innerHTML = ''

  const img = document.createElement('img')
  img.alt = `第 ${i + 1} 页`
  img.decoding = 'async'
  if (i > 2) img.loading = 'lazy'

  let retried = false
  const fail = (msg) => {
    pg.state = 'error'
    box.classList.add('failed')
    box.innerHTML = `<div class="rpage-fail"><span>第 ${i + 1} 页加载失败${msg ? `<br/>${esc(msg)}` : ''}</span><button type="button">重试</button></div>`
    box.querySelector('button')?.addEventListener('click', () => {
      pg.state = ''
      loadReaderPage(i)
    })
  }

  img.addEventListener('load', () => {
    if (!img.naturalWidth) return fail('')
    pg.state = 'ok'
    box.classList.add('loaded')
    // 用真实宽高固定版面，后面的图加载完也不会把已读内容顶走
    box.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`
    r.loaded++
    updateReaderProgress()
  })
  img.addEventListener('error', () => {
    if (!retried) {
      retried = true
      setTimeout(() => {
        img.src = `${withToken(pg.src)}&r=${Date.now()}`
      }, 700)
      return
    }
    fail('')
  })

  const url = withToken(pg.src)
  img.src = url
  box.appendChild(img)
}

function updateReaderProgress() {
  const r = state.reader
  const sc = el.readerScroll
  const total = r.pages.length || 1
  const max = sc.scrollHeight - sc.clientHeight
  const pct = max > 0 ? Math.min(100, Math.max(0, (sc.scrollTop / max) * 100)) : 0
  el.readerProgress.style.width = `${pct}%`
  el.readerPos.textContent = `${r.current} / ${total}`
}

function scheduleProgressSave() {
  const r = state.reader
  clearTimeout(r.saveTimer)
  r.saveTimer = setTimeout(() => {
    if (!r.open) return
    saveReadProgress(r.albumId, { sort: r.sort, page: r.current })
  }, 700)
}

function readerStep(dir) {
  const r = state.reader
  const idx = r.chapters.findIndex((s) => Number(s.sort) === Number(r.sort))
  if (idx < 0) return
  const target = r.chapters[idx + dir]
  if (!target) {
    readerTip(dir > 0 ? '已经是最后一章' : '已经是第一章')
    return
  }
  loadReaderChapter(Number(target.sort))
}

/** 收拾阅读器界面，不碰历史记录（历史由 closeReader / popstate 各自处理）。 */
function teardownReader() {
  const r = state.reader
  if (!r.open) return
  // 让还在路上的章节请求作废：否则关掉阅读器后响应回来，又往隐藏的容器里塞一堆图片
  r.token++
  if (r.sort != null) saveReadProgress(r.albumId, { sort: r.sort, page: r.current })
  r.open = false
  r.observer?.disconnect()
  r.posObserver?.disconnect()
  clearTimeout(r.saveTimer)
  hideReader()
  el.readerPages.innerHTML = ''
  el.readerEnd.hidden = true
  if (document.fullscreenElement === el.reader) document.exitFullscreen?.().catch(() => {})
}

function closeReader() {
  const r = state.reader
  if (!r.open) return
  const pushed = r.pushed
  r.pushed = false
  teardownReader()

  const onReaderHash = location.hash.startsWith('#/read/')
  if (pushed && onReaderHash) {
    history.back()
  } else if (onReaderHash) {
    history.replaceState(null, '', `${location.pathname}${location.search}`)
  }
}

/** 从地址栏 #/read/<albumId>/<sort> 恢复阅读（刷新、分享链接）。 */
function openReaderFromHash({ fromHistory = false } = {}) {
  const m = /^#\/read\/(\d+)(?:\/(\d+))?$/.exec(location.hash)
  if (!m || state.reader.open) return false
  openReader(m[1], m[2] ? Number(m[2]) : 1, { fromHistory })
  return true
}

// 浏览器前进 / 后退：回到列表就关阅读器，回到 #/read/... 就重新打开
window.addEventListener('popstate', () => {
  if (state.reader.open) {
    state.reader.pushed = false
    teardownReader()
  }
  openReaderFromHash({ fromHistory: true })
})

el.readerBack.addEventListener('click', closeReader)
el.readerChapter.addEventListener('change', () => loadReaderChapter(Number(el.readerChapter.value)))
el.readerPrevCh.addEventListener('click', () => readerStep(-1))
el.readerNextCh.addEventListener('click', () => readerStep(1))

el.readerWidth.addEventListener('click', () => {
  const cur = el.readerStage.dataset.width || 'fit'
  const next = WIDTH_MODES[(WIDTH_MODES.indexOf(cur) + 1) % WIDTH_MODES.length]
  applyReaderWidth(next)
  readerTip(`阅读宽度：${WIDTH_LABEL[next]}`)
})

el.readerFull.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
    else await el.reader.requestFullscreen()
  } catch {
    readerTip('这个浏览器不支持全屏')
  }
})

// 滚动：进度条实时更新，页码靠 IntersectionObserver
let scrollTick = 0
el.readerScroll.addEventListener(
  'scroll',
  () => {
    if (scrollTick) return
    scrollTick = requestAnimationFrame(() => {
      scrollTick = 0
      updateReaderProgress()
    })
  },
  { passive: true },
)

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
  el.setPageCache.value = cfg.pageCacheMB ?? 512
  el.setTokens.value = (cfg.tokens || []).join('\n')
  el.setEncrypt.value = cfg.encrypt || 'none'
  el.setPassword.value = cfg.password || ''
  el.setPassword.hidden = (cfg.encrypt || 'none') !== 'custom'
}

async function refreshPagesStat() {
  try {
    const data = await api('/api/cache', { timeout: 10000 })
    const p = data.pages || {}
    el.pagesStat.textContent = p.files
      ? `已存 ${p.files} 页 · ${fmtSize(p.size)}${p.limitMB ? ` / 上限 ${p.limitMB} MB` : '（不限）'}`
      : '还没有缓存任何页'
  } catch {
    el.pagesStat.textContent = '—'
  }
}

el.btnClearPages.addEventListener('click', async () => {
  if (!window.confirm('清空所有已缓存的阅读页？下次阅读会重新从图源下载。')) return
  el.btnClearPages.disabled = true
  try {
    const r = await api('/api/cache/pages', { method: 'DELETE', timeout: 30000 })
    toast(r.removed ? `已清空 ${r.removed} 页（${fmtSize(r.size || 0)}）` : '本来就没有缓存', 'ok')
    refreshPagesStat()
  } catch (err) {
    toast(err.message, 'err')
  } finally {
    el.btnClearPages.disabled = false
  }
})

el.setEncrypt.addEventListener('change', () => {
  el.setPassword.hidden = el.setEncrypt.value !== 'custom'
})

function openSettings() {
  loadConfig().catch(() => {
    /* 配置读不到不影响打开设置面板，只是回显为空 */
  })
  refreshPagesStat()
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
      tokens: el.setTokens.value
        .split('\n')
        .map((v) => v.trim())
        .filter(Boolean),
      proxy: el.setProxy.value.trim(),
      proxyMode: el.setMode.value,
      concurrency: Number(el.setConcurrency.value) || 4,
      quality: Number(el.setQuality.value) || 82,
      maxPages: Number(el.setMaxPages.value) || 0,
      pageCacheMB: Math.max(0, Number(el.setPageCache.value) || 0),
      encrypt: el.setEncrypt.value,
      password: el.setPassword.value,
    }
    const { config } = await api('/api/config', { method: 'POST', body: payload, timeout: 15000 })
    state.config = config
    setProxyStat()
    closeSettings()

    // 刚可能把自己正在用的口令从列表里删掉了。立刻问一次，别等下一个请求
    // 撞 401 才把整页盖起来 —— 那时用户正在读的页面会突然消失。
    const probe = await authProbe(state.token).catch(() => null)
    if (probe && probe.required && !probe.valid) {
      state.token = ''
      store.remove('jm-token')
      showAuthWall('口令已更新，请用新口令重新进入')
      return
    }
    toast('设置已保存', 'ok')
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
  // 阅读器打开时先接管键盘：上下翻页由阅读区自己滚，不做整页滚动
  if (state.reader.open) {
    const tag = (e.target?.tagName || '').toLowerCase()
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select'
    const step = () => el.readerScroll.clientHeight * 0.88

    if (e.key === 'Escape') {
      e.preventDefault()
      closeReader()
      return
    }
    if (typing) return

    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      readerStep(-1)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      readerStep(1)
    } else if (e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === ' ') {
      e.preventDefault()
      el.readerScroll.scrollBy({ top: step(), behavior: 'smooth' })
    } else if (e.key === 'ArrowUp' || e.key === 'PageUp') {
      e.preventDefault()
      el.readerScroll.scrollBy({ top: -step(), behavior: 'smooth' })
    } else if (e.key === 'Home') {
      e.preventDefault()
      el.readerScroll.scrollTo({ top: 0, behavior: 'smooth' })
    } else if (e.key === 'End') {
      e.preventDefault()
      el.readerScroll.scrollTo({ top: el.readerScroll.scrollHeight, behavior: 'smooth' })
    } else if (e.key === 'w' || e.key === 'W') {
      el.readerWidth.click()
    } else if (e.key === 'f' || e.key === 'F') {
      el.readerFull.click()
    }
    return
  }

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

  const [cfg, jobRes, cacheRes, favRes] = await Promise.allSettled([
    api('/api/config', { timeout: 6000 }),
    api('/api/jobs', { timeout: 6000 }),
    api('/api/cache', { timeout: 8000 }),
    api('/api/favorites', { timeout: 8000 }),
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

  // 收藏拉不到不影响主流程，只是心形状态为空
  if (favRes.status === 'fulfilled') applyFavorites(favRes.value.items)
}

async function boot() {
  if (booted) return
  booted = true
  // 先把界面铺出来，一帧都不等网络：网络慢只影响数字，不影响「能操作」
  renderEmpty('输入关键词或 JM 号开始', true)

  await warmUp()

  if (refreshTimer) clearInterval(refreshTimer)
  refreshTimer = setInterval(refreshCacheStat, 60000)

  // 刷新 / 分享链接直接落在某一章：等基础数据回来再进阅读器
  openReaderFromHash()
}

// 统计区点一下重连（离线时才会生效）
el.heroStats?.addEventListener('click', async () => {
  if (document.body.dataset.offline !== '1') return
  toast('正在重新连接…')
  await warmUp()
  if (document.body.dataset.offline !== '1') toast('已连接', 'ok')
})

// 先过口令墙，再决定直接启动还是停在 18+ 门禁
startApp()
