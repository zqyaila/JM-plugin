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

/** 读索引（容错，损坏则返回空对象）。 */
async function readIndex() {
  try {
    const raw = await fsp.readFile(INDEX_FILE, 'utf8')
    return JSON.parse(raw || '{}')
  } catch {
    return {}
  }
}

/** 写索引。 */
async function writeIndex(index) {
  await fsp.writeFile(INDEX_FILE, JSON.stringify(index, null, 2), 'utf8')
}

/** 生成缓存文件名。整本=id，单章=id_c<章节>。 */
export function cacheKey(id, chapterIdx = null) {
  return chapterIdx != null ? `${id}_c${chapterIdx}` : `${id}`
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
  await fsp.writeFile(path.join(PDF_DIR, `${key}.pdf`), buf)
  const index = await readIndex()
  index[key] = {
    id,
    chapter: chapterIdx,
    file: `${key}.pdf`,
    size: buf.length,
    time: Date.now(),
    ...meta,
  }
  await writeIndex(index)
  return key
}

/**
 * 删除缓存。
 * @param {string} id 作品 id；传 'all' 清空全部
 * @param {number|null} chapterIdx
 * @returns {Promise<number>} 删除的文件数
 */
export async function removeCachedPdf(id, chapterIdx = null) {
  await ensureStore()
  const index = await readIndex()
  let removed = 0

  if (id === 'all') {
    for (const key of Object.keys(index)) {
      const f = path.join(PDF_DIR, `${key}.pdf`)
      try {
        await fsp.rm(f, { force: true })
        removed++
      } catch {}
      delete index[key]
    }
    await writeIndex(index)
    return removed
  }

  const key = cacheKey(id, chapterIdx)
  if (index[key]) {
    try {
      await fsp.rm(path.join(PDF_DIR, `${key}.pdf`), { force: true })
      removed = 1
    } catch {}
    delete index[key]
  }
  await writeIndex(index)
  return removed
}

/** 列出所有缓存（用于主人查看）。 */
export async function listCache() {
  await ensureStore()
  const index = await readIndex()
  return Object.values(index).sort((a, b) => b.time - a.time)
}
