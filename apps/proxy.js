/**
 * 代理支持模块（零第三方依赖）
 *
 * 支持两种代理协议：
 *   - http://  / https://    —— 通过 HTTP CONNECT 建隧道（https 代理则先对代理本身做 TLS）
 *   - socks5:// / socks5h:// —— SOCKS5 握手（支持用户名/密码认证）
 *
 * 也支持无协议写法 `host:port`（默认按 http 代理处理），以及多代理列表轮换。
 *
 * 对外只暴露两样东西：
 *   parseProxyList(text)  -> 代理对象数组
 *   proxyRequest(url, opts) -> Promise<{ status, headers, body: Buffer }>
 *
 * 说明：不修改全局 fetch / 环境变量，只影响显式传入 proxy 的请求，
 * 因此插件其余逻辑与机器上的其它服务不会被打扰。
 */

import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'

const PROXY_DEFAULT_PORT = { http: 8080, https: 443, socks5: 1080, socks5h: 1080 }
const SOCK5_REPLY_TEXT = {
  1: '代理服务器内部错误',
  2: '代理规则不允许该连接',
  3: '网络不可达',
  4: '目标主机不可达',
  5: '目标拒绝连接',
  6: 'TTL 过期',
  7: '不支持的指令',
  8: '不支持的地址类型',
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

/**
 * 解析单个代理字符串。
 * @param {string} raw 形如 `http://user:pass@127.0.0.1:7890`、`socks5://127.0.0.1:1080`
 * @returns {{url:string,protocol:string,host:string,port:number,auth:{username:string,password:string}|null}|null}
 */
export function parseProxy(raw) {
  if (!raw) return null
  let s = String(raw).trim()
  if (!s) return null
  // 无协议前缀时按 http 代理处理：127.0.0.1:7890
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`

  let u
  try {
    u = new URL(s)
  } catch {
    return null
  }

  let protocol = u.protocol.replace(/:$/, '').toLowerCase()
  if (protocol === 'socks') protocol = 'socks5'
  if (!(protocol in PROXY_DEFAULT_PORT)) return null

  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (!host) return null
  const port = Number(u.port) || PROXY_DEFAULT_PORT[protocol]
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null

  let auth = null
  if (u.username || u.password) {
    auth = {
      username: decodeURIComponent(u.username || ''),
      password: decodeURIComponent(u.password || ''),
    }
  }

  return { url: s, protocol, host, port, auth }
}

/**
 * 解析多代理配置：支持用逗号、分号、空白、换行分隔。
 * @param {string|string[]} input
 * @returns {Array<ReturnType<typeof parseProxy>>}
 */
export function parseProxyList(input) {
  if (!input) return []
  const raw = Array.isArray(input) ? input.join(',') : String(input)
  const out = []
  const seen = new Set()
  for (const piece of raw.split(/[\s,;|]+/)) {
    const p = parseProxy(piece)
    if (!p) continue
    const key = `${p.protocol}://${p.host}:${p.port}|${p.auth ? p.auth.username : ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(p)
  }
  return out
}

/** 打码显示代理地址，避免日志/界面泄露密码。 */
export function maskProxy(p) {
  if (!p) return ''
  const auth = p.auth ? `${p.auth.username}:***@` : ''
  return `${p.protocol}://${auth}${p.host}:${p.port}`
}

// ---------------------------------------------------------------------------
// 底层 socket 工具
// ---------------------------------------------------------------------------

function connectTcp(host, port, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port })
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      sock.destroy()
      reject(new Error(`连接代理超时（${host}:${port}）`))
    }, timeout)

    const onError = (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    }

    sock.once('connect', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock.removeListener('error', onError)
      sock.on('error', () => {}) // 后续错误由使用方处理，避免未捕获导致进程退出
      resolve(sock)
    })
    sock.once('error', onError)
  })
}

function tlsConnect(sock, servername, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const t = tls.connect({
      socket: sock,
      servername: net.isIP(servername) ? undefined : servername,
      rejectUnauthorized: true,
    })
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      t.destroy()
      reject(new Error('TLS 握手超时'))
    }, timeout)
    t.once('secureConnect', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(t)
    })
    t.once('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
  })
}

