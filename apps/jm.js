/**
 * JM Reader 数据仓库层（Node.js 版）
 *
 * 对应 Kotlin 端 data/repo/AppRepository.kt，封装类型化接口方法。
 * 不含广告 / 金币 / 充值相关接口。
 */

import JmClient, { needsDescramble, sliceCount } from './jmcore.js'
import { proxyRequest } from './proxy.js'

/** 图片打乱还原：优先用 sharp，没有则返回原图字节。 */
let _sharp = null
async function loadSharp() {
  if (_sharp === null) {
    try {
      const mod = await import('sharp')
      _sharp = mod.default ?? mod
    } catch {
      _sharp = false
    }
  }
  return _sharp || null
}

/**
 * 下载一张图片并（可选）打乱还原。
 * @returns {Promise<{ buf: Buffer, ext: string, descrambled: boolean }>}
 */
export async function fetchPageImage(client, url, aid, scrambleId) {
  const res = await rawGet(client, url)
  if (!res) throw new Error('图片下载失败')
  let buf = res
  const pageName = fileName(url)

  if (needsDescramble(aid, scrambleId, url)) {
    const sharp = await loadSharp()
    if (sharp) {
      const num = sliceCount(aid, pageName)
      if (num > 1) {
        try {
          const img = sharp(buf)
          const meta = await img.metadata()
          const { width: w, height: h } = meta
          if (w > 0 && h > 0 && h >= num) {
            const baseH = Math.floor(h / num)
            const rem = h % num
            // 按 Kotlin 端 descramble 的几何：第 0 条取 baseH+rem，其余 baseH；
            // 源条带从底部往上取，目标从上往下放。
            const composites = []
            for (let i = 0; i < num; i++) {
              const copyH = i === 0 ? baseH + rem : baseH
              const srcY = h - baseH * (i + 1) - rem
              const dstY = i === 0 ? 0 : baseH * i + rem
              if (srcY >= 0 && srcY + copyH <= h) {
                composites.push({
                  input: await sharp(buf)
                    .extract({ left: 0, top: srcY, width: w, height: copyH })
                    .toBuffer(),
                  top: dstY,
                  left: 0,
                })
              }
            }
            if (composites.length) {
              buf = await sharp({
                create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
              })
                .composite(composites)
                .png()
                .toBuffer()
              return { buf, ext: 'png', descrambled: true }
            }
          }
        } catch {
          // 还原失败则回退原图
        }
      }
    }
  }
  return { buf, ext: 'jpg', descrambled: false }
}

/**
 * 极简二进制 GET。
 * 图片 CDN 常被墙或限速，因此与 API 请求共用同一套代理配置：
 * 由 client.rotateProxy('image') 决定是否走代理（proxyMode 为 all / image 时生效）。
 */
async function rawGet(client, url) {
  const proxy = client?.rotateProxy?.('image') ?? null
  try {
    const res = await proxyRequest(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        Referer: 'https://jmcomic.me/',
      },
      timeout: 25000,
      proxy,
    })
    if (res.status >= 400) return null
    return res.body
  } catch {
    return null
  }
}

/** 休眠。 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 带重试的图片下载：失败重试 retries 次，每次间隔 retryDelay ms。
 * @returns {Promise<{ buf: Buffer, ext: string, descrambled: boolean }>}
 */
export async function fetchPageImageRetry(client, url, aid, scrambleId, { retries = 3, retryDelay = 2000 } = {}) {
  let lastErr
  for (let i = 0; i <= retries; i++) {
    try {
      return await fetchPageImage(client, url, aid, scrambleId)
    } catch (e) {
      lastErr = e
      if (i < retries) await sleep(retryDelay)
    }
  }
  throw lastErr || new Error('图片下载失败')
}

function fileName(url) {
  const path = String(url).split('?')[0]
  const seg = path.split('/').pop()
  return seg.split('.')[0] || seg
}

// ---------------------------------------------------------------------------
// 类型化仓库（部分方法，按需扩展）
// ---------------------------------------------------------------------------

export class JmRepository {
  constructor(client) {
    this.client = client
  }

  // --- 首页 / 列表 ---

  /** GET /promote */
  async getPromote() {
    const arr = await this.client.get('promote')
    const sections = []
    if (Array.isArray(arr)) {
      for (const sec of arr) {
        if (sec && Array.isArray(sec.content)) {
          sections.push(sec.content.map(comicListItem).filter((x) => x && x.id))
        }
      }
    }
    return sections
  }

