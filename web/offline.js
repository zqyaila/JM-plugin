/**
 * 「整本已缓存」登记簿（v1.6.2）
 *
 * 阅读页缓存（web/pagecache.js）只认章节 id，不知道章节属于哪本、这本一共几章，
 * 也就没法回答「整本看完了没有」。这里补上这层关系：
 *
 *   data/offline.json
 *   { "v": 1, "albums": { "123456": {
 *       "id": "123456", "name": "…", "total": 12, "time": 1795…,
 *       "chapters": { "3": { "sort": 3, "cid": "987654", "name": "…", "pages": 24, "time": … } }
 *   } } }
 *
 * 每次打开一章就登记一次（章 id、页码总数、所属作品、作品总章数），
 * 之后拿 pageStore.pageNumbers() 逐章核对 1..pages 是否齐全：
 * 全部章节齐全 = 整本已缓存，可以直接从本地出 PDF，不用再向图源要一张图。
 *
 * 只记元信息，不记图片；图片仍然由 pageStore 管，删缓存 / LRU 淘汰后覆盖率自然回落。
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

const MAX_ALBUMS = 300
const SAVE_DELAY = 400

export function createOfflineIndex({ file, pages } = {}) {
  let data = { v: 1, albums: {} }
  let ready = null
  let timer = null
  let writing = null
  let dirty = false

  async function load() {
    if (ready) return ready
    ready = (async () => {
      try {
        const raw = await fsp.readFile(file, 'utf8')
        const json = JSON.parse(raw)
        if (json && typeof json === 'object' && json.albums) {
          for (const [id, alb] of Object.entries(json.albums)) {
            if (!alb || typeof alb !== 'object') continue
            const chapters = {}
            for (const [sort, ch] of Object.entries(alb.chapters || {})) {
              const n = Number(sort)
              if (!n || !ch?.cid) continue
              chapters[String(n)] = {
                sort: n,
                cid: String(ch.cid),
                name: String(ch.name || ''),
                pages: Number(ch.pages) || 0,
                time: Number(ch.time) || 0,
              }
            }
            data.albums[id] = {
              id,
              name: String(alb.name || ''),
              total: Number(alb.total) || 0,
              time: Number(alb.time) || 0,
              chapters,
            }
          }
        }
      } catch {
        // 文件不存在 / 坏了：从空开始。这里只是索引，丢了最多重看一遍才有记录
      }
    })()
    return ready
  }

  function saveSoon() {
    dirty = true
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      void flush()
    }, SAVE_DELAY)
  }

  async function flush() {
    if (writing) return writing
    if (!dirty) return
    dirty = false
    const body = JSON.stringify(data)
    writing = (async () => {
      try {
        await fsp.mkdir(path.dirname(file), { recursive: true })
        const tmp = `${file}.tmp`
        await fsp.writeFile(tmp, body, 'utf8')
        await fsp.rename(tmp, file)
      } catch {
        // 写不进去不影响阅读，最坏是重启后要重看一章才有记录
      } finally {
        writing = null
      }
    })()
    return writing
  }

  function trim() {
    const ids = Object.keys(data.albums)
    if (ids.length <= MAX_ALBUMS) return
    ids
      .sort((a, b) => (data.albums[a].time || 0) - (data.albums[b].time || 0))
      .slice(0, ids.length - MAX_ALBUMS)
      .forEach((id) => delete data.albums[id])
  }

  /**
   * 登记一章。同一章重复打开只刷新页码与时间（页数可能因修图变了）。
   * @param {{albumId:string, albumName:string, totalChapters:number,
   *          sort:number, cid:string, name?:string, pages:number}} input
   */
  async function recordChapter({ albumId, albumName, totalChapters, sort, cid, name, pages: pageCount }) {
    await load()
    const id = String(albumId || '')
    const s = Number(sort) || 0
    const n = Number(pageCount) || 0
    if (!id || !cid || !s || !n) return null

    const alb = (data.albums[id] ||= { id, name: '', total: 0, time: 0, chapters: {} })
    if (albumName) alb.name = String(albumName)
    alb.total = Math.max(alb.total || 0, Number(totalChapters) || 0)
    alb.time = Date.now()
    alb.chapters[String(s)] = {
      sort: s,
      cid: String(cid),
      name: String(name || ''),
      pages: n,
      time: Date.now(),
    }
    trim()
    saveSoon()
    return alb
  }

  /** 逐章核对缓存：返回覆盖率，未登记的章节按「未缓存」算。 */
  async function coverage(albumId) {
    await load()
    const alb = data.albums[String(albumId)]
    if (!alb) return null

    const list = Object.values(alb.chapters).sort((a, b) => a.sort - b.sort)
    const chapters = []
    let pagesTotal = 0
    let pagesCached = 0
    let chaptersCached = 0
    let size = 0

    for (const ch of list) {
      const have = new Set(await pages.pageNumbers(ch.cid))
      let cached = 0
      for (let p = 1; p <= ch.pages; p++) if (have.has(p)) cached += 1
      const complete = ch.pages > 0 && cached >= ch.pages
      if (complete) chaptersCached += 1
      pagesTotal += ch.pages
      pagesCached += cached
      size += await pages.chapterSize(ch.cid).catch(() => 0)
      chapters.push({
        sort: ch.sort,
        cid: ch.cid,
        name: ch.name,
        pages: ch.pages,
        cached,
        complete,
      })
    }

    const total = alb.total || list.length
    const complete =
      total > 0 && list.length >= total && chaptersCached === list.length && list.length > 0

    return {
      id: alb.id,
      name: alb.name,
      total,
      chapters,
      chaptersCached,
      pages: pagesTotal,
      pagesCached,
      size,
      complete,
      time: alb.time,
    }
  }

  /** 所有登记过的作品（只回摘要，够列表用）。 */
  async function list() {
    await load()
    return Object.values(data.albums)
      .sort((a, b) => (b.time || 0) - (a.time || 0))
      .map((alb) => ({
        id: alb.id,
        name: alb.name,
        total: alb.total,
        known: Object.keys(alb.chapters).length,
        time: alb.time,
      }))
  }

  /** 整本已缓存的作品的章节 id，用来钉住不被 LRU 淘汰。 */
  async function pinnedChapters() {
    await load()
    const out = []
    for (const alb of Object.values(data.albums)) {
      if (!alb.total || Object.keys(alb.chapters).length < alb.total) continue
      const cov = await coverage(alb.id)
      if (cov?.complete) out.push(...cov.chapters.map((c) => c.cid))
    }
    return out
  }

  async function clear() {
    data = { v: 1, albums: {} }
    await flush()
  }

  return { load, recordChapter, coverage, list, pinnedChapters, clear, flush }
}

export default createOfflineIndex