/** 从已连接的流里精确读取 n 个字节。 */
function makeReader(stream, timeout = 15000) {
  let buf = Buffer.alloc(0)
  let waiter = null
  let closed = false

  const flush = () => {
    if (!waiter) return
    if (closed) {
      const w = waiter
      waiter = null
      w.reject(new Error('代理连接已关闭'))
      return
    }
    if (buf.length < waiter.n) return
    const w = waiter
    waiter = null
    const out = buf.subarray(0, w.n)
    buf = buf.subarray(w.n)
    clearTimeout(w.timer)
    w.resolve(out)
  }

  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk])
    flush()
  }
  const onClose = () => {
    closed = true
    flush()
  }
  stream.on('data', onData)
  stream.on('close', onClose)
  stream.pause()

  return {
    read(n) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (waiter && waiter.n === n) waiter = null
          reject(new Error('代理响应超时'))
        }, timeout)
        waiter = { n, resolve, reject, timer }
        stream.resume()
        flush()
      })
    },
    /**
     * 清空监听并返回残余字节。
     * 残余数据通过 unshift 放回流中，调用方随后可安全把 socket 交给 http 模块；
     * 不做 pause()，避免上层注册 data 监听前流处于暂停态导致请求挂起。
     */
    release() {
      stream.removeListener('data', onData)
      stream.removeListener('close', onClose)
      const rest = buf
      buf = Buffer.alloc(0)
      if (rest.length) stream.unshift(rest)
      return rest
    },
  }
}

// ---------------------------------------------------------------------------
// 隧道建立
// ---------------------------------------------------------------------------

/** HTTP / HTTPS 代理：发 CONNECT 请求建立隧道。 */
async function httpProxyTunnel(proxy, host, port, timeout) {
  let sock = await connectTcp(proxy.host, proxy.port, timeout)
  if (proxy.protocol === 'https') sock = await tlsConnect(sock, proxy.host, timeout)

  const lines = [
    `CONNECT ${host}:${port} HTTP/1.1`,
    `Host: ${host}:${port}`,
    'User-Agent: Mozilla/5.0',
    'Proxy-Connection: keep-alive',
  ]
  if (proxy.auth) {
    const token = Buffer.from(`${proxy.auth.username}:${proxy.auth.password}`).toString('base64')
    lines.push(`Proxy-Authorization: Basic ${token}`)
  }
  sock.write(`${lines.join('\r\n')}\r\n\r\n`)

  const reader = makeReader(sock, timeout)
  let head = ''
  // 逐块读取直到出现空行（响应头一般一次就读完）
  for (;;) {
    const chunk = await reader.read(1)
    head += chunk.toString('latin1')
    if (head.length >= 4 && head.endsWith('\r\n\r\n')) break
    if (head.length > 16384) throw new Error('代理响应头过大')
  }
  reader.release()

  const statusLine = head.split('\r\n')[0] || ''
  const code = Number(statusLine.split(' ')[1])
  if (code === 407) throw new Error('代理要求认证（407），请检查用户名/密码')
  if (!(code >= 200 && code < 300)) {
    throw new Error(`代理拒绝建立隧道（${code || '未知'}）${statusLine.slice(0, 80)}`)
  }
  return sock
}

/** SOCKS5 代理：握手 + 可选认证 + CONNECT。 */
async function socks5ProxyTunnel(proxy, host, port, timeout) {
  const sock = await connectTcp(proxy.host, proxy.port, timeout)
  const reader = makeReader(sock, timeout)

  // 1. 方法协商
  const methods = proxy.auth ? [0x00, 0x02] : [0x00]
  sock.write(Buffer.from([0x05, methods.length, ...methods]))
  const [, method] = await reader.read(2)
  if (method === 0xff) throw new Error('SOCKS5 代理不接受任何认证方式')

  // 2. 用户名/密码认证（RFC 1929）
  if (method === 0x02) {
    if (!proxy.auth) throw new Error('SOCKS5 代理要求认证，但未配置用户名/密码')
    const u = Buffer.from(proxy.auth.username)
    const p = Buffer.from(proxy.auth.password)
    sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]))
    const [, status] = await reader.read(2)
    if (status !== 0x00) throw new Error('SOCKS5 代理认证失败（用户名或密码错误）')
  }

  // 3. CONNECT 目标
  const hostBuf = Buffer.from(host, 'utf8')
  const portBuf = Buffer.alloc(2)
  portBuf.writeUInt16BE(port, 0)
  sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]), hostBuf, portBuf]))

  const reply = await reader.read(4)
  if (reply[1] !== 0x00) {
    throw new Error(`SOCKS5 连接失败：${SOCK5_REPLY_TEXT[reply[1]] || `错误码 ${reply[1]}`}`)
  }
  // 4. 丢弃 BIND 地址
  let addrLen = 0
  if (reply[3] === 0x01) addrLen = 4
  else if (reply[3] === 0x04) addrLen = 16
  else if (reply[3] === 0x03) addrLen = (await reader.read(1))[0]
  await reader.read(addrLen + 2)

  reader.release()
  return sock
}

/** 建立到 target 的 socket（走代理或直连）。 */
async function openSocket(host, port, proxy, timeout) {
  if (!proxy) {
    return connectTcp(host, port, timeout)
  }
  if (proxy.protocol === 'socks5' || proxy.protocol === 'socks5h') {
    return socks5ProxyTunnel(proxy, host, port, timeout)
  }
  return httpProxyTunnel(proxy, host, port, timeout)
}

