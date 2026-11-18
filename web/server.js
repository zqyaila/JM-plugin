/**
 * JM Reader Web —— 把插件核心能力搬进浏览器
 *
 * 只依赖 Node.js 内置模块 + apps/ 下已有的核心模块（sharp / @muhammara/wasm 用于出 PDF）。
 *
 * 启动：
 *   node web/server.js                 # 默认 http://127.0.0.1:7788
 *   node web/server.js --port 8080 --host 0.0.0.0
 *   node web/server.js --token 你的口令  # 公网部署时建议加上
 */

import http from 'node:http'
import os from 'node:os'
import crypto from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import { gzipSync } from 'node:zlib'
import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import JmClient from '../apps/jmcore.js'
import JmRepository, { resolveChapters, chapterPages, fetchPageImageRetry } from '../apps/jm.js'
import { getCachedPdf, listCache, removeCachedPdf, PDF_DIR } from '../apps/store.js'
import { proxyRequest, testProxy, parseProxyList, maskProxy } from '../apps/proxy.js'
import { config, loadConfig, saveConfig, publicConfig, resolveServerOptions, DATA_DIR } from './config.js'
import { createJobManager } from './jobs.js'
import { createPageStore } from './pagecache.js'
import { createFavorites } from './favorites.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.join(__dirname, 'public')
const SERVER_PAGE_SIZE = 80 // 服务端搜索接口固定每页 80 条
const MERGE_PAGE_LIMIT = 350 // 单个合并 PDF 的页数上限，超过就必须分章
const MERGE_CHAPTER_HINT = 4 // 页数未知时，超过这么多章就不建议合并

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
}

const client = new JmClient()
const repo = new JmRepository(client)
const jobs = createJobManager({ client, repo, getConfig: () => config })
const options = resolveServerOptions()

