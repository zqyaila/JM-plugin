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
import crypto from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import JmClient from '../apps/jmcore.js'
import JmRepository from '../apps/jm.js'
import { getCachedPdf, listCache, removeCachedPdf, PDF_DIR } from '../apps/store.js'
import { proxyRequest, testProxy, parseProxyList, maskProxy } from '../apps/proxy.js'
import { config, loadConfig, saveConfig, publicConfig, resolveServerOptions } from './config.js'
import { createJobManager } from './jobs.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.join(__dirname, 'public')
const SERVER_PAGE_SIZE = 80 // 服务端搜索接口固定每页 80 条

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

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

let bootstrapping = null

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
  await bootstrapping
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
const authFails = new Map() // ip -> { count, until }

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

function authLocked(req) {
  const rec = authFails.get(clientIp(req))
  return !!(rec?.until && rec.until > Date.now())
}

function checkToken(req, url) {
  if (!options.token) return true
  const ip = clientIp(req)
  const rec = authFails.get(ip)
  if (rec?.until && rec.until > Date.now()) return false
  if (rec?.until) authFails.delete(ip)

  const given = req.headers['x-token'] || url.searchParams.get('token') || ''
  if (given && tokenEquals(given)) {
    authFails.delete(ip)
    return true
  }

  const next = authFails.get(ip) || { count: 0, until: 0 }
  next.count += 1
  if (next.count >= AUTH_MAX_FAIL) {
    next.count = 0
    next.until = Date.now() + AUTH_LOCK_MS
    console.warn(`[auth] ${ip} 口令连续错误 ${AUTH_MAX_FAIL} 次，已锁定 10 分钟`)
  }
  authFails.set(ip, next)
  return false
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
    cover: `/api/cover?id=${encodeURIComponent(it.id)}&v=${it.updateAt || 0}`,
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
      cover: `/api/cover?id=${encodeURIComponent(d.id)}&v=${d.addtime || 0}`,
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

/** 封面转发：服务端取图再吐给浏览器，避免防盗链 / 浏览器侧被墙。 */
async function handleCover(url, res) {
  const id = normalizeAlbumId(url.searchParams.get('id'))
  if (!id) return sendError(res, 400, 'JM 号不合法')
  const v = url.searchParams.get('v') || '0'

  client.applyProxy({ proxy: config.proxy, proxyMode: config.proxyMode })
  const target = client.comicCover(id, v)

  try {
    const r = await proxyRequest(target, {
      timeout: 20000,
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
    res.writeHead(200, {
      'Content-Type': r.headers['content-type'] || 'image/jpeg',
      'Content-Length': r.body.length,
      'Cache-Control': 'public, max-age=86400',
    })
    res.end(r.body)
  } catch {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('cover fetch failed')
  }
}

async function handleCreateJob(req, res) {
  const body = await readJsonBody(req)
  const id = normalizeAlbumId(body.id)
  if (!id) return sendError(res, 400, 'JM 号不合法')

  const chapter = body.chapter == null || body.chapter === '' ? null : parseInt(body.chapter, 10)
  if (chapter != null && (!Number.isFinite(chapter) || chapter <= 0)) {
    return sendError(res, 400, '章节序号不合法')
  }

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

  // 先拿详情：既用于文件名，也用于页数上限校验
  const detail = await repo.getAlbum(id)
  const series = detail.series.length ? detail.series : [{ id: detail.id, sort: 1, name: detail.name, totalPage: 0 }]
  const chosen = chapter == null ? series : [series.find((s) => s.sort === chapter) || series[0]]
  const estimated = chosen.reduce((sum, s) => sum + (Number(s.totalPage) || 0), 0)

  const maxPages = Number(config.maxPages) || 0
  if (maxPages > 0 && estimated > maxPages) {
    return sendError(
      res,
      400,
      `该作品约 ${estimated} 页，超过单次上限 ${maxPages} 页，请改为单章下载或调高上限`,
    )
  }

  const job = jobs.create({
    albumId: id,
    chapter,
    title: detail.name,
    pages: estimated,
    encrypt,
    password,
  })

  sendJson(res, 200, { ok: true, job })
}

/** 发送 PDF 文件，支持 Range 续传；job 下载与缓存下载共用。 */
async function sendPdfFile(req, res, file, utf8Name, asciiName) {
  const size = (await stat(file)).size
  const encoded = encodeURIComponent(utf8Name).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  const headers = {
    'Content-Type': 'application/pdf',
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

async function handleDownload(url, req, res) {
  const id = url.pathname.split('/')[3]
  const job = jobs.get(id)
  if (!job) return sendError(res, 404, '任务不存在或已过期')
  if (job.status !== 'done') return sendError(res, 409, '任务尚未完成')

  const cached = await getCachedPdf(job.albumId, job.chapter)
  if (!cached) return sendError(res, 410, 'PDF 文件已被清理，请重新生成')

  return sendPdfFile(
    req,
    res,
    cached.file,
    pdfName(job.title, job.albumId, job.chapter),
    `JM${job.albumId}.pdf`,
  )
}

/** 直接下载本地缓存：任务列表因重启丢失后，仍能从缓存里把 PDF 取走。 */
async function handleCacheDownload(req, res, key) {
  const list = await listCache()
  const meta = list.find((it) => it.file === `${key}.pdf`)
  if (!meta) return sendError(res, 404, '缓存不存在')
  const file = path.join(PDF_DIR, meta.file)
  if (!fs.existsSync(file)) return sendError(res, 410, 'PDF 文件已被清理')

  return sendPdfFile(
    req,
    res,
    file,
    pdfName(meta.name, meta.id, meta.chapter),
    `JM${meta.id}.pdf`,
  )
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
// 路由
// ---------------------------------------------------------------------------

async function handleApi(req, res, url) {
  if (!checkToken(req, url)) {
    if (authLocked(req)) return sendError(res, 429, '口令错误次数过多，请 10 分钟后再试')
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
        items: list.map((it) => ({
          key: String(it.file || '').replace(/\.pdf$/, ''),
          id: it.id,
          chapter: it.chapter,
          name: it.name || `JM${it.id}`,
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

/** 静态资源：带 ETag 协商缓存，避免升级后浏览器仍用旧样式。 */
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

  try {
    const st = await stat(full)
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' })
      res.end()
      return
    }
    const data = await readFile(full)
    res.writeHead(200, {
      'Content-Type': MIME[ext],
      'Content-Length': data.length,
      ETag: etag,
      'Cache-Control': 'no-cache',
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

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
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

  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  })

  server.listen(options.port, options.host, () => {
    const host = options.host === '0.0.0.0' ? 'localhost' : options.host
    console.log('')
    console.log('  JM Reader Web 已启动')
    console.log(`  ➜  http://${host}:${options.port}`)
    console.log(`  ➜  监听 ${options.host}:${options.port}${options.token ? '（已启用访问口令）' : ''}`)
    if (options.host === '0.0.0.0' && !options.token) {
      console.warn('  ⚠️  已对局域网/公网开放，但没有设置访问口令 —— 拿到地址的人都能用')
      console.warn('     建议改为：--host 0.0.0.0 --token 你的口令')
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
