/**
 * PDF 生成任务队列
 *
 * 下载整本漫画动辄几百页，浏览器等不了同步响应，所以做成后台任务：
 *   POST /api/jobs 立即返回 jobId → 前端用 SSE 订阅进度 → 完成后走下载接口。
 *
 * 同时运行的任务数受限（默认 2），其余排队，避免把出口带宽和代理打满。
 */

import crypto from 'node:crypto'
import { getCachedPdf, putCachedPdf } from '../apps/store.js'
import { buildComicPdf } from '../apps/jm.js'

const MAX_CONCURRENT = 2
const MAX_JOBS_KEPT = 80
const PROGRESS_THROTTLE = 200 // ms

function newId() {
  return crypto.randomBytes(8).toString('hex')
}

/**
 * @param {{client: import('../apps/jmcore.js').default, getConfig: () => object}} deps
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
      chapter: job.chapter,
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

  async function run(job) {
    running++
    job.status = 'running'
    job.startedAt = Date.now()
    update(job, { message: '正在解析章节…' }, { force: true })

    const cfg = getConfig()
    client.applyProxy({ proxy: cfg.proxy, proxyMode: cfg.proxyMode })
    if (!client.apiUrl) {
      // 主机发现最坏要摸好几个域名，卡住时任务会一直「正在解析章节…」，这里兜个底
      await Promise.race([
        client.bootstrap(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('连接 JM 服务超时：请检查网络或配置代理')), 30000),
        ),
      ])
    }

    try {
      // 1. 已生成过且密码策略一致 → 直接复用
      const userPassword = job.password || ''
      const cached = await getCachedPdf(job.albumId, job.chapter)
      if (cached && (cached.meta?.userPassword ?? '') === userPassword) {
        job.cached = true
        job.size = cached.meta.size || 0
        job.title = cached.meta.name || job.title
        job.done = cached.meta.pageCount || 0
        job.total = job.done
        update(job, { status: 'done', message: '已命中本地缓存', finishedAt: Date.now() }, { force: true })
        push(job, 'done')
        return
      }

      // 2. 抓取并合成 PDF
      const maxPages = Number(cfg.maxPages) || 0
      const result = await buildComicPdf(
        client,
        repo,
        job.albumId,
        job.chapter,
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

      if (maxPages > 0 && result.pageCount > maxPages) {
        // 已在下载前校验过页数，这里兜底
        throw new Error(`页数 ${result.pageCount} 超过上限 ${maxPages}`)
      }

      // 3. 落盘缓存 + 更新任务
      await putCachedPdf(job.albumId, job.chapter, result.buf, {
        name: result.name,
        pageCount: result.pageCount,
        userPassword: result.userPassword,
        ownerPassword: result.ownerPassword,
      })

      job.title = result.name
      job.size = result.buf.length
      job.done = result.pageCount
      job.total = result.pageCount
      update(job, { status: 'done', message: `已生成 ${result.pageCount} 页 PDF`, finishedAt: Date.now() }, { force: true })
      push(job, 'done')
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
    /** 创建任务；返回任务快照。 */
    create({ albumId, chapter = null, title = '', pages = 0, encrypt = 'none', password = '' }) {
      const job = {
        id: newId(),
        albumId: String(albumId),
        chapter: chapter == null ? null : Number(chapter),
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