/** 列出本机所有非回环 IPv4，启动时直接告诉用户「别的设备该访问哪个地址」。 */
function lanUrls(port) {
  const out = []
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const it of list || []) {
      if (it.family !== 'IPv4' || it.internal) continue
      // 100.64.0.0/10 是 CGNAT 段，Tailscale / ZeroTier 这类组网工具都用它
      const cgnat = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(it.address)
      out.push({ url: `http://${it.address}:${port}`, tag: cgnat ? '组网地址' : name })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

let bootstrapping = null

/** 给可能长时间无响应的操作套一层超时，避免浏览器那边一直转圈。 */
function withTimeout(promise, ms, message) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/** 同步代理配置并确保 API 主机可用（并发调用共享同一次引导）。 */
async function ensureClient() {
  client.applyProxy({ proxy: config.proxy, proxyMode: config.proxyMode })
  if (client.apiUrl) return
  if (!bootstrapping) {
    bootstrapping = client
      .bootstrap()
      .catch((err) => {
        throw new Error(
          `无法连接 JM 服务：${err.message}。请检查本机网络，或在设置里配置可用的代理。`,
        )
      })
      .finally(() => {
        bootstrapping = null
      })
  }
  await withTimeout(
    bootstrapping,
    25000,
    '连接 JM 服务超时（25 秒）：本机网络可能连不上镜像站，建议在设置里配置代理后重试。',
  )
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function sendError(res, status, message) {
  sendJson(res, status, { ok: false, error: message })
}

async function readJsonBody(req, limit = 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

// 口令校验：先查是否被锁，再走恒等比较；失败累积到阈值就锁一段时间，
// 避免公网暴露后被慢慢试出口令。
const AUTH_MAX_FAIL = 10
const AUTH_LOCK_MS = 10 * 60 * 1000
// 同一个 IP 一秒内的并发失败只算一次：一次页面刷新可能同时发出几十个请求，
// 老口令没换之前，这些请求会在一瞬间全部 401，把正常用户自己锁死。
const AUTH_FAIL_WINDOW = 1000
const authFails = new Map() // ip -> { count, until, last }

function clientIp(req) {
  if (options.trustProxy) {
    const fwd = req.headers['x-forwarded-for']
    const first = Array.isArray(fwd) ? fwd[0] : String(fwd || '').split(',')[0]
    const real = req.headers['cf-connecting-ip'] || first
    if (real) return String(real).trim()
  }
  return (req.socket.remoteAddress || '').trim()
}

function tokenEquals(given) {
  // 先哈希再定长比较，既避免长度泄漏也躲开 timingSafeEqual 的长度限制
  const a = crypto.createHash('sha256').update(String(given)).digest()
  const b = crypto.createHash('sha256').update(String(options.token)).digest()
  return crypto.timingSafeEqual(a, b)
}

function checkToken(req, url) {
  if (!options.token) return true
  const ip = clientIp(req)
  // 图片请求带不了 header，所以 query 参数优先；两处都取不到才算没带口令
  const given = String(req.headers['x-token'] || url.searchParams.get('token') || '')

  // 先比对再判锁：口令正确就放行并清掉记录。
  // 否则一旦被误锁（比如浏览器缓存了旧口令、图片漏带 token 刷出十条 401），
  // 即使后来输对了口令也要干等十分钟 —— 知道口令的人本来就该放行。
  if (given && tokenEquals(given)) {
    authFails.delete(ip)
    return true
  }

  const rec = authFails.get(ip)
  if (rec?.until && rec.until > Date.now()) return false
  if (rec?.until) authFails.delete(ip)

  // 完全没带口令：返回 401，但不计入爆破次数。
  // 封面、页图这类 <img> 请求漏拼一次 token，就能在几百毫秒内刷出几十条 401；
  // 之前正是这样把本机和手机一起锁了 10 分钟。
  if (!given) return false

  const now = Date.now()
  const next = rec && !rec.until ? rec : { count: 0, until: 0, last: 0 }
  if (now - (next.last || 0) < AUTH_FAIL_WINDOW) {
    authFails.set(ip, next)
    return false
  }

  next.last = now
  next.count += 1
  if (next.count >= AUTH_MAX_FAIL) {
    next.count = 0
    next.until = now + AUTH_LOCK_MS
    console.warn(`[auth] ${ip} 口令连续错误 ${AUTH_MAX_FAIL} 次，已锁定 10 分钟`)
  }
  authFails.set(ip, next)
  return false
}

/** 锁定剩余秒数；没锁返回 0。 */
function authLockLeft(req) {
  const rec = authFails.get(clientIp(req))
  return rec?.until && rec.until > Date.now() ? Math.ceil((rec.until - Date.now()) / 1000) : 0
}

/** 封面地址：带上当前请求的口令，否则 <img> 请求会 401 并连累整个 IP。 */
function coverUrl(url, id, ver) {
  const q = new URLSearchParams({ id: String(id), v: String(ver || 0) })
  const token = url.searchParams.get('token')
  if (token) q.set('token', token)
  return `/api/cover?${q.toString()}`
}

/** 校验 JM 号，避免把任意字符串拼进接口。 */
function normalizeAlbumId(raw) {
  const m = String(raw ?? '').match(/\d{4,}/)
  return m ? m[0] : null
}

function fileSafeName(name) {
  return String(name || 'comic')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

// ---------------------------------------------------------------------------
// 业务接口
// ---------------------------------------------------------------------------

async function handleSearch(url, res) {
  const q = (url.searchParams.get('q') || '').trim()
  const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1)
  if (!q) return sendError(res, 400, '请输入搜索关键词')

  await ensureClient()
  const pageSize = Math.max(6, Math.min(60, Number(config.pageSize) || 24))
  const globalStart = (page - 1) * pageSize
  const serverPage = Math.floor(globalStart / SERVER_PAGE_SIZE) + 1
  const offset = globalStart % SERVER_PAGE_SIZE

  const r = await repo.search(q, serverPage, 'site')

  // 纯数字 / 只填了 JM 号：服务端直接返回作品，交给前端跳详情
  if (r.redirectAid) {
    return sendJson(res, 200, { ok: true, redirectAid: r.redirectAid, items: [], total: 0 })
  }

  const items = r.items.slice(offset, offset + pageSize).map((it) => ({
    id: it.id,
    name: it.name,
    author: it.author || '',
    cover: coverUrl(url, it.id, it.updateAt),
  }))

  sendJson(res, 200, {
    ok: true,
    query: r.query || q,
    total: r.total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(r.total / pageSize)),
    items,
  })
}

async function handleAlbum(url, res) {
  const id = normalizeAlbumId(url.searchParams.get('id'))
  if (!id) return sendError(res, 400, 'JM 号不合法')

  await ensureClient()
  const d = await repo.getAlbum(id)
  // 顺手给阅读器留一份章节表：从详情页点「在线阅读」时就不用再拉一次详情
  seriesCache.set(id, { detail: d, time: Date.now() })
  if (seriesCache.size > 40) seriesCache.delete(seriesCache.keys().next().value)
  const series = d.series.length
    ? d.series
    : [{ id: d.id, sort: 1, name: d.name, totalPage: d.totalPhotos }]

  // 整本总页数：用章节元信息里的 total_page 求和，避免逐章请求
  const totalPages = series.reduce((sum, s) => sum + (Number(s.totalPage) || 0), 0)

  sendJson(res, 200, {
    ok: true,
    album: {
      id: d.id,
      name: d.name,
      authors: d.authors,
      description: d.description,
      tags: d.tags,
      totalViews: d.totalViews,
      totalPhotos: d.totalPhotos,
      likes: d.likes,
      addtime: d.addtime,
      cover: coverUrl(url, d.id, d.addtime),
      series: series.map((s) => ({
        id: s.id,
        sort: s.sort,
        name: s.name,
        totalPage: Number(s.totalPage) || 0,
      })),
      totalPages,
    },
  })
}

/**
 * 封面缓存 + 并发闸门。
 *
 * 一屏搜索结果有 24 张封面，浏览器对同一域名只有 6 条连接：如果每张封面都要
 * 现连镜像站（还可能走代理），6 条连接会被慢速图片全部占满，之后的 /api/config、
 * /api/jobs 只能排队 —— 表现就是「页面半天加载不出来，顶部统计一直是 —」。
 * 这里做两件事：内存缓存命中直接返回；未命中时限制同时只抓 4 张。
 */
const COVER_TTL = 60 * 60 * 1000
const COVER_MAX_BYTES = 48 * 1024 * 1024
const COVER_CONCURRENCY = 4
const coverCache = new Map() // `${id}@${v}` -> { buf, type, time }
let coverBytes = 0
let coverBusy = 0
const coverQueue = []

function takeCoverSlot() {
  if (coverBusy < COVER_CONCURRENCY) {
    coverBusy++
    return Promise.resolve()
  }
  return new Promise((resolve) => coverQueue.push(resolve))
}

function freeCoverSlot() {
  const next = coverQueue.shift()
  // 有排队者就直接把名额移交过去，busy 计数保持不变
  if (next) next()
  else coverBusy--
}

function rememberCover(key, buf, type) {
  if (buf.length > 8 * 1024 * 1024) return
  const old = coverCache.get(key)
  if (old) coverBytes -= old.buf.length
  coverCache.delete(key)
  coverCache.set(key, { buf, type, time: Date.now() })
  coverBytes += buf.length
  while (coverBytes > COVER_MAX_BYTES && coverCache.size > 1) {
    const [k, v] = coverCache.entries().next().value
    coverCache.delete(k)
    coverBytes -= v.buf.length
  }
}

function sendCover(res, buf, type, cacheState = 'public, max-age=86400, immutable') {
  res.writeHead(200, {
    'Content-Type': type || 'image/jpeg',
    'Content-Length': buf.length,
    'Cache-Control': cacheState,
  })
  res.end(buf)
}

/** 封面转发：服务端取图再吐给浏览器，避免防盗链 / 浏览器侧被墙。 */
async function handleCover(url, res) {
  const id = normalizeAlbumId(url.searchParams.get('id'))
  if (!id) return sendError(res, 400, 'JM 号不合法')
  const v = url.searchParams.get('v') || '0'
  const key = `${id}@${v}`

  const hit = coverCache.get(key)
  if (hit && Date.now() - hit.time < COVER_TTL) return sendCover(res, hit.buf, hit.type)

  await takeCoverSlot()
  try {
    client.applyProxy({ proxy: config.proxy, proxyMode: config.proxyMode })
    const target = client.comicCover(id, v)
    const r = await proxyRequest(target, {
      timeout: 12000,
      proxy: client.proxyFor('image'),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/*,*/*;q=0.8',
        Referer: 'https://jmcomic.me/',
      },
    })
    if (r.status !== 200 || !r.body.length) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('cover not found')
      return
    }
    const type = r.headers['content-type'] || 'image/jpeg'
    rememberCover(key, r.body, type)
    sendCover(res, r.body, type)
  } catch {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('cover fetch failed')
  } finally {
    freeCoverSlot()
  }
}

