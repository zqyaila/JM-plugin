/**
 * JM Reader —— TRSS-Yunzai 插件入口
 *
 * 把 JM Reader（Kotlin 漫画阅读器）的核心能力搬到 QQ 机器人上。
 * 信息类结果（详情/章节/搜索/列表/帮助）渲染为漫画风卡片图片发送；
 * 简短提示与错误仍为文字；#jm<数字> 发送加密 PDF。
 *
 * 命令：
 *   #jm<数字>                  下载该作为加密 PDF（双密码：通用密码 或 ID）
 *   #jmpdf <JM号> [章节序号]    同上，可指定单章
 *   #jm密码 [新密码|清空]       设置/查看/清空通用密码
 *   #jm搜索 <关键词> [页码]     搜索（支持翻页）
 *   #jm下一页 / #jm上一页      搜索结果翻页
 *   #jm详情 <JM号> / #jm章节 <JM号>
 *   #jm看 <JM号> [章节序号]    章节文字信息
 *   #jm热门 / #jm随机 / #jm分类
 *   #jm登录 <用户名> <密码> / #jm退出
 *   #jm收藏 / #jm历史
 *   #jm删除 <JM号> [章节]      主人：删除单个缓存
 *   #jm清缓存                  主人：清空全部缓存
 *   #jm缓存                    主人：查看缓存列表
 *   #jm代理 [地址|范围|测试|关闭]  查看/设置/测试代理
 *   #jm帮助
 *
 * 免责声明：本插件为个人学习与技术研究用途，与 18comic / JMComic / 禁漫天堂无任何关联。
 * 请尊重版权与内容来源的服务条款。
 */

import plugin from '../../lib/plugins/plugin.js'
import makeConfig from '../../lib/plugins/config.js'
import path from 'node:path'
import JmClient from './apps/jmcore.js'
import JmRepository, { buildComicPdf, countComicPages } from './apps/jm.js'
import { renderDetailCard, renderChaptersCard, renderListCard } from './apps/render.js'
import { getCachedPdf, putCachedPdf, removeCachedPdf, listCache, pdfPasswordMatches, DATA_DIR } from './apps/store.js'
import { createPageStore } from './web/pagecache.js'
import { parseProxyList, maskProxy, testProxy } from './apps/proxy.js'

const client = new JmClient()
const repo = new JmRepository(client)

/**
 * 网页端「在线阅读」把看过的页存在 data/pages（web/server.js 在另一个进程里写）。
 * 这里以只读方式复用同一份缓存：群里再要这本时，看过的页直接读盘，只有没看过的
 * 才联网下载 —— 两边共用目录，但写入权和 LRU 淘汰只归 web 进程，避免互相覆盖。
 */
let pageStore = null
function getPageStore() {
  if (!pageStore) {
    pageStore = createPageStore({
      dir: path.join(DATA_DIR, 'pages'),
      limitMB: 0, // 只读方不参与容量管理
      readOnly: true, // 不写索引、不删文件
    })
  }
  return pageStore
}

const { config, configSave } = await makeConfig('jmreader', {
  pdfPassword: '',
  pageSize: 10,
  imageQuality: 82,
  maxPages: 0,
  downloadConcurrency: 4,
  usePageCache: true,
  proxy: '',
  proxyMode: 'all',
})

// 锅巴网页配置回写钩子：锅巴面板保存时调用，同步到本插件配置并持久化
globalThis.__jmreaderConfig = config
globalThis.__jmreaderSetConfig = (data) => {
  if (!data || typeof data !== 'object') return
  if ('pdfPassword' in data) config.pdfPassword = data.pdfPassword ?? ''
  if ('pageSize' in data) {
    const n = parseInt(data.pageSize, 10)
    config.pageSize = Number.isFinite(n) && n > 0 ? Math.min(n, 20) : 10
  }
  if ('imageQuality' in data) {
    const q = parseInt(data.imageQuality, 10)
    config.imageQuality = Number.isFinite(q) && q >= 0 ? Math.min(q, 100) : 82
  }
  if ('maxPages' in data) {
    const m = parseInt(data.maxPages, 10)
    config.maxPages = Number.isFinite(m) && m > 0 ? m : 0
  }
  if ('downloadConcurrency' in data) {
    const c = parseInt(data.downloadConcurrency, 10)
    config.downloadConcurrency = Number.isFinite(c) && c > 0 ? Math.min(c, 10) : 4
  }
  if ('usePageCache' in data) {
    config.usePageCache = data.usePageCache !== false && data.usePageCache !== 'false'
  }
  if ('proxy' in data) {
    config.proxy = typeof data.proxy === 'string' ? data.proxy.trim() : ''
  }
  if ('proxyMode' in data) {
    const m = String(data.proxyMode || '').toLowerCase()
    config.proxyMode = ['all', 'api', 'image', 'off'].includes(m) ? m : 'all'
  }
  configSave().catch(() => {})
}

