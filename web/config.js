/**
 * Web 版配置：保存到 data/web-config.json
 *
 * 与 QQ 插件配置文件独立，避免两套运行方式互相干扰。
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const WEB_DIR = __dirname
export const ROOT_DIR = path.join(__dirname, '..')
export const DATA_DIR = path.join(ROOT_DIR, 'data')
export const CONFIG_FILE = path.join(DATA_DIR, 'web-config.json')

export const DEFAULTS = {
  proxy: '',
  proxyMode: 'all',      // all | api | image | off
  concurrency: 4,
  quality: 82,
  maxPages: 0,           // 0 = 不限制
  pageSize: 24,          // 搜索每页条数
  encrypt: 'none',       // none | id | custom（前端默认选中项）
  password: '',          // encrypt=custom 时的默认密码
}

export const config = { ...DEFAULTS }

const NUM_RANGES = {
  concurrency: [1, 10],
  quality: [1, 100],
  maxPages: [0, 100000],
  pageSize: [6, 60],
}

/** 读取配置（不存在则用默认值）。 */
export async function loadConfig() {
  await fsp.mkdir(DATA_DIR, { recursive: true })
  try {
    const raw = await fsp.readFile(CONFIG_FILE, 'utf8')
    const saved = JSON.parse(raw)
    Object.assign(config, normalize(saved, { partial: true }))
  } catch {
    // 首次运行 / 文件损坏：保持默认值并落盘
    await saveConfig({})
  }
  return config
}

/** 合并并校验字段。 */
export function normalize(input = {}, { partial = true } = {}) {
  const out = {}
  const base = partial ? config : DEFAULTS

  if ('proxy' in input || !partial) {
    out.proxy = typeof input.proxy === 'string' ? input.proxy.trim() : (base.proxy || '')
  }
  if ('proxyMode' in input || !partial) {
    const m = String(input.proxyMode || '').toLowerCase()
    out.proxyMode = ['all', 'api', 'image', 'off'].includes(m) ? m : (base.proxyMode || 'all')
  }
  if ('encrypt' in input || !partial) {
    const e = String(input.encrypt || '').toLowerCase()
    out.encrypt = ['none', 'id', 'custom'].includes(e) ? e : (base.encrypt || 'none')
  }
  if ('password' in input || !partial) {
    const p = typeof input.password === 'string' ? input.password.trim() : ''
    out.password = p.slice(0, 32)
  }
  for (const [key, [min, max]] of Object.entries(NUM_RANGES)) {
    if (key in input || !partial) {
      const n = parseInt(input[key], 10)
      out[key] = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : (base[key] ?? DEFAULTS[key])
    }
  }
  return out
}

/** 保存配置（可只传部分字段）。 */
export async function saveConfig(patch = {}) {
  Object.assign(config, normalize(patch))
  await fsp.mkdir(DATA_DIR, { recursive: true })
  await fsp.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8')
  return config
}

/** 对外展示的配置（代理密码打码）。 */
export function publicConfig() {
  return {
    ...config,
    proxyMasked: maskProxyText(config.proxy),
  }
}

/** 把代理串里的密码替换成 ***，用于前端回显。 */
export function maskProxyText(text) {
  if (!text) return ''
  return String(text)
    .split(/[\s,;|]+/)
    .filter(Boolean)
    .map((piece) => {
      let s = piece
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`
      try {
        const u = new URL(s)
        if (!u.password) return piece
        return `${u.protocol}//${u.username}:***@${u.host}`
      } catch {
        return piece
      }
    })
    .join(', ')
}

/** 启动参数：命令行 > 环境变量 > 配置文件。 */
export function resolveServerOptions(argv = process.argv.slice(2)) {
  const arg = (name) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const flag = (name) => argv.includes(`--${name}`)

  // --host lan / --host localhost 这类简写，省得记 IP
  const hostAlias = {
    lan: '0.0.0.0',
    all: '0.0.0.0',
    any: '0.0.0.0',
    local: '127.0.0.1',
    localhost: '127.0.0.1',
  }
  const rawHost = arg('host') || process.env.JM_HOST || '127.0.0.1'

  return {
    port: Number(arg('port') || process.env.JM_PORT || process.env.PORT || 7788),
    host: hostAlias[String(rawHost).toLowerCase()] || rawHost,
    token: arg('token') || process.env.JM_TOKEN || '',
    // 只有明确声明反代时才信任 X-Forwarded-For：否则客户端可伪造 IP 绕过口令限流
    trustProxy: flag('trust-proxy') || process.env.JM_TRUST_PROXY === '1',
  }
}

export default { config, loadConfig, saveConfig, publicConfig, resolveServerOptions }