// ---------------------------------------------------------------------------
// 在线阅读
//
// 阅读器与 PDF 是两条路：PDF 为了离线保存（要转码、要压缩、要合成），
// 阅读要的是「点开就能看」，所以这里只做两件事：
//
//   GET /api/read?id=&chapter=   章节页表（只拿图片地址，几十 KB）
//   GET /api/page?c=&p=          单页图片（服务端还原打乱，带内存缓存）
//
// 前端只传「章节 id + 页码」，真正的图片地址由服务端从 API 取，
// 这样这个接口不会被当成任意 URL 的代理（SSRF）。
// ---------------------------------------------------------------------------

const READ_META_TTL = 30 * 60 * 1000
const READ_META_MAX = 80
const readMeta = new Map() // chapterId -> { albumId, chapter, info, time }

// 章节列表 5 分钟内复用：翻下一章时只多一次 comic_read 请求，
// 而不是「拉详情 + 拉页表」两跳，切章体感快很多。
const SERIES_TTL = 5 * 60 * 1000
const seriesCache = new Map() // albumId -> { detail, time }

const PAGE_TTL = 2 * 60 * 60 * 1000
const PAGE_CACHE_MAX = 192 * 1024 * 1024
// 内存只是一层热缓存；真正让「看过的页不用再下」的是磁盘这份，见 web/pagecache.js
const pageStore = createPageStore({
  dir: path.join(DATA_DIR, 'pages'),
  limitMB: config.pageCacheMB,
})
// 本地收藏夹：不依赖 JM 账号，存 data/favorites.json
const favorites = createFavorites({ file: path.join(DATA_DIR, 'favorites.json') })
const pageCache = new Map() // `${chapterId}:${p}` -> { buf, type, etag, time }
let pageCacheBytes = 0

/** 同时最多向图源要 6 张图，再多只会把出口带宽和代理打满，页面反而更慢。 */
function createGate(limit) {
  let busy = 0
  const queue = []
  return {
    take() {
      if (busy < limit) {
        busy++
        return Promise.resolve()
      }
      return new Promise((resolve) => queue.push(resolve))
    },
    free() {
      const next = queue.shift()
      if (next) next()
      else busy--
    },
  }
}

const pageGate = createGate(6)
// 后台预热单独一套名额：否则上一章还在预热的 6 个请求会把新章节的首屏堵在后面
const prefetchGate = createGate(2)

function rememberPage(key, item) {
  const old = pageCache.get(key)
  if (old) pageCacheBytes -= old.buf.length
  pageCache.delete(key)
  pageCache.set(key, item)
  pageCacheBytes += item.buf.length
  while (pageCacheBytes > PAGE_CACHE_MAX && pageCache.size > 1) {
    const [k, v] = pageCache.entries().next().value
    pageCache.delete(k)
    pageCacheBytes -= v.buf.length
  }
}

function pruneReadMeta() {
  const now = Date.now()
  for (const [k, v] of readMeta) {
    if (now - v.time > READ_META_TTL) readMeta.delete(k)
  }
  while (readMeta.size > READ_META_MAX) {
    readMeta.delete(readMeta.keys().next().value)
  }
}

/** 按文件头判断图片格式：图源混着 jpg / webp / png，靠扩展名不可靠。 */
function sniffImageType(buf) {
  if (!buf || buf.length < 12) return 'image/jpeg'
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png'
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (buf.toString('ascii', 0, 4) === 'GIF8') return 'image/gif'
  return 'image/jpeg'
}

let _viewSharp = null
async function getViewSharp() {
  if (_viewSharp === null) {
    try {
      const mod = await import('sharp')
      _viewSharp = mod.default ?? mod
    } catch {
      _viewSharp = false
    }
  }
  return _viewSharp || null
}

/**
 * 还原后的图是 sharp 输出的 PNG，一页动辄两三 MB，翻几页就把手机内存吃满。
 * 统一转成 JPEG（网页阅读对无损没有要求），体积能降一个数量级。
 */
async function shrinkForView(buf, type) {
  if (type !== 'image/png') return { buf, type }
  const sharp = await getViewSharp()
  if (!sharp) return { buf, type }
  try {
    const out = await sharp(buf).jpeg({ quality: 88 }).toBuffer()
    return out.length < buf.length ? { buf: out, type: 'image/jpeg' } : { buf, type }
  } catch {
    return { buf, type }
  }
}