export class JMReader extends plugin {
  constructor() {
    super({
      name: 'JMReader',
      dsc: 'JM 漫画搜索 / 详情 / 阅读',
      event: 'message',
      priority: 5000,
      rule: [
        { reg: new RegExp('^#?jm(\\d{5,})\\s*$', 'i'), fnc: 'pdf' },
        { reg: new RegExp('^#?jm(搜索|搜|search)\\s*(.*)$', 'i'), fnc: 'search' },
        { reg: new RegExp('^#?jm(详情|detail|info)\\s*(.*)$', 'i'), fnc: 'detail' },
        { reg: new RegExp('^#?jm(章节|章|list)\\s*(.*)$', 'i'), fnc: 'chapters' },
        { reg: new RegExp('^#?jm(看|读|read)\\s*(.*)$', 'i'), fnc: 'read' },
        { reg: new RegExp('^#?jm(热门|hot)\\s*$', 'i'), fnc: 'hot' },
        { reg: new RegExp('^#?jm(随机|random)\\s*$', 'i'), fnc: 'random' },
        { reg: new RegExp('^#?jm(分类|category|cat)\\s*$', 'i'), fnc: 'category' },
        { reg: new RegExp('^#?jm(登录|login)\\s+(\\S+)\\s+(\\S+)', 'i'), fnc: 'login' },
        { reg: new RegExp('^#?jm(退出|登出|logout)\\s*$', 'i'), fnc: 'logout' },
        { reg: new RegExp('^#?jm(收藏|fav|favorite)\\s*$', 'i'), fnc: 'favorite' },
        { reg: new RegExp('^#?jm(历史|history)\\s*$', 'i'), fnc: 'history' },
        { reg: new RegExp('^#?jm(pdf|下载|download|导出)\\s*(.*)$', 'i'), fnc: 'pdf' },
        { reg: new RegExp('^#?jm(代理|proxy)\\s*(.*)$', 'i'), fnc: 'proxyCmd' },
        { reg: new RegExp('^#?jm(帮助|help|说明|菜单)\\s*$', 'i'), fnc: 'help' },
        { reg: new RegExp('^#?jm(密码|password|密碼)\\s*(.*)$', 'i'), fnc: 'setPassword' },
        { reg: new RegExp('^#?jm(下一页|下页|next)\\s*$', 'i'), fnc: 'nextPage' },
        { reg: new RegExp('^#?jm(上一页|上页|prev|previous)\\s*$', 'i'), fnc: 'prevPage' },
        { reg: new RegExp('^#?jm(删除|删|del|delete)\\s*(.*)$', 'i'), fnc: 'delResource', permission: 'master' },
        { reg: new RegExp('^#?jm(清缓存|清除缓存|clearcache)\\s*$', 'i'), fnc: 'clearCache', permission: 'master' },
        { reg: new RegExp('^#?jm(缓存列表|缓存|cache)\\s*$', 'i'), fnc: 'cacheList', permission: 'master' },
      ],
    })
  }

  // -------------------------------------------------------------------------
  // 工具方法
  // -------------------------------------------------------------------------

  /** 从消息里提取 JM 号（纯数字 / JM123456 / 链接）。 */
  parseId(text) {
    if (!text) return null
    const m = text.match(/(\d{5,})/)
    return m ? m[1] : null
  }

  async ensureBootstrap() {
    // 每次操作前同步一次代理配置，锅巴面板或 #jm代理 改动后即时生效
    client.applyProxy({ proxy: config.proxy, proxyMode: config.proxyMode })
    if (!client.apiUrl) await client.bootstrap()
  }

  async wrap(fn) {
    try {
      await this.ensureBootstrap()
      return await fn()
    } catch (e) {
      return `❌ ${e.serverMessage || e.message || '发生错误'}`
    }
  }

