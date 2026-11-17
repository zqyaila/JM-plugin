/**
 * 阅读页的磁盘缓存（v1.5.3）
 *
 * 阅读器本来就是「点一页下一张」，但缓存只放在内存里：服务一重启、或者两小时没看，
 * 同一页就得重新从图源抓一遍——流量白花，翻回去还要等。这里把已经看过的页落到
 * `data/pages/<章节 id>/<页码>.<扩展名>`，下次（含重启后）直接读盘。
 *
 * 索引（index.json）只存尺寸/格式/大小，不存图片本身：
 *   { "v": 1, "pages": { "12": { "w": 1200, "h": 1800, "ext": "jpg", "size": 183421, "time": 1794... } } }
 * 记尺寸是为了「刚打开章节就能按真实比例占位」，否则重启后首屏会跳一下。
 *
 * 容量按章节目录做 LRU 淘汰：整章删除，不做单页删除——一页一页删只会把章节删成碎片，
 * 下次重看反而要重新拼。
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

const EXT_BY_TYPE = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

const TYPE_BY_EXT = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
}

const MB = 1024 * 1024

export function createPageStore({ dir, limitMB = 512 } = {}) {
  const chapters = new Map() // cid -> { pages: Map<p, meta>, size, mtime, loaded }
  let totalBytes = 0
  let limitBytes = toBytes(limitMB)
  let ready = null
  let evicting = false
  const loading = new Map() // cid -> Promise，避免同一章被并发加载时把总量重复计入
  const indexTimers = new Map() // cid -> timer，索引写入合并成一次

  function toBytes(mb) {
    const n = Number(mb)
    if (!Number.isFinite(n) || n <= 0) return 0 // 0 / 非法 = 不限
    return Math.floor(n * MB)
  }

  const chapterDir = (cid) => path.join(dir, String(cid))
  const filePath = (cid, p, ext) => path.join(chapterDir(cid), `${p}.${ext}`)

  async function readIndex(cid) {
    try {
      const raw = await fsp.readFile(path.join(chapterDir(cid), 'index.json'), 'utf8')
      const json = JSON.parse(raw)
      const pages = new Map()
      for (const [p, meta] of Object.entries(json?.pages || {})) {
        const n = parseInt(p, 10)
        if (!n || !meta || !meta.ext) continue
        pages.set(n, {
          w: Number(meta.w) || 0,
          h: Number(meta.h) || 0,
          ext: String(meta.ext),
          size: Number(meta.size) || 0,
          time: Number(meta.time) || 0,
        })
      }
      return pages
    } catch {
      // 索引丢了（进程被 kill、手工删过）就按文件名重建，图片还在就不必重下
      return rebuildFromFiles(cid)
    }
  }

  async function rebuildFromFiles(cid) {
    const pages = new Map()
    let names = []
    try {
      names = await fsp.readdir(chapterDir(cid))
    } catch {
      return pages
    }
    for (const name of names) {
      const m = name.match(/^(\d+)\.(jpg|jpeg|png|webp|gif)$/i)
      if (!m) continue
      const p = parseInt(m[1], 10)
      const ext = m[2].toLowerCase()
      try {
        const st = await fsp.stat(path.join(chapterDir(cid), name))
        pages.set(p, { w: 0, h: 0, ext, size: st.size, time: Math.round(st.mtimeMs) })
      } catch {
        /* 单个文件失败无所谓，当作没缓存 */
      }
    }
    return pages
  }

  async function loadChapter(cid) {
    const key = String(cid)
    const hit = chapters.get(key)
    if (hit?.loaded) return hit
    const pendingLoad = loading.get(key)
    if (pendingLoad) return pendingLoad

    const task = (async () => {
      const pages = await readIndex(key)
      let size = 0
      for (const meta of pages.values()) size += meta.size
      let mtime = Date.now()
      try {
        mtime = Math.round((await fsp.stat(chapterDir(key))).mtimeMs)
      } catch {
        /* 目录还没建 */
      }
      const entry = { pages, size, mtime, loaded: true }
      chapters.set(key, entry)
      // 已经占用的空间要算进去，否则淘汰永远不触发
      totalBytes += size
      return entry
    })()

    loading.set(key, task)
    try {
      return await task
    } finally {
      loading.delete(key)
    }
  }

  function scheduleIndexWrite(cid) {
    const key = String(cid)
    if (indexTimers.has(key)) return
    indexTimers.set(
      key,
      setTimeout(async () => {
        indexTimers.delete(key)
        const entry = chapters.get(key)
        if (!entry) return
        const pages = {}
        for (const [p, meta] of entry.pages) pages[p] = meta
        try {
          await fsp.mkdir(chapterDir(key), { recursive: true })
          await fsp.writeFile(
            path.join(chapterDir(key), 'index.json'),
            JSON.stringify({ v: 1, pages }),
            'utf8',
          )
        } catch {
          /* 索引写不进去不影响读图，最坏是重启后丢尺寸 */
        }
      }, 600),
    )
  }

  /** 启动时扫一遍，算出已占空间并顺手按上限裁剪（不阻塞启动）。 */
  async function init() {
    if (ready) return ready
    ready = (async () => {
      try {
        await fsp.mkdir(dir, { recursive: true })
        const names = await fsp.readdir(dir, { withFileTypes: true })
        for (const name of names) {
          if (!name.isDirectory()) continue
          await loadChapter(name.name)
        }
        await evictIfNeeded('')
      } catch {
        /* 目录读不了就是没有缓存 */
      }
    })()
    return ready
  }

  /** 读一页：命中返回 { buf, type, etag, w, h, time }，未命中返回 null。 */
  async function get(cid, p) {
    const key = String(cid)
    const entry = await loadChapter(key)
    const meta = entry.pages.get(p)
    if (!meta) return null
    let buf
    try {
      buf = await fsp.readFile(filePath(key, p, meta.ext))
    } catch {
      // 文件被手工删了：把索引里的这一条也去掉，让调用方重新抓
      entry.pages.delete(p)
      totalBytes -= meta.size
      entry.size -= meta.size
      scheduleIndexWrite(key)
      return null
    }
    entry.mtime = Date.now()
    return {
      buf,
      type: TYPE_BY_EXT[meta.ext] || 'image/jpeg',
      etag: `"${crypto.createHash('md5').update(buf).digest('hex')}"`,
      w: meta.w,
      h: meta.h,
      time: Date.now(),
    }
  }

  /** 写一页：先落盘再更新索引；索引合并写，避免一页一个 JSON。 */
  async function put(cid, p, item) {
    const key = String(cid)
    const entry = await loadChapter(key)
    const ext = EXT_BY_TYPE[item.type] || 'jpg'
    const old = entry.pages.get(p)
    try {
      await fsp.mkdir(chapterDir(key), { recursive: true })
      await fsp.writeFile(filePath(key, p, ext), item.buf)
    } catch {
      return // 写盘失败（磁盘满、只读挂载）就当没缓存，不影响这次浏览
    }
    if (old && old.ext !== ext) {
      fsp.unlink(filePath(key, p, old.ext)).catch(() => {})
    }
    const meta = {
      w: Number(item.w) || 0,
      h: Number(item.h) || 0,
      ext,
      size: item.buf.length,
      time: Date.now(),
    }
    entry.pages.set(p, meta)
    entry.size += meta.size - (old?.size || 0)
    totalBytes += meta.size - (old?.size || 0)
    entry.mtime = meta.time
    scheduleIndexWrite(key)
    void evictIfNeeded(key)
  }

  /** 章节里已知的页面尺寸，用于首屏占位。 */
  async function dims(cid) {
    const entry = await loadChapter(String(cid))
    const out = {}
    for (const [p, meta] of entry.pages) {
      if (meta.w && meta.h) out[p] = [meta.w, meta.h]
    }
    return out
  }

  async function removeChapter(cid) {
    const key = String(cid)
    const entry = chapters.get(key)
    try {
      await fsp.rm(chapterDir(key), { recursive: true, force: true })
    } catch {
      return
    }
    if (entry) totalBytes -= entry.size
    chapters.delete(key)
    const timer = indexTimers.get(key)
    if (timer) clearTimeout(timer)
    indexTimers.delete(key)
  }

  /** 超出上限就整章删最久没看过的，删到 90% 水位为止。 */
  async function evictIfNeeded(keepCid = '') {
    if (!limitBytes || totalBytes <= limitBytes || evicting) return
    evicting = true
    try {
      const list = [...chapters.entries()]
        .filter(([id, e]) => id !== String(keepCid) && e.loaded && e.pages.size)
        .sort((a, b) => a[1].mtime - b[1].mtime)
      for (const [id] of list) {
        if (totalBytes <= limitBytes * 0.9) break
        await removeChapter(id)
      }
    } finally {
      evicting = false
    }
  }

  function stats() {
    let files = 0
    for (const entry of chapters.values()) files += entry.pages.size
    return {
      chapters: chapters.size,
      files,
      size: totalBytes,
      limit: limitBytes,
      limitMB: limitBytes ? Number((limitBytes / MB).toFixed(limitBytes < MB ? 1 : 0)) : 0,
    }
  }

  async function clear() {
    for (const timer of indexTimers.values()) clearTimeout(timer)
    indexTimers.clear()
    await fsp.rm(dir, { recursive: true, force: true })
    chapters.clear()
    totalBytes = 0
    await fsp.mkdir(dir, { recursive: true })
  }

  function setLimitMB(mb) {
    limitBytes = toBytes(mb)
    void evictIfNeeded('')
  }

  void init()

  return { get, put, dims, stats, clear, setLimitMB, init, removeChapter }
}

export default createPageStore