function sendPageImage(req, res, item) {
  if (req.headers['if-none-match'] === item.etag) {
    res.writeHead(304, { ETag: item.etag, 'Cache-Control': 'private, max-age=86400' })
    return res.end()
  }
  res.writeHead(200, {
    'Content-Type': item.type,
    'Content-Length': item.buf.length,
    ETag: item.etag,
    'Cache-Control': 'private, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(item.buf)
}

/** 章节页表：detail 里的 series 决定顺序，sort 是前端认的章节号。 */
async function handleRead(url, res) {
  const id = normalizeAlbumId(url.searchParams.get('id'))
  if (!id) return sendError(res, 400, 'JM 号不合法')
  const wantSort = (url.searchParams.get('chapter') || '').trim()

  await ensureClient()
  let cached = seriesCache.get(id)
  if (!cached || Date.now() - cached.time > SERIES_TTL) {
    const detail = await repo.getAlbum(id)
    cached = { detail, time: Date.now() }
    seriesCache.set(id, cached)
    if (seriesCache.size > 40) seriesCache.delete(seriesCache.keys().next().value)
  }
  const detail = cached.detail
  const series = detail.series.length
    ? detail.series
    : [{ id: detail.id, sort: 1, name: detail.name, totalPage: detail.totalPhotos || 0 }]

  const chapter =
    wantSort === ''
      ? series[0]
      : series.find((s) => String(s.sort) === wantSort) || series.find((s) => String(s.id) === wantSort)
  if (!chapter) return sendError(res, 404, '章节不存在')

  const chapterId = String(chapter.id)
  const prev = readMeta.get(chapterId)
  const fresh = prev && Date.now() - prev.time < READ_META_TTL
  // 5 分钟内重复打开同一章（翻回来、刷新）就直接用上次的页表，少一次接口请求
  const info = fresh ? prev.info : await chapterPages(client, repo, chapter, id)
  if (!info.pages.length) return sendError(res, 404, '这一章没有可阅读的页面')

  const meta = {
    albumId: id,
    chapter,
    info,
    dims: (fresh && prev.dims) || {},
    time: Date.now(),
  }
  // 重启后内存里的尺寸没了，磁盘索引还记着：补上，首屏才能按真实比例占位
  if (!Object.keys(meta.dims).length) {
    meta.dims = await pageStore.dims(String(info.id))
  }
  readMeta.set(String(info.id), meta)
  pruneReadMeta()

  // 先量出第一屏这两页的真实尺寸：阅读器按真实比例占位，图片到位不再跳动。
  // 只等两页是为了别让「点开章节」等上五六秒；其余页放在后台预热，
  // 用户往下滚时多半已经进了内存缓存。
  await Promise.allSettled(
    info.pages.slice(0, 2).map((_, i) => ensurePageImage(String(info.id), i + 1, meta)),
  )
  void Promise.allSettled(
    info.pages.slice(2, 8).map((_, i) => ensurePageImage(String(info.id), i + 3, meta, prefetchGate)),
  )

  const index = series.findIndex((s) => s.sort === chapter.sort)
  const token = url.searchParams.get('token') || ''
  const suffix = token ? `&token=${encodeURIComponent(token)}` : ''

  sendJson(res, 200, {
    ok: true,
    album: {
      id: detail.id,
      name: detail.name,
      authors: detail.authors,
      cover: coverUrl(url, detail.id, detail.addtime),
    },
    chapter: {
      id: info.id,
      sort: chapter.sort,
      name: chapter.name || info.name || `第${chapter.sort}章`,
      index: index + 1,
      total: series.length,
      pageCount: info.pages.length,
    },
    chapters: series.map((s) => ({
      sort: s.sort,
      name: s.name,
      totalPage: Number(s.totalPage) || 0,
    })),
    // src 不带 token，前端统一在 <img src> 上补；w/h 用于按真实比例占位
    pages: info.pages.map((_, i) => {
      const d = meta.dims?.[i + 1]
      return {
        i: i + 1,
        src: `/api/page?c=${encodeURIComponent(info.id)}&p=${i + 1}${suffix}`,
        w: d ? d[0] : 0,
        h: d ? d[1] : 0,
      }
    }),
  })
}

/**
 * 取一页图片（内存缓存优先）。handlePage 与「预量尺寸」共用同一条路径，
 * 保证缓存键、格式转换、尺寸记录完全一致。
 */
const pageInflight = new Map() // 同一页被「预取」和「浏览器请求」同时要时，只抓一次

async function ensurePageImage(cid, p, meta, gate = pageGate) {
  const key = `${cid}:${p}`
  const hit = pageCache.get(key)
  if (hit && Date.now() - hit.time < PAGE_TTL) {
    pageCache.delete(key) // 挪到队尾，Map 就是 LRU
    pageCache.set(key, hit)
    return hit
  }
  const pending = pageInflight.get(key)
  if (pending) return pending

  // 磁盘命中：重启服务、或内存过两小时被回收后重看同一章，直接读盘，不再向图源要
  const onDisk = await pageStore.get(cid, p)
  if (onDisk) {
    rememberPage(key, onDisk)
    if (meta) {
      meta.dims = meta.dims || {}
      if (onDisk.w && onDisk.h) meta.dims[p] = [onDisk.w, onDisk.h]
    }
    return onDisk
  }

  const page = meta?.info?.pages?.[p - 1]
  if (!page) return null

  const task = (async () => {
    await ensureClient()
    await gate.take()
    try {
      const raw = await fetchPageImageRetry(client, page.url, page.aid, page.scrambleId, {
        retries: 1,
        retryDelay: 600,
      })
      const type = sniffImageType(raw.buf)
      const view = await shrinkForView(raw.buf, type)

      let w = 0
      let h = 0
      const sharp = await getViewSharp()
      if (sharp) {
        try {
          const m = await sharp(view.buf).metadata()
          w = m.width || 0
          h = m.height || 0
        } catch {
          /* 读不出尺寸只影响占位，不影响显示 */
        }
      }

      const item = {
        buf: view.buf,
        type: view.type,
        etag: `"${crypto.createHash('md5').update(view.buf).digest('hex')}"`,
        time: Date.now(),
        w,
        h,
      }
      rememberPage(key, item)
      // 写盘是「下次阅读」的本钱；失败（磁盘满、只读）就当没缓存，不影响这次浏览
      void pageStore.put(cid, p, item)
      if (meta && w && h) {
        meta.dims = meta.dims || {}
        meta.dims[p] = [w, h]
      }
      return item
    } finally {
      gate.free()
    }
  })()

  pageInflight.set(key, task)
  try {
    return await task
  } finally {
    pageInflight.delete(key)
  }
}

// 读到第 p 页时，顺手把后 3 页排进后台队列。用户多半会往下滑，
// 滑到的时候图片大概率已经落盘，滚动不再一格一格等。
const prefetchAheadQueue = new Set()

function prefetchAhead(cid, p, meta) {
  const total = meta?.info?.pages?.length || 0
  if (!total) return
  for (let i = 1; i <= 3; i++) {
    const next = p + i
    if (next > total) break
    const key = `${cid}:${next}`
    if (pageCache.has(key) || pageInflight.has(key) || prefetchAheadQueue.has(key)) continue
    prefetchAheadQueue.add(key)
    ensurePageImage(cid, next, meta, prefetchGate)
      .catch(() => {})
      .finally(() => prefetchAheadQueue.delete(key))
  }
}

async function handlePage(url, req, res) {
  const cid = String(url.searchParams.get('c') || '').replace(/\D/g, '')
  const p = parseInt(url.searchParams.get('p'), 10) || 0
  if (!cid || p < 1) return sendError(res, 400, '参数不合法')

  const key = `${cid}:${p}`
  let meta = readMeta.get(cid)
  if (!meta || Date.now() - meta.time > READ_META_TTL) {
    // 服务重启 / 元信息被回收。先看磁盘：这一页在本地就不必为了「拿到图片地址」再拉一次章节页表。
    const disk = pageCache.has(key) ? null : await pageStore.get(cid, p)
    if (disk) {
      rememberPage(key, disk)
      return sendPageImage(req, res, disk)
    }
    // 仍然只信任 API 返回的图片地址
    const albumId = meta?.albumId || ''
    const info = await chapterPages(client, repo, { id: cid, name: '', sort: 0 }, albumId)
    meta = { albumId, chapter: null, info, dims: {}, time: Date.now() }
    readMeta.set(cid, meta)
    pruneReadMeta()
  }

  try {
    const item = await ensurePageImage(cid, p, meta)
    if (!item) return sendError(res, 404, '页码超出范围')
    sendPageImage(req, res, item)
    prefetchAhead(cid, p, meta)
  } catch (err) {
    sendError(res, 502, err?.serverMessage || err?.message || '图片获取失败')
  }
}

async function handleCreateJob(req, res) {
  const body = await readJsonBody(req)
  const id = normalizeAlbumId(body.id)
  if (!id) return sendError(res, 400, 'JM 号不合法')

  const mode = body.mode === 'zip' ? 'zip' : 'single'

  // 章节范围：from/to 为章节序号（sort）；兼容老的 chapter 参数
  const toInt = (v) => {
    if (v == null || v === '') return null
    const n = parseInt(v, 10)
    return Number.isFinite(n) && n > 0 ? n : NaN
  }
  let from = toInt(body.from)
  let to = toInt(body.to)
  if (body.chapter != null && body.chapter !== '') from = to = toInt(body.chapter)
  if (Number.isNaN(from) || Number.isNaN(to)) return sendError(res, 400, '章节序号不合法')
  if (from != null && to != null && from > to) [from, to] = [to, from]

  const encrypt = ['none', 'id', 'custom'].includes(body.encrypt) ? body.encrypt : 'none'
  let password = ''
  if (encrypt === 'custom') {
    password = String(body.password || '').trim()
    if (!password) return sendError(res, 400, '请填写 PDF 打开密码')
    if (password.length > 32) return sendError(res, 400, '密码最多 32 个字符')
  } else if (encrypt === 'id') {
    password = id
  }

  await ensureClient()

  const range = from == null && to == null ? null : { from, to }
  const { detail, chapters } = await resolveChapters(repo, id, range)
  const estimated = chapters.reduce((sum, s) => sum + (Number(s.totalPage) || 0), 0)

  // 整本时把实际首尾章记下来，取消/命名时更直观
  const whole = from == null && to == null
  if (whole) {
    from = chapters[0]?.sort ?? 1
    to = chapters[chapters.length - 1]?.sort ?? 1
  }

  const maxPages = Number(config.maxPages) || 0
  if (maxPages > 0 && estimated > maxPages) {
    return sendError(
      res,
      400,
      `所选范围约 ${estimated} 页，超过上限 ${maxPages} 页，请缩小范围或调高上限`,
    )
  }

  if (mode === 'single' && estimated > MERGE_PAGE_LIMIT) {
    return sendError(
      res,
      400,
      `所选范围约 ${estimated} 页，单个 PDF 上限 ${MERGE_PAGE_LIMIT} 页（再多会撑爆内存）。请改用「每章一个 PDF 打包」，或缩小章节范围。`,
    )
  }

  // 章节元信息里没有 total_page 时 estimated 是 0，上面的上限拦不住。
  // 这种多章作品合并成一个 PDF 几乎必然超限，直接说清楚，别让用户等十几分钟才看到失败。
  if (mode === 'single' && estimated === 0 && chapters.length > MERGE_CHAPTER_HINT) {
    return sendError(
      res,
      400,
      `该作品共 ${chapters.length} 章、页数未知，合并成一个 PDF 很可能超过 ${MERGE_PAGE_LIMIT} 页。` +
        '请改用「每章一个 PDF 打包」（可一次选中多章），或把范围缩到几章再试。',
    )
  }

  const job = jobs.create({
    albumId: id,
    from,
    to,
    whole,
    mode,
    title: detail.name,
    pages: estimated,
    encrypt,
    password,
  })

  sendJson(res, 200, { ok: true, job })
}

/** 发送文件，支持 Range 续传；任务下载与缓存下载共用。 */
async function sendFile(req, res, file, { utf8Name, asciiName, contentType }) {
  const size = (await stat(file)).size
  const encoded = encodeURIComponent(utf8Name).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  const headers = {
    'Content-Type': contentType,
    'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encoded}`,
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'bytes',
  }

  // 支持 Range：下行中断后浏览器/下载器可以接着续传，不必整个重下
  const range = req.headers.range
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim())
    if (m && (m[1] !== '' || m[2] !== '')) {
      let start = m[1] === '' ? size - Number(m[2]) : Number(m[1])
      let end = m[2] === '' || m[1] === '' ? size - 1 : Number(m[2])
      if (!Number.isFinite(start) || start < 0) start = 0
      end = Math.min(Number.isFinite(end) ? end : size - 1, size - 1)
      if (start > end || start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' })
        return res.end()
      }
      res.writeHead(206, {
        ...headers,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': end - start + 1,
      })
      return fs.createReadStream(file, { start, end }).pipe(res)
    }
  }

  res.writeHead(200, { ...headers, 'Content-Length': size })
  fs.createReadStream(file).pipe(res)
}

