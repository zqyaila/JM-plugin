/**
 * 持久化存储层：缓存已生成的加密 PDF 到插件 data 目录，转发到其他群免重复下载。
 *
 * 目录结构（相对插件根目录）：
 *   data/
 *     pdfs/<id>.pdf        缓存的 PDF 文件
 *     index.json           缓存索引（id → 元信息）
 *
 * 注意：缓存 key 为「作品 id」（整本）。单章下载单独命名 <id>_c<章节>.pdf。
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 插件根目录 = apps 的上一级
export const DATA_DIR = path.join(__dirname, '..', 'data')
export const PDF_DIR = path.join(DATA_DIR, 'pdfs')
export const INDEX_FILE = path.join(DATA_DIR, 'index.json')

/** 确保目录与索引文件存在。 */
async function ensureStore() {
  await fsp.mkdir(PDF_DIR, { recursive: true })
  if (!fs.existsSync(INDEX_FILE)) {
    await fsp.writeFile(INDEX_FILE, JSON.stringify({}, null, 2), 'utf8')
  }
}

/**
 * 读索引。
 *
 * 文件存在但读不出来（进程被杀时写了一半、磁盘错误）时，先把它改名备份，
 * 再返回空对象 —— 否则下一次写入会拿空对象把整个索引覆盖掉，几百个 PDF
 * 全变成「目录里有、索引里没有」的孤儿。
 */
async function readIndex() {
  let raw
  try {
    raw = await fsp.readFile(INDEX_FILE, 'utf8')
  } catch (e) {
    if (e?.code !== 'ENOENT') {
      await backupBrokenIndex()
    }
    return {}
  }
  if (!raw.trim()) return {}
  try {
    const json = JSON.parse(raw)
    return json && typeof json === 'object' ? json : {}
  } catch {
    await backupBrokenIndex()
    return {}
  }
}

async function backupBrokenIndex() {
  try {
    const dest = `${INDEX_FILE}.broken-${Date.now()}`
    await fsp.rename(INDEX_FILE, dest)
    console.warn(`[store] index.json 无法解析，已备份为 ${path.basename(dest)}`)
  } catch {
    /* 备份失败也别影响读取，最坏是下次重新扫描 */
  }
}

