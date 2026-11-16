/**
 * PDF 生成任务队列
 *
 * 下载整本漫画动辄几百页，浏览器等不了同步响应，所以做成后台任务：
 *   POST /api/jobs 立即返回 jobId → 前端用 SSE 订阅进度 → 完成后走下载接口。
 *
 * 两种产出模式：
 *   single —— 整个区间合成一个 PDF（页数超上限会直接拒绝，避免 WASM 崩）
 *   zip    —— 一章一个 PDF，装进「作品名_JMid/」文件夹内按章节序号命名，最后打包成 zip
 *
 * 同时运行的任务数受限（默认 2），其余排队，避免把出口带宽和代理打满。
 */

import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { getCachedPdf, putCachedPdf, cacheKey, DATA_DIR, PDF_DIR } from '../apps/store.js'
import { buildChapterPdf, buildComicPdf, resolveChapters } from '../apps/jm.js'
import { createZipWriter } from '../apps/zip.js'

const MAX_CONCURRENT = 2
const MAX_JOBS_KEPT = 80
const PROGRESS_THROTTLE = 200 // ms
const EXPORT_DIR = path.join(DATA_DIR, 'exports')
const EXPORT_KEEP = 20
const EXPORT_TTL = 7 * 24 * 60 * 60 * 1000

function newId() {
  return crypto.randomBytes(8).toString('hex')
}

/** 文件名安全化（跨平台）。 */
function safeName(name, fallback = 'comic') {
  return (
    String(name || fallback)
      .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60) || fallback
  )
}

/** 章节区间 → 缓存标签：整本=null，单章=数字，区间=`r<from>-<to>`。 */
function rangeTag(from, to) {
  if (from == null && to == null) return null
  if (from != null && to != null && from === to) return Number(from)
  return `r${from ?? 1}-${to ?? 'end'}`
}

/** 章节序号补零，保证 zip 里按文件名排序就是章节顺序。 */
function pad(n, width = 3) {
  return String(n).padStart(width, '0')
}

/** 清理过期/过多的导出包，避免 data/exports 无限膨胀。 */
async function pruneExports() {
  try {
    const names = await fsp.readdir(EXPORT_DIR)
    const files = []
    for (const name of names) {
      if (!name.endsWith('.zip')) continue
      const full = path.join(EXPORT_DIR, name)
      try {
        const st = await fsp.stat(full)
        files.push({ full, time: st.mtimeMs })
      } catch {}
    }
    files.sort((a, b) => b.time - a.time)
    const now = Date.now()
    for (let i = 0; i < files.length; i++) {
      if (i >= EXPORT_KEEP || now - files[i].time > EXPORT_TTL) {
        await fsp.rm(files[i].full, { force: true }).catch(() => {})
      }
    }
  } catch {
    /* 目录不存在等情况忽略 */
  }
}

/**
 * @param {{client: import('../apps/jmcore.js').default, repo: any, getConfig: () => object}} deps
 */