function pdfName(name, id, chapter) {
  return `${fileSafeName(name || `JM${id}`)}_JM${id}${chapter != null ? `_第${chapter}章` : ''}.pdf`
}

function rangeLabel(from, to) {
  if (from == null && to == null) return ''
  if (from === to) return `_第${from}章`
  return `_第${from}-${to}章`
}

async function handleDownload(url, req, res) {
  const id = url.pathname.split('/')[3]
  const job = jobs.getRaw(id)
  if (!job) return sendError(res, 404, '任务不存在或已过期')
  if (job.status !== 'done') return sendError(res, 409, '任务尚未完成')
  if (!job.file || !fs.existsSync(job.file)) return sendError(res, 410, '生成的文件已被清理，请重新生成')

  const rangeText = job.whole ? '' : rangeLabel(job.from, job.to)
  const base = `${fileSafeName(job.title || `JM${job.albumId}`)}_JM${job.albumId}${rangeText}`

  if (job.kind === 'zip') {
    return sendFile(req, res, job.file, {
      utf8Name: `${base}${job.whole ? `_全${job.chapterCount || job.files || 0}章` : ''}.zip`,
      asciiName: `JM${job.albumId}.zip`,
      contentType: 'application/zip',
    })
  }

  return sendFile(req, res, job.file, {
    utf8Name: `${base}.pdf`,
    asciiName: `JM${job.albumId}.pdf`,
    contentType: 'application/pdf',
  })
}

