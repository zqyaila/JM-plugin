/**
 * JMComic / 禁漫天堂 API 核心客户端（Node.js 版）
 *
 * 完整复刻自 JM Reader（Kotlin + Jetpack Compose）的协议实现，仅使用 Node.js 内置模块
 * （crypto / https），不依赖任何第三方库。
 *
 * 协议要点（与 Kotlin 端 `data/net/` 一一对应）：
 *  1. 主机发现：从 CDN 拉取加密的服务器列表（AES 解密，key = md5("diosfjckwpqpdfjkvnqQjsik")），
 *     逐个用 `GET /setting` 探测，取第一个返回 code:200 的主机，失败则回退内置主机。
 *  2. 请求签名：每个请求携带 `Tokenparam` = "<unixSecs>,<appVersion>" 与
 *     `Token` = md5("<unixSecs>185Hcomic3PAPP7R")。
 *  3. 响应加密：`{ "code":200, "data":"<base64 AES-256-ECB>" }`，解密 key = md5("<本次时间戳><secret>")。
 *  4. 图片打乱：部分页以「水平条带倒序」分发，需按 md5(aid+pageName) 计算切片数还原。
 *
 * 免责声明：本模块为个人学习与技术研究用途，与 18comic / JMComic / 禁漫天堂无任何关联。
 */

import crypto from 'node:crypto'
import https from 'node:https'
import http from 'node:http'

// ---------------------------------------------------------------------------
// 常量（与 Kotlin 端 ApiClient.companion / Crypto 一致）
// ---------------------------------------------------------------------------

export const APP_VERSION = '2.1.7'          // 参考客户端 GlobalConfig.HeaderVer
export const CLIENT_VERSION = 'v1.3.6'      // config.UpdateVersion
export const TOKEN_SECRET = '185Hcomic3PAPP7R'   // APP_TOKEN_SECRET
export const DATA_SECRET = '185Hcomic3PAPP7R'    // APP_DATA_SECRET
export const CONTENT_TOKEN_SECRET = '18comicAPPContent' // APP_TOKEN_SECRET_2
export const HOST_SECRET = 'diosfjckwpqpdfjkvnqQjsik'   // 主机引导文件解密密钥

// 使用第二个 secret + 明文 md5(secret) 作响应 key 的路径
const CONTENT_PATHS = ['chapter_view_template']

// 主机引导 CDN
const HOST_URLS = [
  'https://rup4a04-c02.tos-cn-hongkong.bytepluses.com/newsvr-2025.txt',
  'https://rup4a04-c01.tos-ap-southeast-1.bytepluses.com/newsvr-2025.txt',
]

// 兜底主机（与 Kotlin 端一致）
const KNOWN_API_HOSTS = [
  'www.cdnhjk.net',
  'www.cdngwc.cc',
  'www.cdngwc.net',
  'www.cdngwc.club',
]

// 图片 CDN 兜底
const DEFAULT_IMG_HOST = 'https://cdn-msp3.jmdanjonproxy.vip'

// ---------------------------------------------------------------------------
// 加密工具
// ---------------------------------------------------------------------------

export function md5Hex(input) {
  return crypto.createHash('md5').update(input, 'utf8').digest('hex')
}

/**
 * Base64 解码，容忍 UTF-8 BOM、空白与非法字符（对应 Kotlin 端 Crypto.base64Decode）。
 */
export function base64Decode(text) {
  if (typeof text !== 'string') return null
  let cleaned = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (i === 0 && ch === '\uFEFF') continue          // BOM
    if (ch === '\n' || ch === '\r' || ch === '\t' || ch === ' ') continue
    if (/[A-Za-z0-9+/=]/.test(ch)) cleaned += ch
  }
  if (!cleaned) return null
  try {
    return Buffer.from(cleaned, 'base64')
  } catch {
    return null
  }
}

/**
 * AES-256-ECB 解密（PKCS7 由 node 的 aes-256-ecb 自动处理）。
 * @param {string} base64Ciphertext base64 密文
 * @param {string} keyMd5Hex md5 十六进制串，其 ASCII 字节即 32 字节密钥
 */
export function aesEcbDecrypt(base64Ciphertext, keyMd5Hex) {
  const bytes = base64Decode(base64Ciphertext)
  if (!bytes) return null
  try {
    const key = Buffer.from(keyMd5Hex, 'utf8') // 32 bytes -> AES-256
    const decipher = crypto.createDecipheriv('aes-256-ecb', key, null)
    decipher.setAutoPadding(true)
    const out = Buffer.concat([decipher.update(bytes), decipher.final()])
    return out.toString('utf8')
  } catch {
    return null
  }
}

