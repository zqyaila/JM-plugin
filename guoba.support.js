/**
 * 锅巴网页配置接入（guoba-plugin-next）
 *
 * 提供插件配置项，在锅巴面板里可视化修改：
 *  - pdfPassword：PDF 通用密码（userPassword）
 *  - pageSize：列表每页显示条数
 *  - imageQuality：PDF 图片压缩质量
 *  - maxPages：单个 PDF 的页数拒绝阈值
 *  - downloadConcurrency：下载并发
 *  - mergePageLimit：多个章节合并成一个 PDF 的页数上限
 *  - usePageCache：复用网页阅读缓存
 *  - proxy / proxyMode：网络代理
 *
 * 配置读写有两条通道：
 *  1. 插件在跑：走 index.js 注册的 globalThis 钩子，改内存 + configSave，立即生效；
 *  2. 插件没加载 / 钩子没注册：直接改 config/jmreader.yaml，保证面板不会「保存不了」。
 * 两条通道都会落盘，所以重启后不会丢。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 与 index.js 的 makeConfig('jmreader', ...) 保持一致 */
const CONFIG_KEY = 'jmreader'

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))

/**
 * 配置文件位置：正常情况下是云崽根目录的 config/jmreader.yaml。
 * 少数部署方式（systemd 没设 WorkingDirectory、从子目录启动）cwd 不在根目录，
 * 这里按「已存在的优先」在几个候选位置里挑，避免读到一份、写到另一份。
 */
function configPath () {
  const candidates = [
    path.join(process.cwd(), 'config', `${CONFIG_KEY}.yaml`),
    path.resolve(PLUGIN_DIR, '..', '..', 'config', `${CONFIG_KEY}.yaml`),
    path.resolve(PLUGIN_DIR, '..', 'config', `${CONFIG_KEY}.yaml`),
  ]
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) return file
    } catch {}
  }
  return candidates[0]
}

const DEFAULTS = {
  pdfPassword: '',
  pageSize: 10,
  imageQuality: 82,
  maxPages: 0,
  downloadConcurrency: 4,
  mergePageLimit: 350,
  usePageCache: true,
  proxy: '',
  proxyMode: 'all',
}

/** 数字字段：范围 + 默认值 + 小数位 */
const NUM_FIELDS = {
  pageSize: { min: 1, max: 20, def: 10, int: true },
  imageQuality: { min: 1, max: 100, def: 82, int: true },
  maxPages: { min: 0, max: 100000, def: 0, int: true },
  downloadConcurrency: { min: 1, max: 10, def: 4, int: true },
  mergePageLimit: { min: 1, max: 5000, def: 350, int: true },
}

const PROXY_MODES = ['all', 'api', 'image', 'off']

function toNum (raw, rule) {
  if (raw === '' || raw == null) return rule.def
  let n = Number(raw)
  if (!Number.isFinite(n)) return rule.def
  if (rule.int) n = Math.round(n)
  return Math.min(Math.max(n, rule.min), rule.max)
}

function toBool (raw, def) {
  if (raw === undefined || raw === null || raw === '') return def
  if (typeof raw === 'boolean') return raw
  const s = String(raw).toLowerCase()
  if (['false', '0', 'off', 'no'].includes(s)) return false
  if (['true', '1', 'on', 'yes'].includes(s)) return true
  return def
}

/** 任意来源（内存 / yaml / 默认值）→ 面板用的规整对象 */
function pick (src = {}) {
  const out = { pdfPassword: src.pdfPassword == null ? '' : String(src.pdfPassword) }
  for (const [key, rule] of Object.entries(NUM_FIELDS)) out[key] = toNum(src[key], rule)
  out.usePageCache = toBool(src.usePageCache, DEFAULTS.usePageCache)
  out.proxy = typeof src.proxy === 'string' ? src.proxy : ''
  const mode = String(src.proxyMode ?? '').toLowerCase()
  out.proxyMode = PROXY_MODES.includes(mode) ? mode : DEFAULTS.proxyMode
  return out
}

/** 面板提交的原始数据 → 只保留认识的字段，并做类型收敛 */
function normalize (data) {
  const out = {}
  if ('pdfPassword' in data) out.pdfPassword = String(data.pdfPassword ?? '')
  for (const [key, rule] of Object.entries(NUM_FIELDS)) {
    if (key in data) out[key] = toNum(data[key], rule)
  }
  if ('usePageCache' in data) out.usePageCache = toBool(data.usePageCache, DEFAULTS.usePageCache)
  if ('proxy' in data) out.proxy = typeof data.proxy === 'string' ? data.proxy.trim() : ''
  if ('proxyMode' in data) {
    const mode = String(data.proxyMode ?? '').toLowerCase()
    out.proxyMode = PROXY_MODES.includes(mode) ? mode : DEFAULTS.proxyMode
  }
  return out
}

// ---------------------------------------------------------------------------
// 极简 YAML 读写：只处理本插件这份「平铺标量」配置，保留注释与其它键
// ---------------------------------------------------------------------------