/** 直接下载本地缓存：任务列表因重启丢失后，仍能从缓存里把 PDF 取走。 */
async function handleCacheDownload(req, res, key) {
  const list = await listCache()
  const meta = list.find((it) => it.file === `${key}.pdf`)
  if (!meta) return sendError(res, 404, '缓存不存在')
  const file = path.join(PDF_DIR, meta.file)
  if (!fs.existsSync(file)) return sendError(res, 410, 'PDF 文件已被清理')

  return sendFile(req, res, file, {
    utf8Name: pdfName(meta.name, meta.id, meta.chapter),
    asciiName: `JM${meta.id}.pdf`,
    contentType: 'application/pdf',
  })
}

function handleJobEvents(url, req, res) {
  const id = url.pathname.split('/')[3]
  const job = jobs.get(id)
  if (!job) return sendError(res, 404, '任务不存在')

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })

  const unsubscribe = jobs.subscribe(id, res)
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n')
    } catch {
      /* 连接已断，等 close 事件收尾 */
    }
  }, 15000)

  const cleanup = () => {
    clearInterval(heartbeat)
    unsubscribe?.()
  }
  req.on('close', cleanup)
  req.on('error', cleanup)
}

async function handleConfigSave(req, res) {
  const patch = await readJsonBody(req)
  const before = config.proxy
  await saveConfig(patch)

  client.applyProxy({ proxy: config.proxy, proxyMode: config.proxyMode })
  pageStore.setLimitMB(config.pageCacheMB)
  // 代理变了就重新探测 API 主机
  if (before !== config.proxy) client.apiUrl = null

  sendJson(res, 200, { ok: true, config: publicConfig() })
}

async function handleProxyTest(req, res) {
  const body = await readJsonBody(req)
  const text = body.proxy ?? config.proxy
  const list = parseProxyList(text)
  if (!list.length) return sendError(res, 400, '还没有填写代理地址')

  const results = []
  for (const p of list) {
    try {
      const r = await testProxy(p, 10000)
      results.push({ proxy: maskProxy(p), ok: true, ms: r.ms, ip: r.ip, loc: r.loc })
    } catch (err) {
      results.push({ proxy: maskProxy(p), ok: false, error: err.message })
    }
  }
  sendJson(res, 200, { ok: true, results })
}

// ---------------------------------------------------------------------------
// 收藏
// ---------------------------------------------------------------------------