  /** GET /latest?page= */
  async getLatest(page = 1) {
    const arr = await this.client.get('latest', { page })
    return (Array.isArray(arr) ? arr : []).map(comicListItem).filter((x) => x && x.id)
  }

  /** GET /hot_tags */
  async hotTags() {
    const obj = await this.client.get('hot_tags')
    let list = obj
    if (obj && Array.isArray(obj.data)) list = obj.data
    if (Array.isArray(list)) {
      return list.map((o) => ({
        id: o.id || o.tag || '',
        title: o.title || o.tag || '',
        count: Number(o.count || 0),
      }))
    }
    return []
  }

  /** GET /random_recommend */
  async randomRecommend() {
    const obj = await this.client.get('random_recommend')
    return parseComicList(obj)
  }

  // --- 搜索 ---

  /**
   * GET /search - 自适应搜索。纯数字 / JM123456 / 链接会由服务端返回 redirect_aid。
   * @returns {Promise<{query, total, redirectAid, items}>}
   */
  async search(keyword, page = 1, searchType = 'site') {
    const params = { search_query: keyword, page, o: 'mr' }
    if (searchType) params.search_type = searchType
    const obj = await this.client.get('search', params)
    const o = obj || {}
    const redirect = Number(o.redirect_aid || 0)
    return {
      query: o.search_query || keyword,
      searchType: o.search_type || searchType || 'site',
      total: Number(o.total || 0),
      redirectAid: redirect > 0 ? String(redirect) : null,
      items: parseComicList(o),
    }
  }

  // --- 分类 ---

  /** GET /categories -> [{slug,title,subCategories}] */
  async categories() {
    const obj = await this.client.get('categories')
    const arr = obj?.categories || (Array.isArray(obj) ? obj : [])
    return arr.map((o) => ({
      slug: o.slug || o.id || '',
      title: o.name || o.title || '',
      subCategories: (o.sub_categories || []).map((s) => ({
        slug: s.slug || s.id || '',
        title: s.name || s.title || '',
      })),
    }))
  }

  /** GET /categories/filter?c=&o=&page= */
  async categoriesFilter(c, o = '', page = 1) {
    const obj = await this.client.get('categories/filter', { c, o, page })
    return parseComicList(obj)
  }

  // --- 作品详情 / 阅读 ---

  /** GET /album?id= */
  async getAlbum(id) {
    const o = await this.client.get('album', { id })
    if (!o || !o.id) throw new Error('作品不存在或已下架')
    return {
      id: String(o.id),
      name: o.name || '',
      authors: toStrList(o.author),
      description: o.description || '',
      addtime: Number(o.addtime || 0),
      totalViews: Number(o.total_views || 0),
      totalPhotos: Number(o.total_photos || 0),
      likes: Number(o.likes || 0),
      commentTotal: Number(o.comment_total || 0),
      tags: toStrList(o.tags),
      series: (o.series || []).map((s) => ({
        id: String(s.id),
        sort: Number(s.sort || 0),
        name: s.name || '',
        totalPage: Number(s.total_page || 0),
      })),
      seriesId: o.series_id || null,
      relatedList: (o.related_list || []).map(comicListItem).filter((x) => x && x.id),
      liked: !!o.liked,
      isFavorite: !!o.is_favorite,
      price: o.price || null,
      purchased: !!(o.purchased && String(o.purchased) !== ''),
    }
  }

  /** GET /comic_read?id= */
  async comicRead(id) {
    const o = await this.client.get('comic_read', { id })
    if (!o || !o.id) throw new Error('章节不存在')
    return {
      id: String(o.id),
      name: o.name || '',
      scrambleId: Number(o.scramble_id || 0),
      totalPage: Number(o.total_page || 0),
      images: (o.images || []).map((p) => ({
        page: Number(p.page || 0),
        image: p.image || '',
      })),
      seriesId: o.series_id || null,
    }
  }

  // --- 评论区 ---