/** 解密主机引导文件：key = md5(HOST_SECRET)。 */
export function decryptHostText(encryptedText) {
  return aesEcbDecrypt(encryptedText, md5Hex(HOST_SECRET))
}

// ---------------------------------------------------------------------------
// 图片打乱还原（对应 Kotlin 端 util/ImageDescrambler.kt）
// ---------------------------------------------------------------------------

/**
 * 切片数：key = md5("<aid><pageName>").lastChar.charCodeAt(0)
 *   aid ∈ [268850, 421925] -> %10；aid >= 421926 -> %8；否则不变（->10）
 */
export function sliceCount(aid, pageName) {
  const keyHex = md5Hex(`${aid}${pageName}`)
  let key = keyHex.charCodeAt(keyHex.length - 1)
  if (aid >= 268850 && aid <= 421925) key %= 10
  else if (aid >= 421926) key %= 8
  switch (key) {
    case 0: return 2
    case 1: return 4
    case 2: return 6
    case 3: return 8
    case 4: return 10
    case 5: return 12
    case 6: return 14
    case 7: return 16
    case 8: return 18
    case 9: return 20
    default: return 10
  }
}

/** GIF 与 aid < scrambleId 的页从不打乱。 */
export function needsDescramble(aid, scrambleId, imageUrl) {
  if (typeof imageUrl === 'string' && imageUrl.includes('.gif')) return false
  return aid >= scrambleId
}

/**
 * 将一张图片（PNG/JPEG 字节流）按 num 条水平切片倒序还原，返回还原后的字节流。
 *
 * 纯 JS 无图片解码库的情况下，这里不直接操作像素；调用方若需要真正还原，需传入
 * 支持解码图片的 hook。默认实现返回原图字节（不还原），由上层决定是否用 sharp/jimp。
 */
export function descrambleImage(bytes, aid, pageName, scrambleId, imageUrl) {
  return bytes // 占位：真正像素级还原需图片解码库，见 README「图片还原」说明
}

// ---------------------------------------------------------------------------
// 轻量 HTTP 客户端（仅用内置模块）
// ---------------------------------------------------------------------------