/** 收藏列表：只回轻量字段，封面由前端按 id 现取（服务端有封面缓存）。 */
async function handleFavoritesList(res) {
  const items = await favorites.list()
  sendJson(res, 200, {
    ok: true,
    total: items.length,
    items: items.map((it) => ({ ...it, cover: `/api/cover?id=${it.id}&v=0` })),
  })
}

async function handleFavoriteAdd(req, res) {
  const body = await readJsonBody(req)
  const id = normalizeAlbumId(body.id)
  if (!id) return sendError(res, 400, 'JM 号不合法')

  let name = String(body.name || '').trim()
  let author = String(body.author || '').trim()
  let totalPages = Number(body.totalPages) || 0

  // 从卡片/详情加的时候前端已经带了名字；只有直接调接口才回源补全
  if (!name) {
    await ensureClient()
    const d = await repo.getAlbum(id)
    name = d.name || `JM${id}`
    author = (d.authors || [])[0] || ''
    totalPages = totalPages || Number(d.totalPhotos) || 0
  }

  const item = await favorites.add({ id, name, author, totalPages, sort: Number(body.sort) || 0 })
  sendJson(res, 200, { ok: true, item, total: (await favorites.stats()).total })
}

async function handleFavoriteRemove(url, res, raw) {
  const id = normalizeAlbumId(raw ?? url.searchParams.get('id'))
  if (!id) return sendError(res, 400, 'JM 号不合法')
  const removed = await favorites.remove(id)
  sendJson(res, 200, { ok: true, removed, id, total: (await favorites.stats()).total })
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

async function handleApi(req, res, url) {
  if (!checkToken(req, url)) {
    const left = authLockLeft(req)
    if (left > 0) {
      res.setHeader('Retry-After', String(left))
      return sendError(res, 429, `口令错误次数过多，已临时锁定，约 ${Math.max(1, Math.ceil(left / 60))} 分钟后恢复`)
    }
    return sendError(res, 401, '需要访问口令')
  }

  const p = url.pathname.replace(/^\/api/, '') || '/'
  const method = req.method || 'GET'

  // 所有业务接口共用的错误兜底
  try {
    if (method === 'GET' && p === '/health') {
      return sendJson(res, 200, {
        ok: true,
        ready: !!client.apiUrl,
        running: jobs.runningCount,
        queued: jobs.queuedCount,
      })
    }
    if (method === 'GET' && p === '/config') {
      return sendJson(res, 200, { ok: true, config: publicConfig() })
    }
    if (method === 'POST' && p === '/config') return await handleConfigSave(req, res)
    if (method === 'POST' && p === '/proxy/test') return await handleProxyTest(req, res)
    if (method === 'GET' && p === '/search') return await handleSearch(url, res)
    if (method === 'GET' && p === '/album') return await handleAlbum(url, res)
    if (method === 'GET' && p === '/cover') return await handleCover(url, res)
    if (method === 'GET' && p === '/read') return await handleRead(url, res)
    if (method === 'GET' && p === '/page') return await handlePage(url, req, res)

    if (method === 'GET' && p === '/favorites') return await handleFavoritesList(res)
    if (method === 'POST' && p === '/favorites') return await handleFavoriteAdd(req, res)
    if (method === 'DELETE' && p.startsWith('/favorites')) {
      return await handleFavoriteRemove(url, res, p.split('/')[2])
    }

    if (method === 'POST' && p === '/jobs') return await handleCreateJob(req, res)
    if (method === 'GET' && p === '/jobs') return sendJson(res, 200, { ok: true, jobs: jobs.list() })
    if (p.startsWith('/jobs/')) {
      const parts = p.split('/').filter(Boolean) // ['jobs', id, 'events'|'download']
      const [, id, action] = parts
      if (method === 'GET' && action === 'events') return handleJobEvents(url, req, res)
      if (method === 'GET' && action === 'download') return await handleDownload(url, req, res)
      if (method === 'GET' && !action) {
        const job = jobs.get(id)
        return job ? sendJson(res, 200, { ok: true, job }) : sendError(res, 404, '任务不存在')
      }
      if (method === 'DELETE' && !action) {
        return jobs.remove(id) ? sendJson(res, 200, { ok: true }) : sendError(res, 404, '任务不存在')
      }
    }

    if (method === 'GET' && p === '/cache') {
      const list = await listCache()
      return sendJson(res, 200, {
        ok: true,
        total: list.length,
        size: list.reduce((s, it) => s + (it.size || 0), 0),
        pages: pageStore.stats(),
        items: list.map((it) => ({
          key: String(it.file || '').replace(/\.pdf$/, ''),
          id: it.id,
          chapter: it.chapter,
          name: it.name || `JM${it.id}`,
          tag: it.tag || '',
          pageCount: it.pageCount || 0,
          size: it.size || 0,
          time: it.time || 0,
        })),
      })
    }
    if (method === 'GET' && p.startsWith('/cache/') && p.endsWith('/download')) {
      const key = decodeURIComponent(p.split('/')[2] || '')
      return await handleCacheDownload(req, res, key)
    }
    if (method === 'DELETE' && p.startsWith('/cache/')) {
      const seg = p.split('/').filter(Boolean) // ['cache', id]
      const id = seg[1]
      if (id === 'pages') {
        const before = pageStore.stats()
        await pageStore.clear()
        return sendJson(res, 200, { ok: true, removed: before.files, size: before.size })
      }
      if (id === 'all') {
        const n = await removeCachedPdf('all')
        return sendJson(res, 200, { ok: true, removed: n })
      }
      const chapter = url.searchParams.get('chapter')
      const n = await removeCachedPdf(id, chapter ? parseInt(chapter, 10) : null)
      return sendJson(res, 200, { ok: true, removed: n })
    }

    sendError(res, 404, '接口不存在')
  } catch (err) {
    const msg = err?.serverMessage || err?.message || '服务器内部错误'
    // 认证类错误单独提示，前端可引导去设置代理
    sendError(res, 500, msg)
  }
}

/** 文本类静态资源才值得 gzip。 */
const GZIP_EXT = new Set(['.html', '.js', '.css', '.json', '.svg', '.txt', '.webmanifest'])
const gzCache = new Map() // etag -> Buffer

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname)
  if (pathname === '/' || pathname === '') pathname = '/index.html'

  // 只允许访问 public 目录下的已知静态资源
  const full = path.join(PUBLIC_DIR, pathname)
  if (!full.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403)
    res.end('forbidden')
    return
  }
  const ext = path.extname(full).toLowerCase()
  if (!MIME[ext]) {
    res.writeHead(404)
    res.end('not found')
    return
  }

  // 带 ?v=N 的资源内容变了 URL 才会变，可以放心让浏览器长期强缓存；
  // 没带版本号的（比如直接敲地址打开的 index.html）保持协商缓存，保证能及时更新。
  const versioned = url.searchParams.has('v')
  const cacheControl = versioned ? 'public, max-age=31536000, immutable' : 'no-cache'

  try {
    const st = await stat(full)
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': cacheControl })
      res.end()
      return
    }

    let data = await readFile(full)
    let encoding = null
    if (GZIP_EXT.has(ext) && data.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      let gz = gzCache.get(etag)
      if (!gz) {
        gz = gzipSync(data, { level: 6 })
        if (gzCache.size > 32) gzCache.clear()
        gzCache.set(etag, gz)
      }
      // 压不小就别压了（超短文件反而变大）
      if (gz.length < data.length) {
        data = gz
        encoding = 'gzip'
      }
    }

    res.writeHead(200, {
      'Content-Type': MIME[ext],
      'Content-Length': data.length,
      ETag: etag,
      'Cache-Control': cacheControl,
      Vary: 'Accept-Encoding',
      ...(encoding ? { 'Content-Encoding': encoding } : {}),
    })
    res.end(data)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('not found')
  }
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