  /** GET /forum?mode=manhua&aid=&page= */
  async albumComments(aid, page = 1) {
    const obj = await this.client.get('forum', { mode: 'manhua', aid, page })
    let list = []
    let total = 0
    if (Array.isArray(obj)) {
      list = obj
      total = obj.length
    } else if (obj && obj.list) {
      list = obj.list
      total = Number(obj.total || 0) || list.length
    }
    return {
      total,
      items: list.map((o) => ({
        cid: String(o.CID || o.cid || ''),
        uid: String(o.UID || o.uid || ''),
        username: o.username || o.nickname || '',
        content: o.content || '',
        likes: Number(o.likes || 0),
        addtime: o.addtime || '',
        levelName: (o.expinfo && o.expinfo.level_name) || o.title || '',
        parentCid: String(o.parent_CID || o.parent_cid || '').trim(),
      })),
    }
  }

  // --- 会员 / 登录 ---

  /** POST /login {username,password} */
  async login(username, password) {
    try {
      const data = await this.client.post('login', { username, password })
      if (!data) throw new Error('用户名或密码错误')
      const token = data.jwttoken || ''
      this.client.saveAuth(token, data)
      return {
        uid: String(data.uid || ''),
        username: data.username || '',
        nickName: data.nick_name || '',
        coin: Number(data.coin || 0),
        level: data.level || '',
        levelName: data.level_name || '',
      }
    } catch (e) {
      // 服务端 errorMsg 优先
      throw new Error(e.serverMessage || e.message || '用户名或密码错误')
    }
  }

  /** POST /register */
  async register(username, password, passwordConfirm, email, gender = 'Male') {
    const data = await this.client.post('register', {
      username,
      password,
      password_confirm: passwordConfirm,
      email,
      gender,
      verification: '',
    })
    if (data && (data.status === 'fail' || data.status === 'error')) {
      const errs = Array.isArray(data.errors) ? data.errors.join('\n') : data.msg || '注册失败'
      throw new Error(errs)
    }
    return (data && data.msg) || '注册成功，请前往邮箱确认'
  }

  /** POST /logout */
  async logout() {
    try {
      await this.client.post('logout')
    } finally {
      this.client.clearAuth()
    }
  }

  // --- 收藏 / 历史 ---

  /** GET /favorite?page=&folder_id=0&o=mr */
  async favorites(page = 1) {
    const obj = await this.client.get('favorite', { page, folder_id: '0', o: 'mr' })
    return parseComicList(obj)
  }

  /** POST /favorite {aid} */
  async addFavorite(aid) {
    await this.client.post('favorite', { aid })
  }

  /** GET /watch_list?page= */
  async cloudHistory(page = 1) {
    const obj = await this.client.get('watch_list', { page })
    return {
      total: Number(obj?.total || 0),
      items: parseComicList(obj),
    }
  }

  /** POST /watch_list {id} */
  async addWatch(id) {
    await this.client.post('watch_list', { id })
  }

  /** GET /daily?user_id= (需要 uid) */
  async getDaily(uid) {
    return this.client.get('daily', { user_id: uid })
  }
}

// ---------------------------------------------------------------------------
// 解析辅助
// ---------------------------------------------------------------------------

function comicListItem(o) {
  if (!o) return null
  const author = toStrList(o.author)[0] || (typeof o.author === 'string' ? o.author : null)
  return {
    id: String(o.id || ''),
    name: o.name || '',
    author,
    image: o.image || '',
    liked: !!o.liked,
    isFavorite: !!o.is_favorite,
    updateAt: Number(o.update_at || 0),
  }
}

/** 从对象/数组里解析作品列表（兼容 content / list / data.content 等包装）。 */
function parseComicList(o) {
  if (Array.isArray(o)) return o.map(comicListItem).filter((x) => x && x.id)
  if (!o) return []
  const data = o.data || o
  for (const key of ['content', 'list']) {
    if (Array.isArray(data[key]) && data[key].length) {
      return data[key].map(comicListItem).filter((x) => x && x.id)
    }
  }
  return []
}

function toStrList(v) {
  if (v == null) return []
  if (Array.isArray(v)) return v.map((x) => String(x)).filter((x) => x && x !== '[]')
  if (typeof v === 'string') return v && v !== '[]' ? [v] : []
  return []
}

// ---------------------------------------------------------------------------
// 加密 PDF 生成
// ---------------------------------------------------------------------------

/** 动态加载 @muhammara/wasm（可选依赖，WebAssembly，跨平台无需原生编译）。 */
let _muhammara = null
async function loadMuhammara() {
  if (_muhammara === null) {
    try {
      const { createMuhammaraWasm } = await import('@muhammara/wasm')
      _muhammara = await createMuhammaraWasm()
    } catch {
      _muhammara = false
    }
  }
  return _muhammara || null
}