/** 原子写：先写临时文件再 rename，读方永远不会看到半个 JSON。 */
async function writeIndex(index) {
  const tmp = `${INDEX_FILE}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  await fsp.writeFile(tmp, JSON.stringify(index, null, 2), 'utf8')
  await fsp.rename(tmp, INDEX_FILE)
}

const LOCK_FILE = `${INDEX_FILE}.lock`
const LOCK_STALE_MS = 5000

/**
 * 跨进程互斥（O_EXCL 建锁文件）。
 *
 * 「写完再读一遍比对」这类乐观校验挡不住 lost update：A 写完、A 验证通过、
 * B 紧接着覆盖 —— A 的改动就没了。插件进程和 web 进程都会写这个索引，
 * 必须用真正的互斥；拿不到锁就退避重试，持有者崩溃留下的死锁按 mtime 清掉。
 */
async function withIndexLock(fn) {
  const wait = 15
  for (let i = 0; i < 200; i++) {
    let fh = null
    try {
      fh = await fsp.open(LOCK_FILE, 'wx')
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e
      try {
        const st = await fsp.stat(LOCK_FILE)
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) await fsp.rm(LOCK_FILE, { force: true })
      } catch {}
      await new Promise((r) => setTimeout(r, wait + Math.random() * wait))
      continue
    }
    try {
      await fh.close()
      return await fn()
    } finally {
      await fsp.rm(LOCK_FILE, { force: true })
    }
  }
  // 3 秒还拿不到锁：不再阻塞业务，直接写（极端情况下宁可丢一条索引，
  // 文件本身还在，下次 listCache 会把它补登记回来）
  return await fn()
}

// 同一进程内的写操作串成一条链：避免自己跟自己抢锁
let writeChain = Promise.resolve()

/**
 * 对索引做一次「读-改-写」，全程持有跨进程锁。
 */
async function mutateIndex(fn) {
  const run = () =>
    withIndexLock(async () => {
      const index = { ...(await readIndex()) }
      const before = JSON.stringify(index)
      const result = await fn(index)
      // 内容没变就不落盘，少一次写
      if (JSON.stringify(index) !== before) await writeIndex(index)
      return result
    })
  const task = writeChain.then(run, run)
  writeChain = task.catch(() => {})
  return task
}

/**
 * 生成缓存文件名。整本=id，单章=id_c<章节>，区间=id_r<a>-<b>，打包=id_<标签>。
 *
 * 区间既可能是 web 端拼好的字符串（`r1-5`），也可能是插件直接传的
 * `{from, to}` 对象 —— 两种都要落到同一个键上，否则同一段区间会被下载两遍。
 */
export function cacheKey(id, chapterIdx = null) {
  if (chapterIdx == null) return `${id}`
  if (typeof chapterIdx === 'number') return `${id}_c${chapterIdx}`
  if (typeof chapterIdx === 'object') {
    const from = Number(chapterIdx.from) || 1
    const to = chapterIdx.to == null ? 'end' : Number(chapterIdx.to)
    return `${id}_r${from}-${to}`
  }
  return `${id}_${String(chapterIdx).replace(/[^\w-]/g, '')}`
}

/**
 * 查询缓存。
 * @returns {Promise<{ file: string, meta: object } | null>}
 */
export async function getCachedPdf(id, chapterIdx = null) {
  await ensureStore()
  const key = cacheKey(id, chapterIdx)
  const index = await readIndex()
  const meta = index[key]
  if (!meta) return null
  const file = path.join(PDF_DIR, `${key}.pdf`)
  if (!fs.existsSync(file)) return null
  return { file, meta }
}

/**
 * 写入缓存。
 * @param {string} id
 * @param {number|null} chapterIdx
 * @param {Buffer} buf PDF 字节
 * @param {object} meta 附加元信息（userPassword/ownerPassword/pageCount/name/time）
 */
export async function putCachedPdf(id, chapterIdx, buf, meta = {}) {
  await ensureStore()
  const key = cacheKey(id, chapterIdx)
  const file = path.join(PDF_DIR, `${key}.pdf`)
  // 先写临时文件再替换：另一个进程正在下载这个 PDF 时，不会读到半个文件
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  await fsp.writeFile(tmp, buf)
  await fsp.rename(tmp, file)
  await mutateIndex((index) => {
    index[key] = {
      id,
      chapter: chapterIdx,
      file: `${key}.pdf`,
      size: buf.length,
      time: Date.now(),
      ...meta,
    }
  })
  return key
}

/**
 * 这份缓存 PDF 是否与当前要用的密码策略一致。
 *
 * 插件（pdfPassword）和网页端（web-config.json 的 encrypt/password）是两套配置，
 * 同一份文件可能被另一套口令加密过。不一致就不能直接发 —— 用户按提示输的密码
 * 会打不开。索引重建出来的条目（passwordUnknown）一律视为不一致。
 *
 * @param {object|null} meta
 * @param {string} userPassword 当前需要的打开密码（空串 = 不加密）
 * @param {string} [ownerPassword] 当前需要的所有者密码（作品 id）
 */
export function pdfPasswordMatches(meta, userPassword, ownerPassword = '') {
  if (!meta) return false
  if (meta.passwordUnknown) return false
  if ((meta.userPassword ?? '') !== userPassword) return false
  if (ownerPassword && meta.ownerPassword && meta.ownerPassword !== ownerPassword) return false
  return true
}

/**
 * 删除缓存。
 * @param {string} id 作品 id；传 'all' 清空全部
 * @param {number|null} chapterIdx
 * @returns {Promise<number>} 删除的文件数
 */
export async function removeCachedPdf(id, chapterIdx = null) {
  await ensureStore()
  let removed = 0

  if (id === 'all') {
    // 以目录为准：索引漏登记的孤儿 PDF 也要删掉，不然「清空」之后磁盘还占着
    let files = []
    try {
      files = await fsp.readdir(PDF_DIR)
    } catch {
      files = []
    }
    for (const f of files) {
      if (!f.endsWith('.pdf')) continue
      try {
        await fsp.rm(path.join(PDF_DIR, f), { force: true })
        removed++
      } catch {}
    }
    await mutateIndex((index) => {
      for (const key of Object.keys(index)) delete index[key]
    })
    return removed
  }

  const key = cacheKey(id, chapterIdx)
  const file = path.join(PDF_DIR, `${key}.pdf`)
  try {
    await fsp.access(file)
    await fsp.rm(file, { force: true })
    removed = 1
  } catch {}
  await mutateIndex((index) => {
    if (index[key]) delete index[key]
  })
  return removed
}

/** 列出所有缓存（用于主人查看）。 */
export async function listCache() {
  await ensureStore()
  const index = await readIndex()

  // 补登记孤儿文件：目录里有、索引里没有（旧版本写盘后进程被中断、或索引被删）。
  // 没有这一步，这些 PDF 明明躺在硬盘上，界面上却看不到、只能重新生成。
  let dirty = false
  let files = []
  try {
    files = await fsp.readdir(PDF_DIR)
  } catch {
    files = []
  }
  for (const f of files) {
    if (!f.endsWith('.pdf')) continue
    const key = f.slice(0, -4)
    if (index[key]) continue
    const m = /^(\d+)(?:_c(\d+)|_([a-z][\w-]*))?$/i.exec(key)
    if (!m) continue
    try {
      const st = await fsp.stat(path.join(PDF_DIR, f))
      if (!st.size) continue
      index[key] = {
        id: m[1],
        chapter: m[2] ? Number(m[2]) : null,
        ...(m[3] ? { tag: m[3] } : {}),
        file: f,
        size: st.size,
        time: st.mtimeMs,
        recovered: true,
        // 文件名里没有密码信息，PDF 本身又是加密的：不知道当初用什么口令生成，
        // 就不能拿去直接发，否则用户按提示输的密码打不开。当作「密码策略不明」，
        // 下次按当前配置重新生成一份（也就多一次，之后元数据就补回来了）。
        passwordUnknown: true,
      }
      dirty = true
    } catch {}
  }
  if (dirty) {
    // 只把孤儿合并回去，不整份覆盖：这期间别的进程可能刚写入了新条目
    const found = {}
    for (const [key, meta] of Object.entries(index)) {
      if (meta.recovered) found[key] = meta
    }
    await mutateIndex((cur) => {
      for (const [key, meta] of Object.entries(found)) if (!cur[key]) cur[key] = meta
    })
    return Object.values({ ...index, ...(await readIndex()) }).sort((a, b) => b.time - a.time)
  }

  return Object.values(index).sort((a, b) => b.time - a.time)
}
