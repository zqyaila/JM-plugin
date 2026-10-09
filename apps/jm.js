/**
 * JM Reader 数据仓库层（Node.js 版）
 *
 * 对应 Kotlin 端 data/repo/AppRepository.kt，封装类型化接口方法。
 * 不含广告 / 金币 / 充值相关接口。
 */

import JmClient, { needsDescramble, sliceCount } from './jmcore.js'

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
  const res = await rawGet(url)
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

/** 极简二进制 GET（复用 client 的 httpRequest 逻辑，这里直接内联 fetch）。 */
async function rawGet(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!res.ok) return null
    return Buffer.from(await res.arrayBuffer())
  } catch {
    return null
  }
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
 * 把一部漫画（整本或单章）下载、打乱还原并合成为一个**加密 PDF**。
 *
 * 加密采用 PDF 标准安全处理器（Standard Security Handler，RC4/AES-128，PDF 1.7）。
 * 双密码：userPassword 与 ownerPassword 均可打开文档。
 *
 * @param {JmClient} client
 * @param {JmRepository} repo
 * @param {string} albumId 漫画 JM 号
 * @param {number|null} chapterIdx 章节序号（null = 整本）
 * @param {string} userPassword 用户密码（通用密码）
 * @param {string} ownerPassword 所有者密码（作品 id）
 * @param {function} [onProgress] 进度回调 (done, total)
 * @returns {Promise<{ buf: Buffer, pageCount: number, userPassword: string, ownerPassword: string, name: string }>}
 */
export async function buildComicPdf(client, repo, albumId, chapterIdx = null, userPassword = '', ownerPassword = '', onProgress) {
  const m = await loadMuhammara()
  if (!m) throw new Error('未安装 @muhammara/wasm，无法生成 PDF')
  const sharp = await loadSharp()
  if (!sharp) throw new Error('未安装 sharp，无法生成 PDF')

  const detail = await repo.getAlbum(albumId)
  const series = detail.series.length
    ? detail.series
    : [{ id: detail.id, name: detail.name, sort: 1 }]

  // 确定要处理的章节
  let chapters
  if (chapterIdx != null) {
    const ch = series.find((s) => s.sort === chapterIdx) || series[0]
    chapters = [ch]
  } else {
    chapters = series
  }

  // 先汇总所有页
  const allPages = []
  for (const ch of chapters) {
    const rd = await repo.comicRead(ch.id)
    const aid = Number(rd.id) || Number(albumId)
    for (const p of rd.images) {
      allPages.push({
        url: client.imgUrl(p.image),
        aid,
        scrambleId: rd.scrambleId,
        chapterName: ch.name,
        page: p.page,
      })
    }
  }
  if (!allPages.length) throw new Error('该漫画没有可下载的页面')

  // 双密码：两个都能打开文档；但二者不能相同（PDF 规范要求）
  const up = userPassword || ''
  const op = ownerPassword || ''
  const ownerFinal = op && op !== up ? op : (op || up) + '::jmreader-owner'

  const writer = m.createWriter({
    userPassword: up,
    ownerPassword: ownerFinal,
    version: m.ePDFVersion17,
  })

  let done = 0
  for (const pg of allPages) {
    const { buf } = await fetchPageImage(client, pg.url, pg.aid, pg.scrambleId)
    // 统一转成 JPEG（限制最大边，控制体积）
    let jpeg = buf
    try {
      const meta = await sharp(buf).metadata()
      const max = 2200
      if (meta.width > max || meta.height > max) {
        jpeg = await sharp(buf)
          .resize({ width: max, height: max, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 82 })
          .toBuffer()
      } else {
        jpeg = await sharp(buf).jpeg({ quality: 82 }).toBuffer()
      }
    } catch {
      // 转码失败就用原字节
    }
    const { width, height } = await sharp(jpeg).metadata()
    const page = new m.PDFPage(0, 0, width, height)
    const ctx = writer.startPageContentContext(page)
    ctx.drawImage(0, 0, jpeg, { transformation: { width, height } })
    writer.writePage(page)
    done++
    if (onProgress) onProgress(done, allPages.length)
  }

  const bytes = writer.end()
  return {
    buf: Buffer.from(bytes),
    pageCount: allPages.length,
    userPassword: up,
    ownerPassword: op,
    name: detail.name || `JM${albumId}`,
  }
}

export default JmRepository