export function createJobManager({ client, repo, getConfig }) {
  /** @type {Map<string, any>} */
  const jobs = new Map()
  const queue = []
  let running = 0

  function trim() {
    if (jobs.size <= MAX_JOBS_KEPT) return
    const finished = [...jobs.values()]
      .filter((j) => j.status === 'done' || j.status === 'error' || j.status === 'canceled')
      .sort((a, b) => a.createdAt - b.createdAt)
    for (const j of finished) {
      if (jobs.size <= MAX_JOBS_KEPT) break
      jobs.delete(j.id)
    }
  }

  function snapshot(job) {
    return {
      id: job.id,
      albumId: job.albumId,
      from: job.from,
      to: job.to,
      whole: !!job.whole,
      mode: job.mode,
      chapterCount: job.chapterCount || 0,
      files: job.files || 0,
      kind: job.kind || 'pdf',
      title: job.title,
      status: job.status,
      done: job.done,
      total: job.total,
      percent: job.total > 0 ? Math.min(100, Math.round((job.done / job.total) * 100)) : 0,
      message: job.message,
      size: job.size || 0,
      encrypt: job.encrypt,
      cached: !!job.cached,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt || null,
      error: job.error || null,
    }
  }

  function push(job, event) {
    const data = `event: ${event}\ndata: ${JSON.stringify(snapshot(job))}\n\n`
    for (const res of job.subscribers) {
      try {
        res.write(data)
      } catch {
        job.subscribers.delete(res)
      }
    }
  }

  function update(job, patch, { force = false } = {}) {
    Object.assign(job, patch)
    const now = Date.now()
    if (force || now - job.lastPush > PROGRESS_THROTTLE) {
      job.lastPush = now
      push(job, 'progress')
    }
  }

  // ---------------------------------------------------------------- 单一 PDF

  async function runSingle(job, cfg, userPassword) {
    const tag = job.whole ? null : rangeTag(job.from, job.to)
    const cached = await getCachedPdf(job.albumId, tag)
    if (cached && (cached.meta?.userPassword ?? '') === userPassword) {
      job.cached = true
      job.size = cached.meta.size || 0
      job.title = cached.meta.name || job.title
      job.done = cached.meta.pageCount || 0
      job.total = job.done
      job.file = cached.file
      job.kind = 'pdf'
      update(job, { status: 'done', message: '已命中本地缓存', finishedAt: Date.now() }, { force: true })
      push(job, 'done')
      return
    }

    const range = job.whole ? null : { from: job.from, to: job.to }
    const result = await buildComicPdf(
      client,
      repo,
      job.albumId,
      range,
      userPassword,
      job.ownerPassword || '',
      (done, total) => {
        update(job, { done, total, message: `正在下载第 ${done}/${total} 页` })
      },
      {
        concurrency: Number(cfg.concurrency) || 4,
        retries: 3,
        retryDelay: 2000,
        quality: Number(cfg.quality) || 82,
      },
    )

    await putCachedPdf(job.albumId, tag, result.buf, {
      name: result.name,
      pageCount: result.pageCount,
      userPassword: result.userPassword,
      ownerPassword: result.ownerPassword,
      from: job.from,
      to: job.to,
    })

    job.title = result.name
    job.size = result.buf.length
    job.done = result.pageCount
    job.total = result.pageCount
    job.kind = 'pdf'
    job.file = path.join(PDF_DIR, `${cacheKey(job.albumId, tag)}.pdf`)
    update(job, { status: 'done', message: `已生成 ${result.pageCount} 页 PDF`, finishedAt: Date.now() }, { force: true })
    push(job, 'done')
  }

  // ---------------------------------------------------------------- 分章打包

  async function runZip(job, cfg, userPassword) {
    const range = job.whole ? null : { from: job.from, to: job.to }
    const { detail, chapters } = await resolveChapters(repo, job.albumId, range)

    job.title = job.title || detail.name
    job.chapterCount = chapters.length
    // 章节元信息里常常没有 total_page，此时按「章」计进度，别让进度条一直是 0%
    job.total = chapters.reduce((sum, c) => sum + (Number(c.totalPage) || 0), 0) || chapters.length
    job.byPages = chapters.some((c) => Number(c.totalPage) > 0)
    job.done = 0
    update(job, { message: `共 ${chapters.length} 章，约 ${job.total} 页，开始下载…` }, { force: true })

    await fsp.mkdir(EXPORT_DIR, { recursive: true })
    await pruneExports()

    const folder = `${safeName(detail.name, `JM${job.albumId}`)}_JM${job.albumId}`
    const zipPath = path.join(
      EXPORT_DIR,
      `${cacheKey(job.albumId, `${job.whole ? 'zall' : rangeTag(job.from, job.to)}`)}_${Date.now().toString(36)}.zip`,
    )
    const zip = createZipWriter(zipPath)

    let fileIndex = 0
    let donePages = 0
    let files = 0

    try {
      await zip.addBuffer(`${folder}/`, null, { directory: true })

      for (let ci = 0; ci < chapters.length; ci++) {
        const ch = chapters[ci]
        const chapterNo = `${ci + 1}/${chapters.length}`
        update(job, { message: `第 ${chapterNo} 章 · 检查缓存` })

        // 命中缓存（同一密码策略）就直接拿去打包，不重复下载
        const cached = await getCachedPdf(job.albumId, ch.sort)
        let parts
        if (cached && (cached.meta?.userPassword ?? '') === userPassword) {
          parts = [
            {
              sort: ch.sort,
              part: 1,
              parts: 1,
              name: ch.name,
              path: cached.file,
              pageCount: cached.meta.pageCount || 0,
            },
          ]
          job.cachedChapters = (job.cachedChapters || 0) + 1
        } else {
          parts = await buildChapterPdf(
            client,
            repo,
            job.albumId,
            ch,
            {
              userPassword,
              ownerPassword: job.ownerPassword || '',
              concurrency: Number(cfg.concurrency) || 4,
              quality: Number(cfg.quality) || 82,
              maxPagesPerFile: 350,
            },
            {
              onProgress: (n, t) => {
                update(
                  job,
                  job.byPages
                    ? {
                        done: donePages + n,
                        total: Math.max(job.total, donePages + t),
                        message: `第 ${chapterNo} 章 · ${n}/${t} 页`,
                      }
                    : { message: `第 ${chapterNo} 章 · ${n}/${t} 页` },
                )
              },
            },
          )

          // 单章只有一个分卷时才缓存（多分卷的缓存键会撞车，意义也不大）
          for (const p of parts) {
            if (p.parts === 1) {
              await putCachedPdf(job.albumId, ch.sort, p.buf, {
                name: p.name,
                pageCount: p.pageCount,
                userPassword: p.userPassword,
                ownerPassword: p.ownerPassword,
              })
              p.path = path.join(PDF_DIR, `${cacheKey(job.albumId, ch.sort)}.pdf`)
            }
          }
        }

        for (const p of parts) {
          fileIndex += 1
          const suffix = p.parts > 1 ? `_part${p.part}` : ''
          const entry = `${folder}/${pad(fileIndex)}_第${ch.sort}章${suffix}.pdf`
          if (p.path) await zip.addFile(entry, p.path)
          else await zip.addBuffer(entry, p.buf)
          files += 1
          donePages += p.pageCount || 0
          // 立刻释放，别让多章的内存叠在一起
          if (p.buf) p.buf = null
        }

        update(
          job,
          job.byPages
            ? { done: Math.max(job.done, donePages), total: Math.max(job.total, donePages), files }
            : { done: ci + 1, total: chapters.length, files },
          { force: true },
        )
      }

      const meta = await zip.close()

      job.file = zipPath
      job.kind = 'zip'
      job.files = files
      job.size = meta.size
      job.total = job.byPages ? Math.max(job.total, donePages) : chapters.length
      job.done = job.total
      update(
        job,
        {
          status: 'done',
          message: `${chapters.length} 章 · ${files} 个 PDF · 已打包`,
          finishedAt: Date.now(),
        },
        { force: true },
      )
      push(job, 'done')
    } catch (err) {
      await fsp.rm(zipPath, { force: true }).catch(() => {})
      throw err
    }
  }

  // ---------------------------------------------------------------- 调度

  async function run(job) {
    running++
    job.status = 'running'
    job.startedAt = Date.now()
    update(job, { message: '正在解析章节…' }, { force: true })

    const cfg = getConfig()
    client.applyProxy({ proxy: cfg.proxy, proxyMode: cfg.proxyMode })

    try {
      if (!client.apiUrl) {
        await Promise.race([
          client.bootstrap(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('连接 JM 服务超时：请检查网络或配置代理')), 30000),
          ),
        ])
      }

      const userPassword = job.password || ''
      if (job.mode === 'zip') await runZip(job, cfg, userPassword)
      else await runSingle(job, cfg, userPassword)
    } catch (err) {
      job.error = err?.serverMessage || err?.message || String(err)
      update(job, { status: 'error', message: job.error, finishedAt: Date.now() }, { force: true })
      push(job, 'error')
    } finally {
      running--
      pump()
    }
  }

  function pump() {
    while (running < MAX_CONCURRENT && queue.length) {
      const job = queue.shift()
      if (job.status === 'canceled') continue
      run(job)
    }
  }

  return {
    /**
     * 创建任务。
     * @param {{albumId:string, from?:number|null, to?:number|null, mode?:'single'|'zip',
     *          title?:string, pages?:number, encrypt?:string, password?:string}} input
     */
    create({
      albumId,
      from = null,
      to = null,
      whole = false,
      mode = 'single',
      title = '',
      pages = 0,
      encrypt = 'none',
      password = '',
    }) {
      const job = {
        id: newId(),
        albumId: String(albumId),
        from: from == null ? null : Number(from),
        to: to == null ? null : Number(to),
        whole: !!whole,
        mode: mode === 'zip' ? 'zip' : 'single',
        title: title || `JM${albumId}`,
        pages,
        encrypt,
        password,
        ownerPassword: encrypt === 'id' ? String(albumId) : '',
        status: 'queued',
        done: 0,
        total: pages,
        message: queue.length ? `排队中（前方 ${queue.length} 个任务）` : '准备开始…',
        size: 0,
        files: 0,
        kind: mode === 'zip' ? 'zip' : 'pdf',
        cached: false,
        createdAt: Date.now(),
        finishedAt: null,
        subscribers: new Set(),
        lastPush: 0,
      }
      jobs.set(job.id, job)
      queue.push(job)
      trim()
      pump()
      push(job, 'progress')
      return snapshot(job)
    },

    get(id) {
      const job = jobs.get(id)
      return job ? snapshot(job) : null
    },

    /** 取完整任务（含下载文件路径），仅供站内使用。 */
    getRaw(id) {
      return jobs.get(id) || null
    },

    list() {
      return [...jobs.values()]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 30)
        .map(snapshot)
    },

    /** 订阅进度，返回解绑函数。 */
    subscribe(id, res) {
      const job = jobs.get(id)
      if (!job) return null
      job.subscribers.add(res)
      res.write(`event: progress\ndata: ${JSON.stringify(snapshot(job))}\n\n`)
      return () => job.subscribers.delete(res)
    },

    remove(id) {
      const job = jobs.get(id)
      if (!job) return false
      jobs.delete(id)
      // 打包出来的 zip 是任务私有的，删任务就删文件；PDF 走缓存，不动
      if (job.kind === 'zip' && job.file) fsp.rm(job.file, { force: true }).catch(() => {})
      return true
    },

    get runningCount() {
      return running
    },
    get queuedCount() {
      return queue.length
    },
  }
}

export default createJobManager