// ---------------------------------------------------------------------------
// Agent：把隧道交给 http/https 模块
// ---------------------------------------------------------------------------

class HttpOverProxyAgent extends http.Agent {
  constructor(proxy, timeout) {
    super({ keepAlive: false })
    this.proxyConf = proxy
    this.connectTimeout = timeout
  }

  createConnection(options, cb) {
    openSocket(options.host, Number(options.port) || 80, this.proxyConf, this.connectTimeout)
      .then((sock) => cb(null, sock))
      .catch((err) => cb(err))
  }

  getName() {
    return `jm-proxy:${this.proxyConf.protocol}:${this.proxyConf.host}:${this.proxyConf.port}`
  }
}

class HttpsOverProxyAgent extends https.Agent {
  constructor(proxy, timeout) {
    super({ keepAlive: false })
    this.proxyConf = proxy
    this.connectTimeout = timeout
  }

  createConnection(options, cb) {
    const host = options.host
    const port = Number(options.port) || 443
    openSocket(host, port, this.proxyConf, this.connectTimeout)
      .then((sock) => tlsConnect(sock, options.servername || host, this.connectTimeout))
      .then((tlsSock) => cb(null, tlsSock))
      .catch((err) => cb(err))
  }

  getName() {
    return `jm-proxy-tls:${this.proxyConf.protocol}:${this.proxyConf.host}:${this.proxyConf.port}`
  }
}

// ---------------------------------------------------------------------------
// 对外请求接口
// ---------------------------------------------------------------------------

function rawRequest(url, { method = 'GET', headers = {}, body = null, timeout = 20000, proxy = null } = {}) {
  return new Promise((resolve, reject) => {
    let u
    try {
      u = new URL(url)
    } catch {
      reject(new Error(`URL 无效：${url}`))
      return
    }
    const isHttps = u.protocol === 'https:'
    const lib = isHttps ? https : http
    const agent = proxy
      ? (isHttps ? new HttpsOverProxyAgent(proxy, timeout) : new HttpOverProxyAgent(proxy, timeout))
      : undefined

    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method,
        headers,
        agent,
        timeout,
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
        })
        res.on('error', reject)
      },
    )

    req.on('timeout', () => req.destroy(new Error(`请求超时（${timeout}ms）`)))
    req.on('error', (err) => {
      // 给代理错误补一点上下文，方便定位
      if (proxy && /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET|ETIMEDOUT/i.test(err.message || '')) {
        const e = new Error(`${err.message}（经代理 ${proxy.host}:${proxy.port}）`)
        e.code = err.code
        reject(e)
        return
      }
      reject(err)
    })
    if (body) req.write(body)
    req.end()
  })
}

/**
 * 发起 HTTP(S) 请求，自动跟随重定向。
 * @param {string} url
 * @param {{method?:string,headers?:object,body?:Buffer|string|null,timeout?:number,proxy?:object|null,maxRedirects?:number}} opts
 * @returns {Promise<{status:number,headers:object,body:Buffer,url:string}>}
 */
export async function proxyRequest(url, opts = {}) {
  const { maxRedirects = 5, ...rest } = opts
  let current = url
  let method = rest.method || 'GET'
  let body = rest.body ?? null
  let headers = { ...(rest.headers || {}) }

  for (let i = 0; i <= maxRedirects; i++) {
    const res = await rawRequest(current, { ...rest, method, body, headers })
    const loc = res.headers?.location
    if (loc && [301, 302, 303, 307, 308].includes(res.status)) {
      const next = new URL(loc, current).toString()
      // 跨域重定向时去掉可能泄漏的 cookie
      if (new URL(next).host !== new URL(current).host) {
        headers = { ...headers }
        delete headers.Cookie
      }
      if ([301, 302, 303].includes(res.status) && method !== 'GET' && method !== 'HEAD') {
        method = 'GET'
        body = null
        delete headers['Content-Type']
      }
      current = next
      continue
    }
    return { ...res, url: current }
  }
  throw new Error('重定向次数过多')
}

/** 代理连通性测试：请求一个小体积的公共地址，返回耗时与出口信息。 */
export async function testProxy(proxy, timeout = 10000) {
  const target = 'https://www.cloudflare.com/cdn-cgi/trace'
  const started = Date.now()
  const res = await proxyRequest(target, { timeout, proxy, headers: { 'User-Agent': 'Mozilla/5.0' } })
  const ms = Date.now() - started
  const text = res.body.toString('utf8')
  const ip = (text.match(/^ip=(.+)$/m) || [])[1] || ''
  const loc = (text.match(/^loc=(.+)$/m) || [])[1] || ''
  return { ok: res.status === 200, status: res.status, ms, ip, loc }
}

export default { parseProxy, parseProxyList, proxyRequest, maskProxy, testProxy }