/**
 * 解析要处理的章节。
 * @param {null|number|{from:number,to:number}} range null=整本，number=单章，对象=区间
 * @returns {Promise<{detail:object, series:Array, chapters:Array}>}
 */
export async function resolveChapters(repo, albumId, range = null) {
  const detail = await repo.getAlbum(albumId)
  const series = detail.series.length
    ? detail.series
    : [{ id: detail.id, name: detail.name, sort: 1, totalPage: detail.totalPhotos || 0 }]

  let chapters
  if (range == null || range === 'all') {
    chapters = series
  } else if (typeof range === 'number' || typeof range === 'string') {
    const n = Number(range)
    chapters = series.filter((s) => s.sort === n)
  } else {
    const from = Math.max(1, Number(range.from) || 1)
    const to = Number(range.to) || series.length
    const lo = Math.min(from, to)
    const hi = Math.max(from, to)
    chapters = series.filter((s) => s.sort >= lo && s.sort <= hi)
  }
  if (!chapters.length) throw new Error('所选章节不存在')
  return { detail, series, chapters }
}

/** 只收集页面元信息（url 字符串），不碰图片字节，几百页也就几十 KB。 */
async function pagesOfChapter(client, repo, chapter, albumId) {
  const rd = await repo.comicRead(chapter.id)
  const aid = Number(rd.id) || Number(albumId)
  return (rd.images || []).map((p) => ({
    url: client.imgUrl(p.image),
    aid,
    scrambleId: rd.scrambleId,
    page: p.page,
  }))
}

/**
 * 用一个全新的 writer 把这一批页写成 PDF，写完立刻 end()。
 *
 * 这里是 `Aborted()` 的关键修复点：以前整本（可能上千页）共用一个 writer，
 * 所有页的图片字节在 WASM 线性内存里一直累积到 end() 才释放，中途就撑爆了。
 * 现在每章（或每 350 页）单独建文档、单独落盘，内存只与这一批的页数有关。
 */
async function writePdf(client, m, sharp, pages, opts) {
  const { concurrency = 4, retries = 3, retryDelay = 2000, quality = 82, userPassword = '', ownerPassword = '', onPage } = opts

  const up = userPassword || ''
  const op = ownerPassword || ''
  const ownerFinal = op && op !== up ? op : (op || up) + '::jmreader-owner'

  const writer = m.createWriter({
    userPassword: up,
    ownerPassword: ownerFinal,
    version: m.ePDFVersion17,
  })

  const total = pages.length
  const windowSize = Math.max(1, Math.min(concurrency, total))
  const inflight = new Map()

  const openPage = (i) => {
    const pg = pages[i]
    return fetchPageImageRetry(client, pg.url, pg.aid, pg.scrambleId, { retries, retryDelay })
      .then((r) => ({ ok: true, r }))
      .catch((error) => ({ ok: false, error }))
  }

  for (let i = 0; i < windowSize; i++) inflight.set(i, openPage(i))

  for (let i = 0; i < total; i++) {
    const slot = await inflight.get(i)
    inflight.delete(i)
    if (!slot.ok) throw slot.error

    const nextIdx = i + windowSize
    if (nextIdx < total) inflight.set(nextIdx, openPage(nextIdx))

    const { buf } = slot.r
    let jpeg = buf
    try {
      const meta = await sharp(buf).metadata()
      const max = 2200
      if (meta.width > max || meta.height > max) {
        jpeg = await sharp(buf)
          .resize({ width: max, height: max, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality })
          .toBuffer()
      } else {
        jpeg = await sharp(buf).jpeg({ quality }).toBuffer()
      }
    } catch {
      // 转码失败就用原字节
    }
    const { width, height } = await sharp(jpeg).metadata()
    const page = new m.PDFPage(0, 0, width, height)
    const ctx = writer.startPageContentContext(page)
    ctx.drawImage(0, 0, jpeg, { transformation: { width, height } })
    writer.writePage(page)

    if (onPage) onPage(i + 1, total)
  }

  const bytes = writer.end()
  return { buf: Buffer.from(bytes), pageCount: total, userPassword: up, ownerPassword: op }
}

/** 加载 WASM 与 sharp（模块级缓存，多次调用只有第一次真的初始化）。 */
async function prepare() {
  const m = await loadMuhammara()
  if (!m) throw new Error('未安装 @muhammara/wasm，无法生成 PDF')
  const sharp = await loadSharp()
  if (!sharp) throw new Error('未安装 sharp，无法生成 PDF')
  return { m, sharp }
}