function unquote (v) {
  if (v === "''" || v === '""') return ''
  if (/^'[\s\S]*'$/.test(v)) return v.slice(1, -1).replace(/''/g, "'")
  if (/^"[\s\S]*"$/.test(v)) {
    try {
      return JSON.parse(v)
    } catch {
      return v.slice(1, -1)
    }
  }
  if (/^(~|null|Null|NULL)$/.test(v)) return ''
  return v
}

function readFileConfig () {
  let text
  try {
    text = fs.readFileSync(configPath(), 'utf8')
  } catch {
    return null
  }
  const out = {}
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line || /^\s/.test(line) || line.trimStart().startsWith('#')) continue
    const m = /^([A-Za-z_][\w.-]*)\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    const key = m[1]
    let value = m[2].trim()
    // 块标量（proxy 多行时写到 yaml 就是这个形式）
    if (['|', '|-', '>', '>-'].includes(value)) {
      const buf = []
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || lines[i + 1] === '')) {
        buf.push(lines[++i].replace(/^ {2}/, ''))
      }
      out[key] = buf.join('\n').trim()
      continue
    }
    if (!/^['"]/.test(value)) value = value.replace(/\s+#.*$/, '')
    out[key] = unquote(value)
  }
  return out
}

function scalar (value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  const s = String(value)
  if (/[\r\n]/.test(s)) return null // 交给块标量
  if (s === '') return "''"
  if (s !== s.trim() || s.startsWith('-')) return JSON.stringify(s)
  const plain = /^[A-Za-z0-9_./:@%+][A-Za-z0-9_./:@%+\- ]*$/.test(s)
  const looksBool = /^(true|false|null|yes|no|on|off|~)$/i.test(s)
  const looksNum = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)
  return plain && !looksBool && !looksNum ? s : JSON.stringify(s)
}