  /** 文字或错误 → 直接回复；对象 { png } → 回复图片。 */
  async send(e, result) {
    if (result && result.png) {
      await e.reply(segment.image(`base64://${result.png.toString('base64')}`))
    } else {
      await e.reply(result)
    }
  }

  // -------------------------------------------------------------------------
  // 命令处理
  // -------------------------------------------------------------------------

  // 搜索会话（按 user_id + group_id 区分），用于翻页
  searchSessions = new Map()

  /** 每页条数（配置）。 */
  get pageSize() {
    const n = parseInt(config.pageSize, 10)
    return Number.isFinite(n) && n > 0 ? Math.min(n, 20) : 10
  }

  /** PDF 最大页数限制（配置，0 = 不限制）。 */
  get maxPages() {
    const n = parseInt(config.maxPages, 10)
    return Number.isFinite(n) && n > 0 ? n : 0
  }

  /** 下载并发数（配置，默认 4）。 */
  get downloadConcurrency() {
    const n = parseInt(config.downloadConcurrency, 10)
    return Number.isFinite(n) && n > 0 ? Math.min(n, 10) : 4
  }

  /** 复用网页端阅读缓存（默认开）。 */
  get usePageCache() {
    return config.usePageCache !== false && config.usePageCache !== 'false'
  }

  /**
   * 拉取「本地第 localPage 页」的搜索数据。
   * 服务端每页固定 80 条，本地按 pageSize 切片，跨服务端页时自动请求对应服务端页。
   * @returns {Promise<{ items, total, localPage, totalPages }>}
   */
  async _fetchSearchPage(kw, localPage) {
    const pageSize = this.pageSize
    // 服务端每页固定 80 条
    const SERVER_PAGE = 80
    const globalStart = (localPage - 1) * pageSize // 全局起始下标（0 起）
    const serverPage = Math.floor(globalStart / SERVER_PAGE) + 1
    const offsetInServer = globalStart % SERVER_PAGE

    const r = await repo.search(kw, serverPage, 'site')
    const all = r.items
    const slice = all.slice(offsetInServer, offsetInServer + pageSize)
    return {
      items: slice,
      total: r.total,
      localPage,
      totalPages: Math.max(1, Math.ceil(r.total / pageSize)),
      redirectAid: r.redirectAid,
    }
  }

