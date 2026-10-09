/**
 * JM Reader —— TRSS-Yunzai 插件入口
 *
 * 把 JM Reader（Kotlin 漫画阅读器）的核心能力搬到 QQ 机器人上。
 * 信息类结果（详情/章节/搜索/列表/帮助）渲染为漫画风卡片图片发送；
 * 简短提示与错误仍为文字；#jm<数字> 发送加密 PDF。
 *
 * 命令：
 *   #jm<数字>                  下载该作为加密 PDF（密码 = 通用密码 + ID）
 *   #jmpdf <JM号> [章节序号]    同上，可指定单章
 *   #jm密码 [新密码|清空]       设置/查看/清空通用密码
 *   #jm搜索 <关键词|JM号|链接>
 *   #jm详情 <JM号>
 *   #jm章节 <JM号>
 *   #jm看 <JM号> [章节序号]    章节文字信息
 *   #jm热门 / #jm随机 / #jm分类
 *   #jm登录 <用户名> <密码> / #jm退出
 *   #jm收藏 / #jm历史
 *   #jm帮助
 *
 * 免责声明：本插件为个人学习与技术研究用途，与 18comic / JMComic / 禁漫天堂无任何关联。
 * 请尊重版权与内容来源的服务条款。
 */

import plugin from '../../lib/plugins/plugin.js'
import makeConfig from '../../lib/plugins/config.js'
import JmClient from './apps/jmcore.js'
import JmRepository, { buildComicPdf } from './apps/jm.js'
import { renderDetailCard, renderChaptersCard, renderListCard } from './apps/render.js'

const client = new JmClient()
const repo = new JmRepository(client)

// 插件配置：config/jmreader.yaml
//   pdfPassword: PDF 通用密码前缀，最终密码 = 通用密码 + 漫画ID
const { config, configSave } = await makeConfig('jmreader', {
  pdfPassword: '',
})

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
        { reg: new RegExp('^#?jm(帮助|help|说明|菜单)\\s*$', 'i'), fnc: 'help' },
        { reg: new RegExp('^#?jm(密码|password|密碼)\\s*(.*)$', 'i'), fnc: 'setPassword' },
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

  async search(e) {
    const kw = (e.msg.match(/^#?jm(?:搜索|搜|search)\s*(.*)$/i) || [])[1]?.trim()
    if (!kw) {
      await e.reply('用法：#jm搜索 <关键词|JM号|链接>')
      return true
    }
    const reply = await this.wrap(async () => {
      const r = await repo.search(kw, 1, 'site')
      // 纯数字 => 直接跳详情
      if (r.redirectAid) {
        const d = await repo.getAlbum(r.redirectAid)
        return { png: await renderDetailCard(d) }
      }
      if (!r.items.length) return `没有找到「${kw}」相关作品`
      const items = r.items.slice(0, 10).map((it, i) => ({
        no: `${i + 1}.`,
        name: it.name,
        author: it.author || '',
        id: it.id || '',
      }))
      const more = r.total > 10 ? `… 共 ${r.total} 条，用「#jm详情 JM号」查看` : ''
      return { png: await renderListCard({ title: `搜索：${kw}`, badge: '', items, more }) }
    })
    await this.send(e, reply)
    return true
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
        `PDF 密码 = 通用密码 + 漫画ID`,
      )
      return true
    }
    if (/^(清空|清除|clear|reset|空)$/i.test(text)) {
      config.pdfPassword = ''
      await configSave()
      await e.reply('✅ 通用密码已清空（PDF 密码将仅 = 漫画ID）')
      return true
    }
    // 限制长度，避免异常输入
    if (text.length > 32) {
      await e.reply('❌ 通用密码过长（最多 32 字符）')
      return true
    }
    config.pdfPassword = text
    await configSave()
    await e.reply(`✅ 通用密码已设置为「${text}」\n之后的 PDF 密码 = ${text} + 漫画ID`)
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

    // 密码 = 通用密码 + 漫画ID
    const commonPwd = (config.pdfPassword || '').trim()
    const password = commonPwd + id

    await e.reply('⏳ 正在下载并生成加密 PDF，可能需要一会儿…')
    try {
      await this.ensureBootstrap()
      const result = await buildComicPdf(
        client,
        repo,
        id,
        chapterIdx,
        password,
        (done, total) => {
          if (done % 10 === 0 || done === total) {
            e.reply(`⏳ 已处理 ${done}/${total} 页…`, false, { recallMsg: 5 }).catch(() => {})
          }
        },
      )
      // 写到临时文件，用 segment.file 发送（比 base64 更兼容各协议端）
      const { writeFile, mkdtemp, rm } = await import('node:fs/promises')
      const { tmpdir } = await import('node:os')
      const path = await import('node:path')
      const dir = await mkdtemp(path.join(tmpdir(), 'jmreader-'))
      // 文件名直接用作品 id.pdf
      const filePath = path.join(dir, `${id}.pdf`)
      await writeFile(filePath, result.buf)

      try {
        await e.reply([
          `📕《${result.name}》JM${id} 已生成加密 PDF（${result.pageCount} 页）\n🔑 密码：${password}`,
          segment.file(filePath, `${id}.pdf`),
        ])
      } finally {
        // 稍后清理临时文件
        setTimeout(() => rm(dir, { recursive: true, force: true }).catch(() => {}), 60000)
      }
    } catch (err) {
      await e.reply(`❌ ${err.serverMessage || err.message || '生成 PDF 失败'}`)
    }
    return true
  }

  async help(e) {
    try {
      await this.ensureBootstrap().catch(() => {})
      const items = [
        { no: '', name: '#jm<数字>', sub: '下载该作为加密 PDF，如 #jm1480269' },
        { no: '', name: '#jmpdf <JM号> [章节]', sub: '下载为加密 PDF（不填章节=整本）' },
        { no: '', name: '#jm密码 <新密码>', sub: '设置/查看/清空通用密码' },
        { no: '', name: '#jm搜索 <关键词|JM号|链接>', sub: '搜索作品' },
        { no: '', name: '#jm详情 <JM号>', sub: '查看详情' },
        { no: '', name: '#jm章节 <JM号>', sub: '章节列表' },
        { no: '', name: '#jm看 <JM号> [章节]', sub: '章节文字信息' },
        { no: '', name: '#jm热门 / #jm随机 / #jm分类', sub: '发现作品' },
        { no: '', name: '#jm登录 <用户名> <密码>', sub: '登录会员' },
        { no: '', name: '#jm退出 / #jm收藏 / #jm历史', sub: '会员功能' },
      ]
      const png = await renderListCard({
        title: 'JMReader 命令',
        badge: 'HELP',
        items,
        more: '🔒 PDF 密码 = 通用密码 + 漫画ID（用 #jm密码 设置/修改）',
      })
      await e.reply(segment.image(`base64://${png.toString('base64')}`))
    } catch {
      await e.reply('📖 JMReader 命令：#jm<数字> 下载加密 PDF；#jm搜索 / 详情 / 章节 / 看 / 热门 / 随机 / 分类 / 登录 / 收藏 / 历史 / pdf / 帮助')
    }
    return true
  }
}

export default JMReader