function httpRequest(url, { method = 'GET', headers = {}, body = null, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const isHttps = u.protocol === 'https:'
    const lib = isHttps ? https : http
    const req = lib.request(
      u,
      {
        method,
        headers,
        timeout,
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const buf = Buffer.concat(chunks)
          resolve({ status: res.statusCode, headers: res.headers, body: buf })
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

/** GET 请求，返回 { status, text, buf }。 */
async function getText(url, headers = {}, timeout = 15000) {
  const res = await httpRequest(url, { method: 'GET', headers, timeout })
  return { status: res.status, text: res.body.toString('utf8'), buf: res.body }
}

// ---------------------------------------------------------------------------
// ApiClient（对应 Kotlin 端 data/net/ApiClient.kt）
// ---------------------------------------------------------------------------

export class JmClient {
  constructor() {
    this.apiUrl = null      // 已探测成功的 API 主机，如 https://www.cdnhjk.net/
    this.imgHost = DEFAULT_IMG_HOST
    this.appVersion = APP_VERSION
    this.lang = 'TW'        // 服务端语言参数（TW / CN）
    this.jwtToken = null    // Authorization: Bearer
    this.avsSession = null  // Cookie: AVS=
    this.member = null      // 登录后保存的会员信息对象
  }

  /** 标准化主机名：去协议、去尾斜杠、需含点号。 */
  static normalizeHost(value) {
    if (!value) return null
    let host = String(value).trim()
    host = host.replace(/^https?:\/\//, '').replace(/\/+$/, '')
    return host && host.includes('.') ? host : null
  }

  // --- 主机发现 ---

  async fetchConfig() {
    for (const u of HOST_URLS) {
      let text = null
      try {
        text = (await getText(u)).text
      } catch {
        continue
      }
      if (!text) continue
      const plain = decryptHostText(text)
      if (!plain) continue
      let json
      try {
        json = JSON.parse(plain)
      } catch {
        continue
      }
      if (json.Server || json.Setting) return json
    }
    return null
  }

  candidateHosts(config) {
    const out = []
    const seen = new Set()
    const add = (v) => {
      const h = JmClient.normalizeHost(v)
      if (h && !seen.has(h)) {
        seen.add(h)
        out.push(h)
      }
    }
    for (const key of ['Setting', 'Server']) {
      const arr = config[key]
      if (Array.isArray(arr)) arr.forEach((v) => add(typeof v === 'string' ? v : v))
    }
    const jm3 = config.jm3_Server
    if (Array.isArray(jm3)) {
      jm3.forEach((pair) => {
        if (Array.isArray(pair)) add(pair[0])
        else if (pair && typeof pair === 'object') add(pair[0] || pair.host)
      })
    }
    return out
  }

  /** 用 GET /setting 探测某主机是否真正可用（code:200）。 */
  async probe(host) {
    const time = Math.floor(Date.now() / 1000)
    const url = `https://${host}/setting?app_img_shunt=1&lang=${this.lang}&t=${time}`
    const headers = {
      Tokenparam: `${time},${this.appVersion}`,
      Token: md5Hex(`${time}${TOKEN_SECRET}`),
      version: CLIENT_VERSION,
    }
    try {
      const { text } = await getText(url, headers, 8000)
      let code = -1
      try {
        code = JSON.parse(text).code ?? -1
      } catch {
        return false
      }
      return code === 200
    } catch {
      return false
    }
  }

  /**
   * 引导：探测并缓存一个可用的 API 主机。
   * @returns {Promise<string>} 形如 https://www.cdnhjk.net/
   */
  async bootstrap() {
    const candidates = []
    const seen = new Set()
    const add = (h) => {
      if (h && !seen.has(h)) {
        seen.add(h)
        candidates.push(h)
      }
    }

    // 优先上次成功的主机
    if (this.apiUrl) add(JmClient.normalizeHost(this.apiUrl))

    // CDN 配置里的主机
    let config = null
    try {
      config = await this.fetchConfig()
    } catch {
      config = null
    }
    if (config) this.candidateHosts(config).forEach(add)

    // 兜底主机
    KNOWN_API_HOSTS.forEach(add)

    if (candidates.length === 0) throw new Error('无法取得 API 主机')

    // 快速路径：先试第一个，失败再并发探测其余
    const first = candidates[0]
    let winner = (await this.probe(first)) ? first : null
    if (!winner && candidates.length > 1) {
      const results = await Promise.all(candidates.slice(1).map(async (h) => ((await this.probe(h)) ? h : null)))
      winner = results.find((h) => h) || null
    }

    if (winner) {
      this.apiUrl = `https://${winner}/`
      return this.apiUrl
    }
    if (this.apiUrl) return this.apiUrl
    throw new Error('无法取得 API 主机')
  }

  // --- 请求 ---

  enc(s) {
    return encodeURIComponent(s)
  }

  /**
   * 发送请求并解密响应，返回 { code, obj, arr, serverMessage } 或抛错。
   * @param {string} method GET / POST
   * @param {string} path 如 "latest"
   * @param {object} params 查询/表单参数
   */
  async request(method, path, params = {}) {
    if (!this.apiUrl) await this.bootstrap()
    const time = Math.floor(Date.now() / 1000)
    const base = this.apiUrl.replace(/\/+$/, '')
    const cleanPath = path.replace(/^\/+/, '')

    let url
    const isGet = method === 'GET'
    if (isGet) {
      const pairs = Object.entries(params)
        .filter(([, v]) => v != null && v !== '' && v !== undefined)
        .map(([k, v]) => `${this.enc(k)}=${this.enc(String(v))}`)
      pairs.push(`lang=${this.enc(this.lang)}`)
      url = `${base}/${cleanPath}?${pairs.join('&')}`
    } else {
      url = `${base}/${cleanPath}`
    }

    const isContent = CONTENT_PATHS.some((p) => url.includes(p))
    const secret = isContent ? CONTENT_TOKEN_SECRET : TOKEN_SECRET
    const tokenParam = `${time},${this.appVersion}`
    const token = md5Hex(`${time}${secret}`)

    const headers = {
      Tokenparam: tokenParam,
      Token: token,
      version: CLIENT_VERSION,
      'User-Agent': 'Mozilla/5.0',
      Accept: '*/*',
    }
    if (this.jwtToken) headers.Authorization = `Bearer ${this.jwtToken}`
    if (this.avsSession) headers.Cookie = `AVS=${this.avsSession}`

    let body = null
    if (!isGet) {
      const pairs = Object.entries(params)
        .filter(([, v]) => v != null && v !== undefined)
        .map(([k, v]) => `${this.enc(k)}=${this.enc(String(v))}`)
      if (!Object.keys(params).some((k) => k.toLowerCase() === 'lang')) {
        pairs.push(`lang=${this.enc(this.lang)}`)
      }
      body = pairs.join('&')
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
    }

    // 重试 3 次（对应 Kotlin 端重试逻辑）
    let lastErr = null
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await httpRequest(url, { method, headers, body, timeout: 20000 })
        const text = res.body.toString('utf8')
        return this.parseResponse(text, url, time, res.status)
      } catch (e) {
        lastErr = e
        if (attempt < 3) await new Promise((r) => setTimeout(r, 600 * attempt))
      }
    }
    throw new Error(lastErr?.message || '请求失败')
  }

  parseResponse(bodyText, url, time, httpStatus) {
    let envelope
    try {
      envelope = JSON.parse(bodyText)
    } catch {
      if (httpStatus >= 400) {
        const e = new Error(`HTTP ${httpStatus}`)
        e.code = httpStatus
        e.httpStatus = httpStatus
        throw e
      }
      throw new Error(bodyText.trim() ? '响应格式错误' : '服务器没有响应')
    }

    const code = envelope.code ?? -1
    const serverMessage = readServerMessage(envelope)
    const dataRaw = envelope.data

    if (code !== 200) {
      const e = new Error(serverMessage || `API 错误 (${code})`)
      e.code = code
      e.httpStatus = httpStatus
      e.serverMessage = serverMessage
      throw e
    }

    // data 不是字符串 => 未加密（空数组 / 明文 JSON 对象）
    if (typeof dataRaw !== 'string') {
      return {
        code,
        obj: dataRaw && typeof dataRaw === 'object' && !Array.isArray(dataRaw) ? dataRaw : null,
        arr: Array.isArray(dataRaw) ? dataRaw : null,
        serverMessage,
      }
    }

    const isContent = CONTENT_PATHS.some((p) => url.includes(p))
    const secrets = isContent ? [CONTENT_TOKEN_SECRET] : [DATA_SECRET, CONTENT_TOKEN_SECRET]
    for (const s of secrets) {
      const keyHex = isContent ? md5Hex(s) : md5Hex(`${time}${s}`)
      const plain = aesEcbDecrypt(dataRaw, keyHex)
      if (plain == null) continue
      try {
        const value = JSON.parse(plain)
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          return { code, obj: value, arr: null, serverMessage }
        }
        if (Array.isArray(value)) {
          return { code, obj: null, arr: value, serverMessage }
        }
      } catch {
        // 解密成功但非 JSON，继续尝试下一个 secret
        continue
      }
    }
    const e = new Error(serverMessage || `API 错误 (${code})`)
    e.code = code
    e.httpStatus = httpStatus
    throw e
  }

  // --- 便捷封装（返回解密后的 obj / arr） ---

  async get(path, params = {}) {
    const r = await this.request('GET', path, params)
    return r.obj ?? r.arr ?? {}
  }

  async post(path, params = {}) {
    const r = await this.request('POST', path, params)
    return r.obj ?? r.arr ?? {}
  }

  // --- 会话设置（对应 SessionManager） ---

  saveAuth(jwtToken, memberData) {
    this.jwtToken = jwtToken
    this.member = memberData
    if (memberData && memberData.s) this.avsSession = memberData.s
  }

  clearAuth() {
    this.jwtToken = null
    this.avsSession = null
    this.member = null
  }

  get isLoggedIn() {
    return !!(this.jwtToken || this.avsSession)
  }

  // --- 图片 URL 助手（对应 AppRepository） ---

  /** 列表/网格封面图。 */
  comicCover(id, updateAt) {
    const host = this.imgHost || DEFAULT_IMG_HOST
    return `${host}/media/albums/${id}_3x4.jpg?v=${updateAt || 0}`
  }

  /** 相对 media 路径补全图片主机。 */
  imgUrl(path) {
    if (typeof path === 'string' && path.startsWith('http')) return path
    const host = this.imgHost || DEFAULT_IMG_HOST
    return `${host}/${String(path).replace(/^\/+/, '')}`
  }
}

/** 从信封读取 errorMsg / message / msg（可能是数组）。 */
function readServerMessage(envelope) {
  for (const key of ['errorMsg', 'message', 'msg']) {
    if (!(key in envelope) || envelope[key] == null) continue
    const raw = envelope[key]
    let text
    if (Array.isArray(raw)) text = raw.filter((x) => x != null).join('\n')
    else text = String(raw)
    text = text.trim()
    if (text) return text
  }
  return null
}

export default JmClient