/**
 * 把「一章」写成 PDF。单章页数超过 maxPagesPerFile 时自动分卷，
 * 保证任何单个文档都不会把 WASM 堆撑爆（这是 Aborted() 的根治手段）。
 *
 * @param {object} chapter { id, sort, name }
 * @param {object} opts { userPassword, ownerPassword, quality, concurrency, retries, retryDelay, maxPagesPerFile }
 * @param {object} hooks { onProgress(doneInChunk,totalInChunk) }
 * @returns {Promise<Array<{sort:number,part:number,parts:number,name:string,buf:Buffer,pageCount:number}>>}
 */
export async function buildChapterPdf(client, repo, albumId, chapter, opts = {}, hooks = {}) {
  const { m, sharp } = await prepare()
  const {
    concurrency = 4,
    retries = 3,
    retryDelay = 2000,
    quality = 82,
    maxPagesPerFile = 350,
  } = opts

  const pages = await pagesOfChapter(client, repo, chapter, albumId)
  const parts = []
  if (!pages.length) return parts

  const chunkCount = Math.ceil(pages.length / maxPagesPerFile)
  for (let i = 0; i < chunkCount; i++) {
    const chunk = pages.slice(i * maxPagesPerFile, (i + 1) * maxPagesPerFile)
    const res = await writePdf(client, m, sharp, chunk, {
      concurrency,
      retries,
      retryDelay,
      quality,
      userPassword: opts.userPassword || '',
      ownerPassword: opts.ownerPassword || '',
      onPage: (n, t) => hooks.onProgress?.(n, t, i + 1, chunkCount),
    })
    parts.push({
      sort: chapter.sort,
      part: i + 1,
      parts: chunkCount,
      name: chapter.name,
      buf: res.buf,
      pageCount: res.pageCount,
      userPassword: res.userPassword,
      ownerPassword: res.ownerPassword,
    })
  }
  return parts
}

/**
 * 把一部漫画（整本 / 单章 / 章节区间）合成为**一个**加密 PDF（兼容旧接口）。
 *
 * @param {number|null|{from:number,to:number}} chapterIdx 章节范围
 */
export async function buildComicPdf(client, repo, albumId, chapterIdx = null, userPassword = '', ownerPassword = '', onProgress, opts = {}) {
  const { concurrency = 4, retries = 3, retryDelay = 2000, quality = 82, maxPagesPerFile = 350 } = opts
  const { m, sharp } = await prepare()

  const { detail, chapters } = await resolveChapters(repo, albumId, chapterIdx)

  const allPages = []
  for (let i = 0; i < chapters.length; i++) {
    allPages.push(...(await pagesOfChapter(client, repo, chapters[i], albumId)))
    // 边收集边判断：107 章的合集没必要先把三万多页全扫一遍再报错，
    // 扫到第 2 章就超限时应该立刻告诉用户，而不是让人干等几分钟。
    if (allPages.length > maxPagesPerFile) {
      throw new Error(
        `已扫到第 ${i + 1}/${chapters.length} 章就有 ${allPages.length} 页，超过单个 PDF 上限 ${maxPagesPerFile} 页。` +
          '请改用「每章一个 PDF 打包」，或缩小章节范围。',
      )
    }
  }
  if (!allPages.length) throw new Error('该漫画没有可下载的页面')

  if (onProgress) onProgress(0, allPages.length)
  const res = await writePdf(client, m, sharp, allPages, {
    concurrency,
    retries,
    retryDelay,
    quality,
    userPassword,
    ownerPassword,
    onPage: (n, t) => onProgress?.(n, t),
  })

  return {
    buf: res.buf,
    pageCount: res.pageCount,
    userPassword: res.userPassword,
    ownerPassword: res.ownerPassword,
    name: detail.name || `JM${albumId}`,
  }
}

/**
 * 统计页数（整本 / 单章 / 区间）。用章节元信息里的 total_page 求和，避免逐章请求。
 * @param {null|number|{from:number,to:number}} range
 */
export async function countComicPages(repo, albumId, range = null) {
  const { chapters } = await resolveChapters(repo, albumId, range)
  return chapters.reduce((sum, c) => sum + (Number(c.totalPage) || 0), 0)
}

export default JmRepository