async function main() {
  await loadConfig()
  client.applyProxy({ proxy: config.proxy, proxyMode: config.proxyMode })
  pageStore.setLimitMB(config.pageCacheMB) // 磁盘上限以配置文件为准，模块创建时还是默认值

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const started = Date.now()
    // 慢请求打日志：下次觉得「卡」的时候，看控制台就知道卡在哪个接口
    res.on('finish', () => {
      if (String(res.getHeader('Content-Type') || '').includes('event-stream')) return
      const ms = Date.now() - started
      if (ms > 1200) console.log(`[slow] ${req.method} ${url.pathname}${url.search} ${ms}ms`)
    })
    try {
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url)
      } else {
        await serveStatic(req, res, url)
      }
    } catch (err) {
      if (!res.headersSent) sendError(res, 500, err?.message || '服务器内部错误')
      else res.end()
    }
  })

  // 默认 keepAliveTimeout 只有 5 秒，浏览器复用一条刚好被服务端关掉的连接时会
  // 卡住再重试，体感就是「首屏莫名慢 5 秒」。调长到 65 秒避开这个竞态。
  server.keepAliveTimeout = 65000
  server.headersTimeout = 70000

  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  })

  // 端口被占 / 没权限绑定低端口时，给出人能看懂的提示，而不是一串 node 堆栈
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error('')
      console.error(`  ✗ 端口 ${options.port} 已被占用。`)
      console.error('    多半是上一次的服务还在后台跑（它可能只监听了 127.0.0.1，所以你从别的设备访问不到）。')
      console.error(`    先结束旧进程：lsof -i :${options.port}  或  kill $(pgrep -f "web/server.js")`)
      console.error('    或者换个端口启动：npm run web:lan -- --port 7789')
      console.error('')
    } else if (err.code === 'EACCES') {
      console.error(`  ✗ 没有权限监听 ${options.host}:${options.port}，请换一个大于 1024 的端口。`)
    } else {
      console.error('  ✗ 服务启动失败：', err)
    }
    process.exit(1)
  })

  server.listen(options.port, options.host, () => {
    const host = options.host === '0.0.0.0' ? 'localhost' : options.host
    console.log('')
    console.log('  JM Reader Web 已启动')
    console.log(`  ➜  http://${host}:${options.port}${options.token ? `?token=${options.token}` : ''}`)

    if (options.host === '0.0.0.0' || options.host === '::') {
      console.log(`  ➜  监听 ${options.host}:${options.port}（局域网 / 组网可访问）`)
      const urls = lanUrls(options.port)
      if (urls.length) {
        console.log('  ➜  其它设备可用的地址：')
        for (const it of urls) console.log(`       ${it.url}   (${it.tag})`)
      } else {
        console.log('  ➜  没有检测到非回环网卡，检查一下网络连接')
      }
      if (!options.token) {
        console.warn('  ⚠️  已对本机以外的设备开放，但没有设置访问口令 —— 拿到地址的人都能用')
        console.warn('     建议改为：--host 0.0.0.0 --token 你的口令')
      }
    } else {
      console.log(`  ➜  监听 ${options.host}:${options.port}`)
      console.warn('  ⚠️  当前只允许本机访问：手机 / 平板 / 其它电脑连不上。')
      console.warn('     要组网或局域网访问，用：npm run web:lan')
      console.warn('     或：node web/server.js --host 0.0.0.0 --token 你的口令')
    }

    if (options.trustProxy) console.log('  ➜  信任反向代理的 X-Forwarded-For')
    console.log(`  ➜  代理：${client.proxySummary().text}`)
    console.log(`  ➜  数据目录：${path.join(__dirname, '..', 'data')}`)
    console.log('')
  })

  const shutdown = () => {
    console.log('\n正在关闭…')
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error('启动失败：', err)
  process.exit(1)
})