  async search(e) {
    const text = (e.msg.match(/^#?jm(?:搜索|搜|search)\s*(.*)$/i) || [])[1]?.trim()
    if (!text) {
      await e.reply('用法：#jm搜索 <关键词|JM号|链接> [页码]')
      return true
    }
    // 支持末尾带页码：如「妹妹 2」
    let kw = text
    let page = 1
    const m = text.match(/^(.*?)\s+(\d{1,2})\s*$/)
    if (m && m[2]) {
      kw = m[1].trim() || text
      page = parseInt(m[2], 10)
    }
    const reply = await this.wrap(async () => {
      const r = await this._fetchSearchPage(kw, page)
      // 纯数字 => 直接跳详情
      if (r.redirectAid) {
        const d = await repo.getAlbum(r.redirectAid)
        return { png: await renderDetailCard(d) }
      }
      if (!r.items.length) return `没有找到「${kw}」相关作品（或该页无结果）`
      // 记录会话，供翻页
      const sessionKey = `${e.isGroup ? 'g' : 'p'}:${e.isGroup ? e.group_id : e.user_id}`
      this.searchSessions.set(sessionKey, { kw, page: r.localPage, total: r.total })

      const items = r.items.map((it, i) => ({
        no: `${(r.localPage - 1) * this.pageSize + i + 1}.`,
        name: it.name,
        author: it.author || '',
        id: it.id || '',
      }))
      const more = r.totalPages > 1
        ? `第 ${r.localPage}/${r.totalPages} 页 · 共 ${r.total} 条 · 回复「#jm下一页」/「#jm上一页」翻页`
        : `共 ${r.total} 条`
      return { png: await renderListCard({ title: `搜索：${kw}`, badge: `P${r.localPage}`, items, more }) }
    })
    await this.send(e, reply)
    return true
  }

  /** 翻页（上一页/下一页共用）。 */
  async _turnPage(e, delta) {
    const sessionKey = `${e.isGroup ? 'g' : 'p'}:${e.isGroup ? e.group_id : e.user_id}`
    const sess = this.searchSessions.get(sessionKey)
    if (!sess) {
      await e.reply('没有正在进行的搜索，请先 #jm搜索 <关键词>')
      return true
    }
    const next = sess.page + delta
    if (next < 1) {
      await e.reply('已经是第一页了')
      return true
    }
    const reply = await this.wrap(async () => {
      const r = await this._fetchSearchPage(sess.kw, next)
      if (!r.items.length) return '已经是最后一页了'
      sess.page = r.localPage
      const items = r.items.map((it, i) => ({
        no: `${(r.localPage - 1) * this.pageSize + i + 1}.`,
        name: it.name,
        author: it.author || '',
        id: it.id || '',
      }))
      const more = `第 ${r.localPage}/${r.totalPages} 页 · 共 ${r.total} 条 · 回复「#jm下一页」/「#jm上一页」翻页`
      return { png: await renderListCard({ title: `搜索：${sess.kw}`, badge: `P${r.localPage}`, items, more }) }
    })
    await this.send(e, reply)
    return true
  }

  async nextPage(e) {
    return this._turnPage(e, 1)
  }

  async prevPage(e) {
    return this._turnPage(e, -1)
  }

  async detail(e) {
    const text = (e.msg.match(/^#?jm(?:详情|detail|info)\s*(.*)$/i) || [])[1]?.trim()
    const id = this.parseId(text)
    if (!id) {
      await e.reply('用法：#jm详情 <JM号>')
      return true
    }
    const reply = await this.wrap(async () => {
      const d = await repo.getAlbum(id)
      return { png: await renderDetailCard(d) }
    })
    await this.send(e, reply)
    return true
  }

  async chapters(e) {
    const text = (e.msg.match(/^#?jm(?:章节|章|list)\s*(.*)$/i) || [])[1]?.trim()
    const id = this.parseId(text)
    if (!id) {
      await e.reply('用法：#jm章节 <JM号>')
      return true
    }
    const reply = await this.wrap(async () => {
      const d = await repo.getAlbum(id)
      if (!d.series.length) return `《${d.name}》暂无章节信息`
      return { png: await renderChaptersCard(d) }
    })
    await this.send(e, reply)
    return true
  }

  async read(e) {
    const text = (e.msg.match(/^#?jm(?:看|读|read)\s*(.*)$/i) || [])[1]?.trim()
    const parts = text.split(/\s+/).filter(Boolean)
    const id = this.parseId(parts[0])
    if (!id) {
      await e.reply('用法：#jm看 <JM号> [章节序号]\n仅返回章节文字信息，不发图片')
      return true
    }
    const chapterIdx = parts[1] ? parseInt(parts[1], 10) : 1

    const reply = await this.wrap(async () => {
      const d = await repo.getAlbum(id)
      const series = d.series.length ? d.series : [{ id: d.id, name: d.name, sort: 1 }]
      const ch = series.find((s) => s.sort === chapterIdx) || series[0]
      const rd = await repo.comicRead(ch.id)
      if (!rd.images.length) return `《${d.name}》 ${ch.name} 暂无图片`
      return [
        `📖《${d.name}》JM${d.id}`,
        `章节：${ch.name}（第 ${ch.sort} 章）`,
        `页数：${rd.images.length} 页`,
        '',
        `发送 #jm${d.id} 可下载本作为加密 PDF（密码 = 通用密码 + ${d.id}）`,
      ].join('\n')
    })
    await e.reply(reply)
    return true
  }

  async hot(e) {
    const reply = await this.wrap(async () => {
      const list = await repo.getLatest(1)
      if (!list.length) return '暂无最新数据'
      const items = list.slice(0, 10).map((it, i) => ({
        no: `${i + 1}.`,
        name: it.name,
        author: it.author || '',
        id: it.id || '',
      }))
      return { png: await renderListCard({ title: '最新更新', badge: 'HOT', items }) }
    })
    await this.send(e, reply)
    return true
  }

  async random(e) {
    const reply = await this.wrap(async () => {
      const list = await repo.randomRecommend()
      if (!list.length) return '暂无随机推荐'
      const it = list[Math.floor(Math.random() * list.length)]
      const d = await repo.getAlbum(it.id)
      return { png: await renderDetailCard(d) }
    })
    await this.send(e, reply)
    return true
  }

  async category(e) {
    const reply = await this.wrap(async () => {
      const cats = await repo.categories()
      if (!cats.length) return '暂无分类'
      const items = cats.slice(0, 15).map((c, i) => ({
        no: `${i + 1}.`,
        name: c.title,
        sub: c.subCategories.length ? `${c.subCategories.length} 个子类` : '',
        slug: c.slug || '',
      }))
      return { png: await renderListCard({ title: '作品分类', badge: '', items }) }
    })
    await this.send(e, reply)
    return true
  }

  async login(e) {
    const m = e.msg.match(/^#?jm(?:登录|login)\s+(\S+)\s+(\S+)/i)
    const username = m?.[1]
    const password = m?.[2]
    if (!username || !password) {
      await e.reply('用法：#jm登录 <用户名> <密码>\n⚠️ 密码会出现在聊天记录中，请谨慎使用')
      return true
    }
    const reply = await this.wrap(async () => {
      const member = await repo.login(username, password)
      return `✅ 登录成功\n用户名：${member.username}\n昵称：${member.nickName}\n等级：${member.levelName || member.level}\n金币：${member.coin}`
    })
    await e.reply(reply)
    return true
  }

  async logout(e) {
    await repo.logout().catch(() => {})
    await e.reply('已退出登录')
    return true
  }

  async setPassword(e) {
    const text = (e.msg.match(/^#?jm(?:密码|password|密碼)\s*(.*)$/i) || [])[1]?.trim()
    if (!text) {
      const cur = (config.pdfPassword || '').trim()
      await e.reply(
        `当前通用密码：${cur ? `「${cur}」` : '（未设置）'}\n\n` +
        `用法：\n` +
        `#jm密码 <新密码>  设置通用密码\n` +
        `#jm密码 清空      清空通用密码\n\n` +
        `PDF 双密码：通用密码 或 作品ID，二选一即可打开`,
      )
      return true
    }
    if (/^(清空|清除|clear|reset|空)$/i.test(text)) {
      config.pdfPassword = ''
      await configSave()
      await e.reply('✅ 通用密码已清空（PDF 将仅可用作品ID打开）')
      return true
    }
    // 限制长度，避免异常输入
    if (text.length > 32) {
      await e.reply('❌ 通用密码过长（最多 32 字符）')
      return true
    }
    config.pdfPassword = text
    await configSave()
    await e.reply(`✅ 通用密码已设置为「${text}」\n之后的 PDF 双密码：通用密码「${text}」或 作品ID，二选一即可打开`)
    return true
  }

  /** #jm代理 —— 查看 / 设置 / 关闭 / 测试代理。 */
  async proxyCmd(e) {
    const text = (e.msg.match(/^#?jm(?:代理|proxy)\s*(.*)$/i) || [])[1]?.trim() || ''
    const modeText = { all: '全部流量', api: '仅接口', image: '仅图片', off: '已关闭' }
    const summary = client.proxySummary()

    if (!text) {
      await e.reply([
        `🌐 当前代理：${summary.text}`,
        `📡 生效范围：${modeText[summary.mode] || summary.mode}`,
        '',
        '用法：',
        '#jm代理 <地址>             设置代理，如 http://127.0.0.1:7890',
        '#jm代理 <地址1>,<地址2>    配置多个，失败自动轮换',
        '#jm代理 socks5://user:pass@127.0.0.1:1080',
        '#jm代理 范围 api           仅接口走代理（图片直连）',
        '#jm代理 范围 image         仅图片走代理（接口直连）',
        '#jm代理 测试               测试代理连通性',
        '#jm代理 关闭               关闭代理，恢复直连',
        '',
        '⚠️ 代理地址会保存在配置文件中；在聊天里设置含密码的代理会留在聊天记录里。',
      ].join('\n'))
      return true
    }

    if (/^(测试|测速|test|check)$/i.test(text)) {
      const list = parseProxyList(config.proxy)
      if (!list.length) {
        await e.reply('当前未配置代理（直连模式）。用 #jm代理 <地址> 设置后再测试。')
        return true
      }
      await e.reply(`🔍 正在测试 ${list.length} 个代理…`)
      const lines = []
      for (const p of list) {
        try {
          const r = await testProxy(p, 10000)
          lines.push(`✅ ${maskProxy(p)} · ${r.ms}ms · 出口 ${r.ip || '?'}${r.loc ? ` (${r.loc})` : ''}`)
        } catch (err) {
          lines.push(`❌ ${maskProxy(p)} · ${err.message}`)
        }
      }
      await e.reply(['🌐 代理连通性测试：', ...lines].join('\n'))
      return true
    }

    if (/^(关闭|关|停用|off|none|disable|清空|清除)$/i.test(text)) {
      config.proxy = ''
      config.proxyMode = 'off'
      await configSave()
      client.applyProxy({ proxy: '', proxyMode: 'off' })
      client.apiUrl = null
      await e.reply('✅ 代理已关闭，恢复直连')
      return true
    }

    // 设置生效范围：#jm代理 范围 api
    const modeMatch = text.match(/^(?:范围|模式|mode|scope)\s*(all|api|image|全部|接口|图片)$/i)
    if (modeMatch) {
      const raw = modeMatch[1].toLowerCase()
      const mode = { 全部: 'all', 接口: 'api', 图片: 'image' }[raw] || raw
      if (!parseProxyList(config.proxy).length) {
        await e.reply('还没有设置代理地址，请先发送 #jm代理 <地址>')
        return true
      }
      config.proxyMode = mode
      await configSave()
      client.applyProxy({ proxy: config.proxy, proxyMode: mode })
      await e.reply(`✅ 代理生效范围已设为「${modeText[mode]}」（${mode}）`)
      return true
    }

    // 设置代理地址（支持多个，逗号/空白分隔）
    const list = parseProxyList(text)
    if (!list.length) {
      await e.reply([
        '❌ 无法识别该代理地址。',
        '支持格式：',
        '· http://127.0.0.1:7890',
        '· https://user:pass@127.0.0.1:8443',
        '· socks5://127.0.0.1:1080',
        '· socks5://user:pass@127.0.0.1:1080',
        '· 127.0.0.1:7890（省略协议时按 http 处理）',
      ].join('\n'))
      return true
    }

    config.proxy = list.map((p) => p.url).join(',')
    if (!config.proxyMode || config.proxyMode === 'off') config.proxyMode = 'all'
    await configSave()
    client.applyProxy({ proxy: config.proxy, proxyMode: config.proxyMode })
    client.apiUrl = null // 清掉旧主机，重新探测（部分主机只在代理下可达）
    await e.reply([
      `✅ 代理已设置（${list.length} 个）`,
      ...list.map((p) => `· ${maskProxy(p)}`),
      `📡 生效范围：${modeText[config.proxyMode]}`,
      '',
      '发送「#jm代理 测试」可验证连通性',
    ].join('\n'))
    return true
  }

  async favorite(e) {
    const reply = await this.wrap(async () => {
      const list = await repo.favorites(1)
      if (!list.length) return '暂无收藏（需登录）'
      const items = list.slice(0, 10).map((it, i) => ({
        no: `${i + 1}.`,
        name: it.name,
        author: it.author || '',
        id: it.id || '',
      }))
      return { png: await renderListCard({ title: '我的收藏', badge: 'FAV', items }) }
    })
    await this.send(e, reply)
    return true
  }

  async history(e) {
    const reply = await this.wrap(async () => {
      const h = await repo.cloudHistory(1)
      if (!h.items.length) return '暂无观看历史（需登录）'
      const items = h.items.slice(0, 10).map((it, i) => ({
        no: `${i + 1}.`,
        name: it.name,
        author: it.author || '',
        id: it.id || '',
      }))
      return { png: await renderListCard({ title: '观看历史', badge: '', items }) }
    })
    await this.send(e, reply)
    return true
  }

  /** 发送 PDF 文件，带兜底与友好错误提示。 */
  async _sendPdfFile(e, filePath, fileName, headMsg) {
    try {
      await e.reply([headMsg, segment.file(filePath, fileName)])
      return
    } catch (err) {
      // 上传失败（如 QQ 群文件 210005）兜底：读字节转 base64 直发一次
      try {
        const { readFile } = await import('node:fs/promises')
        const buf = await readFile(filePath)
        await e.reply([headMsg, segment.file(`base64://${buf.toString('base64')}`, fileName)])
      } catch (err2) {
        const msg = err2?.message || err?.message || ''
        let tip = '请稍后重试，或改在私聊里发送。'
        if (/210005|HTTP Upload|httpUpload/i.test(msg)) {
          tip = 'QQ 群文件上传被拒（可能群文件空间已满，或短时间重复上传同一文件）。\n建议：清理群文件空间后重试，或改在私聊里发送（私聊文件不受群空间限制）。'
        }
        await e.reply(`❌ 文件发送失败：${msg}\n${tip}`)
      }
    }
  }

  async pdf(e) {
    // 兼容两种触发形式：#jm1480269（纯数字）或 #jmpdf 1480269 [章节]
    const text = (e.msg.match(/^#?jm(?:pdf|下载|download|导出)?\s*(.*)$/i) || [])[1]?.trim()
    const parts = text.split(/\s+/).filter(Boolean)
    const id = this.parseId(parts[0])
    if (!id) {
      await e.reply('用法：#jm<数字> 或 #jmpdf <JM号> [章节序号]\n不填章节=整本，填了=单章')
      return true
    }
    const chapterIdx = parts[1] ? parseInt(parts[1], 10) : null

    // 双密码：通用密码（userPassword）+ 作品 id（ownerPassword）
    const commonPwd = (config.pdfPassword || '').trim()
    const userPassword = commonPwd
    const ownerPassword = id

    // 最大页数限制 + 预计时间：用 comicRead 拿真实页数（含单行本）
    const maxPages = this.maxPages
    let totalPage = 0
    try {
      await this.ensureBootstrap()
      totalPage = await countComicPages(repo, id, chapterIdx)
      if (maxPages > 0 && totalPage > maxPages) {
        await e.reply(`❌ 该漫画共 ${totalPage} 页，超过最大页数限制（${maxPages} 页）\n请改用单章下载：#jmpdf ${id} <章节序号>，或联系主人调高限制`)
        return true
      }
    } catch {}

    // 先查缓存：只有「同一套密码策略」才能直接发。
    // 网页端可能用别的密码（或干脆不加密）生成过一份，直接发出去用户拿到的口令打不开。
    const cached = await getCachedPdf(id, chapterIdx)
    if (cached && pdfPasswordMatches(cached.meta, userPassword, ownerPassword)) {
      // 命中缓存，直接发
      const headMsg = `📕《${cached.meta.name || `JM${id}`}》JM${id}（缓存）已生成加密 PDF（${cached.meta.pageCount} 页）\n🔑 密码：通用密码「${userPassword || '（空）'}」或 作品ID「${id}」二选一即可打开`
      const fileName = `${id}${chapterIdx != null ? `_c${chapterIdx}` : ''}.pdf`
      await this._sendPdfFile(e, cached.file, fileName, headMsg)
      return true
    }

    // 网页端「在线阅读」缓存过的页直接读盘，只有没看过的才联网下载
    const loadCached =
      this.usePageCache
        ? async (cid, p) => {
            try {
              const hit = await getPageStore().get(cid, p)
              return hit?.buf || null
            } catch {
              return null
            }
          }
        : null
    // 只读方拿的是磁盘快照，任务开始前刷新一次，免得网页刚看的新页被漏掉
    if (loadCached) getPageStore().refresh()

    // 估算预计时间（按并发数折算）
    const concurrency = this.downloadConcurrency
    let estimate = ''
    if (totalPage > 0) {
      // 每页约 1.5s，并发后总时间 ≈ 页数 × 1.5 / 并发
      const secs = Math.ceil((totalPage * 1.5) / concurrency)
      estimate = `预计 ${totalPage} 页，约 ${secs > 60 ? Math.round(secs / 60) + ' 分钟' : secs + ' 秒'}`
    }
    await e.reply(
      `⏳ 正在下载并生成加密 PDF…${estimate ? `\n📊 ${estimate}` : ''}` +
        (loadCached ? '\n⚡ 网页里看过的页会直接从本地读取，不重复下载' : ''),
    )
    try {
      await this.ensureBootstrap()
      const result = await buildComicPdf(
        client,
        repo,
        id,
        chapterIdx,
        userPassword,
        ownerPassword,
        () => {}, // 不逐条发进度，避免刷屏
        {
          concurrency,
          retries: 3,
          retryDelay: 2000,
          quality: parseInt(config.imageQuality, 10) || 82,
          loadCached,
        },
      )
      // 持久化缓存
      await putCachedPdf(id, chapterIdx, result.buf, {
        name: result.name,
        pageCount: result.pageCount,
        userPassword,
        ownerPassword,
      })
      const rec = await getCachedPdf(id, chapterIdx)
      const fileName = `${id}${chapterIdx != null ? `_c${chapterIdx}` : ''}.pdf`

      const hitNote =
        result.cacheHits > 0
          ? `\n⚡ 其中 ${result.cacheHits}/${result.pageCount} 页取自网页阅读缓存，没有重复下载`
          : ''
      const headMsg = `📕《${result.name}》JM${id} 已生成加密 PDF（${result.pageCount} 页）${hitNote}\n🔑 密码：通用密码「${userPassword || '（空）'}」或 作品ID「${id}」二选一即可打开`
      await this._sendPdfFile(e, rec.file, fileName, headMsg)
    } catch (err) {
      await e.reply(`❌ ${err.serverMessage || err.message || '生成 PDF 失败'}`)
    }
    return true
  }

  /** 主人删除单个缓存资源。 */
  async delResource(e) {
    const text = (e.msg.match(/^#?jm(?:删除|删|del|delete)\s*(.*)$/i) || [])[1]?.trim()
    const id = this.parseId(text)
    if (!id) {
      await e.reply('用法：#jm删除 <JM号> [章节序号]\n删除指定作品的缓存 PDF；#jm清缓存 清空全部')
      return true
    }
    const parts = text.split(/\s+/).filter(Boolean)
    const chapterIdx = parts[1] ? parseInt(parts[1], 10) : null
    const n = await removeCachedPdf(id, chapterIdx)
    await e.reply(n > 0 ? `✅ 已删除 JM${id}${chapterIdx != null ? ` 第${chapterIdx}章` : ''} 的缓存 PDF` : `未找到 JM${id} 的缓存`)
    return true
  }

  /** 主人清空全部缓存。 */
  async clearCache(e) {
    const n = await removeCachedPdf('all')
    await e.reply(`✅ 已清空缓存，删除 ${n} 个 PDF 文件`)
    return true
  }

  /** 主人查看缓存列表。 */
  async cacheList(e) {
    const list = await listCache()
    if (!list.length) {
      await e.reply('暂无缓存')
      return true
    }
    const totalSize = list.reduce((s, it) => s + (it.size || 0), 0)
    const lines = list.slice(0, 20).map((it) => {
      const mb = ((it.size || 0) / 1024 / 1024).toFixed(1)
      const ch = it.chapter != null ? ` 第${it.chapter}章` : ''
      return `· ${it.name || `JM${it.id}`} (${it.id}${ch}) ${mb}MB`
    })
    const more = list.length > 20 ? `\n… 共 ${list.length} 个，总计 ${(totalSize / 1024 / 1024).toFixed(1)}MB` : `\n总计 ${(totalSize / 1024 / 1024).toFixed(1)}MB`
    await e.reply(`📦 缓存列表（${list.length} 个）：\n${lines.join('\n')}${more}\n\n#jm删除 <JM号> 删除单个，#jm清缓存 清空全部`)
    return true
  }

  async help(e) {
    try {
      await this.ensureBootstrap().catch(() => {})
      const items = [
        { no: '', name: '#jm<数字>', sub: '下载该作为加密 PDF，如 #jm1480269' },
        { no: '', name: '#jmpdf <JM号> [章节]', sub: '下载为加密 PDF（不填章节=整本）' },
        { no: '', name: '#jm密码 <新密码>', sub: '设置/查看/清空通用密码' },
        { no: '', name: '#jm搜索 <关键词> [页码]', sub: '搜索作品（可翻页）' },
        { no: '', name: '#jm下一页 / #jm上一页', sub: '搜索结果翻页' },
        { no: '', name: '#jm详情 <JM号> / #jm章节 <JM号>', sub: '详情 / 章节' },
        { no: '', name: '#jm看 <JM号> [章节]', sub: '章节文字信息' },
        { no: '', name: '#jm热门 / #jm随机 / #jm分类', sub: '发现作品' },
        { no: '', name: '#jm登录 / #jm退出 / #jm收藏 / #jm历史', sub: '会员功能' },
        { no: '', name: '#jm删除 <JM号> / #jm清缓存', sub: '主人：删除/清空缓存' },
        { no: '', name: '#jm代理 <地址>', sub: 'HTTP/SOCKS5 代理，支持多代理轮换' },
      ]
      const png = await renderListCard({
        title: 'JMReader 命令',
        badge: 'HELP',
        items,
        more: '🔒 PDF 双密码：通用密码 或 作品ID 二选一打开 · 🌐 #jm代理 设置代理下载',
      })
      await e.reply(segment.image(`base64://${png.toString('base64')}`))
    } catch {
      await e.reply('📖 JMReader 命令：#jm<数字> 下载加密 PDF；#jm搜索 / 详情 / 章节 / 看 / 热门 / 随机 / 分类 / 登录 / 收藏 / 历史 / pdf / 帮助')
    }
    return true
  }
}

export default JMReader
