/**
 * 本地收藏夹。
 *
 * 存在 `data/favorites.json`，和 `data/pages/` 一样属于「服务端自己的数据」，
 * 不依赖 JM 账号、不需要登录 —— Web 端本来就是一个口令共享的自建服务，
 * 账号收藏（`/favorite`）在没有登录态时根本用不了。
 *
 * 只存最少的信息：id / 名称 / 作者 / 收藏时间，封面按 id 现取（有专门的封面缓存）。
 * 单个数组、上限 5000 条；写盘走「临时文件 + rename」，进程被杀不会留下半个 JSON。
 */
import fs from 'node:fs/promises'
import path from 'node:path'

const MAX_ITEMS = 5000

const clampText = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

export function createFavorites({ file }) {
  let items = []
  let ready = null
  let queue = Promise.resolve()

  async function read() {
    try {
      const raw = await fs.readFile(file, 'utf8')
      const data = JSON.parse(raw)
      const list = Array.isArray(data) ? data : data?.items
      if (!Array.isArray(list)) return []
      return list
        .filter((it) => it && /^\d{4,}$/.test(String(it.id || '')))
        .map((it) => ({
          id: String(it.id),
          name: clampText(it.name, 200),
          author: clampText(it.author, 100),
          sort: Number(it.sort) || 0,
          totalPages: Number(it.totalPages) || 0,
          time: Number(it.time) || 0,
        }))
        .sort((a, b) => b.time - a.time)
    } catch (e) {
      if (e.code === 'ENOENT') return []
      // 文件坏了不要每次启动都崩：留个副本，按空收藏夹继续
      console.error('[favorites] 收藏文件解析失败，已另存备份：', e.message)
      await fs.rename(file, `${file}.broken-${Date.now()}`).catch(() => {})
      return []
    }
  }

  function ensure() {
    if (!ready) {
      ready = read().then((list) => {
        items = list
        return items
      })
    }
    return ready
  }

  /**
   * 串行写盘。调用方不等也可以，但同一时刻只有一次 rename，
   * 连续点收藏不会出现「后写的先落盘」。
   */
  function persist() {
    const snapshot = items
    queue = queue
      .then(async () => {
        await fs.mkdir(path.dirname(file), { recursive: true })
        const tmp = `${file}.tmp`
        await fs.writeFile(tmp, JSON.stringify({ version: 1, items: snapshot }, null, 2), 'utf8')
        await fs.rename(tmp, file)
      })
      .catch((e) => console.error('[favorites] 写入失败：', e.message))
    return queue
  }

  return {
    async list() {
      await ensure()
      return items.map((it) => ({ ...it }))
    },

    async has(id) {
      await ensure()
      return items.some((it) => it.id === String(id))
    },

    /** 新增或更新（重复收藏不报错，只是刷新名称/作者并保持原收藏时间）。 */
    async add(input = {}) {
      await ensure()
      const id = String(input.id || '')
      if (!/^\d{4,}$/.test(id)) throw new Error('JM 号不合法')

      const prev = items.find((it) => it.id === id)
      if (!prev && items.length >= MAX_ITEMS) throw new Error(`收藏夹最多 ${MAX_ITEMS} 部`)

      const item = {
        id,
        name: clampText(input.name, 200) || prev?.name || `JM${id}`,
        author: clampText(input.author, 100) || prev?.author || '',
        sort: Number(input.sort) || prev?.sort || 0,
        totalPages: Number(input.totalPages) || prev?.totalPages || 0,
        time: prev?.time || Date.now(),
      }
      items = [item, ...items.filter((it) => it.id !== id)]
      await persist()
      return { ...item }
    },

    async remove(id) {
      await ensure()
      const key = String(id)
      const next = items.filter((it) => it.id !== key)
      if (next.length === items.length) return false
      items = next
      await persist()
      return true
    },

    async clear() {
      await ensure()
      const n = items.length
      items = []
      await persist()
      return n
    },

    async stats() {
      await ensure()
      return { total: items.length, limit: MAX_ITEMS }
    },
  }
}