function upsert (text, key, value) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text ? text.split(/\r?\n/) : []
  while (lines.length && lines[lines.length - 1] === '') lines.pop()

  const s = scalar(value)
  const block = s === null
  const fresh = block
    ? [`${key}: |-`, ...String(value).split(/\r?\n/).map((l) => `  ${l}`)]
    : [`${key}: ${s}`]

  const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`)
  const start = lines.findIndex((l) => re.test(l))
  if (start < 0) return [...lines, ...fresh].join(eol) + eol

  let end = start + 1
  while (end < lines.length && /^\s+\S/.test(lines[end])) end++
  return [...lines.slice(0, start), ...fresh, ...lines.slice(end)].join(eol) + eol
}

function patchConfigFile (patch) {
  let text = ''
  try {
    text = fs.readFileSync(configPath(), 'utf8')
  } catch {
    // 还没有配置文件：从零建一份
  }
  for (const [key, value] of Object.entries(patch)) text = upsert(text, key, value)

  const file = configPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file) // 原子替换，避免写一半被读到
}

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

/** 数字输入项的公共 props */
const numProps = (min, max, def) => ({ min, max, precision: 0, step: 1, placeholder: `默认 ${def}` })

export function supportGuoba () {
  return {
    pluginInfo: {
      name: 'jmreader',
      title: 'JMReader',
      description: 'JM 漫画搜索 / 详情 / 下载加密 PDF',
      author: 'jmreader',
      link: '',
      isV3: true,
      isV2: false,
      showInMenu: 'auto',
      icon: 'mdi:book-open-page-variant',
      iconColor: '#e63946',
    },
    configInfo: {
      schemas: [
        {
          label: '基础配置',
          component: 'SOFT_GROUP_BEGIN',
        },
        {
          field: 'pdfPassword',
          label: 'PDF 通用密码',
          helpMessage: 'PDF 加密使用双密码：通用密码（userPassword）与作品ID（ownerPassword），二选一即可打开文档。',
          bottomHelpMessage: '留空则 PDF 仅可用「作品ID」打开。修改后新生成的 PDF 生效，旧缓存不受影响。',
          component: 'Input',
          defaultValue: DEFAULTS.pdfPassword,
          componentProps: {
            placeholder: '请输入通用密码，留空表示不设置',
          },
        },
        {
          field: 'pageSize',
          label: '每页显示条数',
          helpMessage: '搜索 / 列表结果每页显示的条数，翻页时按此粒度切分。',
          bottomHelpMessage: '范围 1 - 20，默认 10。',
          component: 'InputNumber',
          defaultValue: DEFAULTS.pageSize,
          componentProps: numProps(1, 20, 10),
        },
        {
          field: 'imageQuality',
          label: '图片压缩质量',
          helpMessage: 'PDF 内页图片的 JPEG 压缩质量（1-100）。',
          bottomHelpMessage: '数值越高越清晰、体积越大，默认 82。',
          component: 'InputNumber',
          defaultValue: DEFAULTS.imageQuality,
          componentProps: numProps(1, 100, 82),
        },
        {
          field: 'maxPages',
          label: 'PDF 最大页数限制',
          helpMessage: '生成 PDF 时允许的最大页数，超过则拒绝并提示改用单章下载。',
          bottomHelpMessage: '0 表示不限制。建议设一个合理值（如 100），避免整本漫画 PDF 过大、群文件上传失败。',
          component: 'InputNumber',
          defaultValue: DEFAULTS.maxPages,
          componentProps: { ...numProps(0, 100000, 0), placeholder: '默认 0（不限制）' },
        },
        {
          field: 'downloadConcurrency',
          label: '下载并发数',
          helpMessage: '生成 PDF 时同时下载的图片数，越大越快，但过高可能被服务器限速或封禁。',
          bottomHelpMessage: '范围 1 - 10，默认 4。网络不稳定时建议调低。',
          component: 'InputNumber',
          defaultValue: DEFAULTS.downloadConcurrency,
          componentProps: numProps(1, 10, 4),
        },
        {
          field: 'mergePageLimit',
          label: '合并 PDF 页数上限',
          helpMessage: '多个章节合并成一个 PDF 时，总页数超过这个值就拒绝合并，建议改成分章发送。',
          bottomHelpMessage: '范围 1 - 5000，默认 350。生成 PDF 时内存随页数上升，机器够用可以往上调，自己试到不崩为止。',
          component: 'InputNumber',
          defaultValue: DEFAULTS.mergePageLimit,
          componentProps: { ...numProps(1, 5000, 350), step: 10 },
        },
        {
          field: 'usePageCache',
          label: '复用网页阅读缓存',
          helpMessage: '网页端「在线阅读」看过的页会存在本地，群里再下载同一本时直接读取，不重复消耗流量。',
          bottomHelpMessage: '默认开启。两边共用 data/pages 目录；插件只读，不会改动或删除网页的缓存。',
          component: 'Switch',
          defaultValue: DEFAULTS.usePageCache,
        },
        {
          label: '网络代理',
          component: 'SOFT_GROUP_BEGIN',
        },
        {
          field: 'proxy',
          label: '代理地址',
          helpMessage: '支持 http:// https:// socks5:// 三种协议，可填多个（逗号或换行分隔），请求失败时自动轮换到下一个。',
          bottomHelpMessage: '例：http://127.0.0.1:7890 或 socks5://user:pass@127.0.0.1:1080。留空表示直连。',
          component: 'InputTextArea',
          defaultValue: DEFAULTS.proxy,
          componentProps: {
            placeholder: 'http://127.0.0.1:7890',
            rows: 2,
          },
        },
        {
          field: 'proxyMode',
          label: '代理生效范围',
          helpMessage: 'all = 接口与图片都走代理；api = 只有接口请求走代理；image = 只有图片下载走代理。',
          bottomHelpMessage: '接口与图片 CDN 的可达性常常不同，可按需分开设置。',
          component: 'Select',
          defaultValue: DEFAULTS.proxyMode,
          componentProps: {
            options: [
              { label: '全部流量 (all)', value: 'all' },
              { label: '仅接口 (api)', value: 'api' },
              { label: '仅图片 (image)', value: 'image' },
              { label: '关闭 (off)', value: 'off' },
            ],
          },
        },
      ],

      getConfigData () {
        // 插件在跑：以内存里的配置为准（面板改完立刻能看到新值）
        const live = globalThis.__jmreaderConfig
        if (live && typeof live === 'object') return pick(live)
        // 插件没加载：直接读 yaml，别让面板显示一堆默认值
        const file = readFileConfig()
        if (file) return pick({ ...DEFAULTS, ...file })
        return { ...DEFAULTS }
      },

      setConfigData (data, { Result }) {
        if (!data || typeof data !== 'object') return Result.error('没有收到配置数据')
        const patch = normalize(data)
        if (!Object.keys(patch).length) return Result.error('没有可保存的配置项')

        let live = false
        const hook = globalThis.__jmreaderSetConfig
        if (typeof hook === 'function') {
          try {
            hook(patch)
            live = true
          } catch {
            // 钩子出错就退到直接写文件，不让面板报「保存失败」
            live = false
          }
        }

        // 无论钩子是否可用都落盘一次：钩子只改内存时，重启后仍要靠这份文件
        try {
          patchConfigFile(patch)
        } catch (e) {
          if (!live) return Result.error(`写入 config/${CONFIG_KEY}.yaml 失败：${e.message}`)
        }

        // 走文件通道时回读一遍，避免「提示成功、实际没写进去」
        if (!live) {
          const back = readFileConfig()
          if (back) {
            const bad = Object.keys(patch).filter((k) => String(pick(back)[k]) !== String(patch[k]))
            if (bad.length) {
              return Result.error(`已写入但回读不一致：${bad.join('、')}，请检查 config/${CONFIG_KEY}.yaml 的权限`)
            }
          }
          return Result.ok({}, '已保存（插件未运行，重启后生效）')
        }
        return Result.ok({}, '保存成功~')
      },
    },
  }
}
