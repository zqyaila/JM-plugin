/**
 * 漫画风文字→图片卡片渲染器
 *
 * 用 sharp 把 SVG 渲染成 PNG（零原生编译、跨平台）。
 * 风格：米黄底 + 粗黑描边（漫画对话框感）+ 横幅标题 + 彩色标签徽章 + 放射装饰。
 */

let _sharp = null
async function loadSharp() {
  if (_sharp === null) {
    try {
      const mod = await import('sharp')
      _sharp = mod.default ?? mod
    } catch {
      _sharp = false
    }
  }
  return _sharp || null
}

/** HTML 特殊字符转义，防止注入破坏 SVG。 */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 按显示宽度截断文本（中文算 1，ASCII 算 0.55），避免溢出。 */
function fit(text, maxWidth, unitW = 13) {
  const s = String(text ?? '')
  let w = 0
  let out = ''
  for (const ch of s) {
    const cw = ch.charCodeAt(0) > 0x2e80 ? unitW : unitW * 0.58
    if (w + cw > maxWidth) {
      out += '…'
      break
    }
    out += ch
    w += cw
  }
  return out
}

/** 换行：按像素宽度把长文本折成多行。 */
function wrap(text, maxWidth, unitW = 13, maxLines = 6) {
  const s = String(text ?? '')
  const lines = []
  let cur = ''
  let w = 0
  for (const ch of s) {
    const cw = ch.charCodeAt(0) > 0x2e80 ? unitW : unitW * 0.58
    if (w + cw > maxWidth) {
      lines.push(cur)
      cur = ''
      w = 0
      if (lines.length >= maxLines) break
    }
    cur += ch
    w += cw
  }
  if (cur) lines.push(cur)
  if (lines.length > maxLines) {
    lines[maxLines - 1] = lines[maxLines - 1].replace(/…?$/, '') + '…'
  }
  return lines.slice(0, maxLines)
}

// 卡片常量
const CARD_W = 640
const PAD = 28
const INK = '#1a1a1a' // 墨色
const PAPER = '#fdf6e3' // 米黄纸
const ACCENT = '#e63946' // 主色（红）
const ACCENT2 = '#f4a261' // 橙
const LINE_H = 30

/**
 * 生成带粗描边的漫画风格圆角卡片（SVG）。
 * @param {object} opt
 *  - title 大标题
 *  - badge 标题右上角徽章文字（如 JM号）
 *  - body 已渲染的 SVG 内容字符串（各行）
 *  - bodyHeight 内容区高度
 */
function cardFrame(opt) {
  const { title, badge, body, bodyHeight } = opt
  const headerH = 84
  const h = headerH + bodyHeight + PAD + 18
  const badgeW = badge ? badge.length * 15 + 22 : 0

  const burst = `
    <g opacity="0.06" stroke="${ACCENT}" stroke-width="2">
      ${Array.from({ length: 12 }, (_, i) => {
        const a = (i * Math.PI) / 6
        const x2 = 320 + Math.cos(a) * 520
        const y2 = 40 + Math.sin(a) * 520
        return `<line x1="320" y1="40" x2="${x2.toFixed(0)}" y2="${y2.toFixed(0)}" />`
      }).join('')}
    </g>`

  const badgeSvg = badge
    ? `<g transform="translate(${CARD_W - badgeW - 26},20)">
         <rect x="0" y="0" width="${badgeW}" height="30" rx="15" fill="${ACCENT}" stroke="${INK}" stroke-width="2"/>
         <text x="${badgeW / 2}" y="20" text-anchor="middle" font-family="sans-serif" font-size="14" font-weight="bold" fill="#fff">${esc(badge)}</text>
       </g>`
    : ''

  return `<svg width="${CARD_W}" height="${h}" viewBox="0 0 ${CARD_W} ${h}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <filter id="rough" x="-2%" y="-2%" width="104%" height="104%">
        <feTurbulence type="fractalNoise" baseFrequency="0.04" numOctaves="2" result="n"/>
        <feDisplacementMap in="SourceGraphic" in2="n" scale="1.5"/>
      </filter>
    </defs>
    ${burst}
    <rect x="10" y="10" width="${CARD_W - 20}" height="${h - 20}" rx="16" fill="${PAPER}" stroke="${INK}" stroke-width="3"/>
    <rect x="14" y="14" width="${CARD_W - 28}" height="${h - 28}" rx="13" fill="none" stroke="${INK}" stroke-width="1" opacity="0.35"/>
    <!-- 标题横幅 -->
    <path d="M16 30 L${CARD_W - 16} 22 L${CARD_W - 16} ${headerH - 4} L16 ${headerH + 4} Z" fill="${ACCENT}" stroke="${INK}" stroke-width="2"/>
    <path d="M16 30 L${CARD_W - 16} 22" stroke="#fff" stroke-width="3" opacity="0.5"/>
    <text x="42" y="60" font-family="sans-serif" font-size="30" font-weight="bold" fill="#fff" stroke="${INK}" stroke-width="0.6">${esc(fit(title, CARD_W - 120, 30))}</text>
    ${badgeSvg}
    <g transform="translate(${PAD},${headerH + 22})">${body}</g>
    <text x="${CARD_W - 26}" y="${h - 12}" text-anchor="end" font-family="sans-serif" font-size="11" fill="${INK}" opacity="0.4">JMReader</text>
  </svg>`
}

/** 渲染一个信息卡片为 PNG buffer。 */
export async function renderDetailCard(d) {
  const lines = []
  let y = 0

  // 元信息行（标签：值）
  const meta = [
    ['作者', (d.authors || []).join(' / ') || '未知'],
    ['标签', (d.tags || []).slice(0, 8).join(' · ') || '—'],
    ['章节', (d.series && d.series.length) ? `共 ${d.series.length} 章` : '—'],
  ]
  for (const [k, v] of meta) {
    lines.push(labelRow(k, v, y))
    y += LINE_H + 8
  }

  // 分隔线
  lines.push(`<line x1="0" y1="${y + 2}" x2="${CARD_W - PAD * 2}" y2="${y + 2}" stroke="${INK}" stroke-width="1.5" stroke-dasharray="6 5" opacity="0.5"/>`)
  y += 18

  // 数据统计条
  const stats = [
    ['观看', fmtNum(d.totalViews)],
    ['图片', fmtNum(d.totalPhotos)],
    ['点赞', fmtNum(d.likes)],
    ['评论', fmtNum(d.commentTotal)],
  ]
  const statW = (CARD_W - PAD * 2) / stats.length
  stats.forEach(([k, v], i) => {
    const cx = i * statW
    lines.push(`<text x="${cx + statW / 2}" y="${y + 4}" text-anchor="middle" font-family="sans-serif" font-size="13" fill="${INK}" opacity="0.6">${esc(k)}</text>`)
    lines.push(`<text x="${cx + statW / 2}" y="${y + 30}" text-anchor="middle" font-family="sans-serif" font-size="24" font-weight="bold" fill="${ACCENT}">${esc(v)}</text>`)
  })
  y += 48

  // 简介
  if (d.description) {
    lines.push(`<line x1="0" y1="${y}" x2="${CARD_W - PAD * 2}" y2="${y}" stroke="${INK}" stroke-width="1.5" stroke-dasharray="6 5" opacity="0.5"/>`)
    y += 16
    lines.push(`<text x="0" y="${y + 16}" font-family="sans-serif" font-size="14" font-weight="bold" fill="${INK}">简介</text>`)
    y += 28
    for (const ln of wrap(d.description, CARD_W - PAD * 2 - 8, 14.5, 5)) {
      lines.push(`<text x="0" y="${y}" font-family="sans-serif" font-size="14" fill="#3a3a3a">${esc(ln)}</text>`)
      y += LINE_H - 6
    }
  }

  const body = lines.join('\n')
  const svg = cardFrame({
    title: d.name || '未知作品',
    badge: d.id ? `JM${d.id}` : '',
    body,
    bodyHeight: y + 8,
  })
  return renderSvg(svg)
}

/** 章节列表卡片。 */
export async function renderChaptersCard(d) {
  const series = d.series || []
  const lines = []
  let y = 0
  lines.push(`<text x="0" y="${y + 4}" font-family="sans-serif" font-size="13" fill="${INK}" opacity="0.6">${esc(fit(`共 ${series.length} 章`, CARD_W, 13))}</text>`)
  y += LINE_H

  for (const s of series.slice(0, 30)) {
    const name = fit(s.name || `第 ${s.sort} 話`, CARD_W - PAD * 2 - 90, 14.5)
    const page = `${s.totalPage || 0}P`
    lines.push(`<g>
      <rect x="0" y="${y - 20}" width="${CARD_W - PAD * 2}" height="26" rx="6" fill="#fff" stroke="${INK}" stroke-width="1.2" opacity="0.9"/>
      <text x="12" y="${y}" font-family="sans-serif" font-size="14" font-weight="bold" fill="${ACCENT}">${esc(String(s.sort).padStart(2, '0'))}</text>
      <text x="52" y="${y}" font-family="sans-serif" font-size="14" fill="${INK}">${esc(name)}</text>
      <text x="${CARD_W - PAD * 2 - 12}" y="${y}" text-anchor="end" font-family="sans-serif" font-size="13" fill="${ACCENT2}" font-weight="bold">${esc(page)}</text>
    </g>`)
    y += LINE_H + 6
  }
  if (series.length > 30) {
    lines.push(`<text x="0" y="${y}" font-family="sans-serif" font-size="12" fill="${INK}" opacity="0.5">… 还有 ${series.length - 30} 章</text>`)
    y += LINE_H
  }

  const svg = cardFrame({
    title: d.name || '章节列表',
    badge: d.id ? `JM${d.id}` : '',
    body: lines.join('\n'),
    bodyHeight: y,
  })
  return renderSvg(svg)
}

/** 列表卡片（搜索结果 / 热门 / 随机 / 收藏 / 历史 / 分类通用）。 */
export async function renderListCard({ title, badge, items, more }) {
  const lines = []
  let y = 0
  const maxNameW = CARD_W - PAD * 2 - 110
  for (const it of items.slice(0, 15)) {
    const name = fit(it.name || '', maxNameW, 15.5)
    const sub = it.author || it.sub || ''
    const tail = it.id ? `JM${it.id}` : (it.slug || '')
    const subText = sub ? ` · ${fit(sub, maxNameW - 40, 12.5)}` : ''
    lines.push(`<g>
      <text x="0" y="${y}" font-family="sans-serif" font-size="15" font-weight="bold" fill="${INK}">${esc(String(it.no ?? '')).trim() ? esc(String(it.no)) : ''}</text>
      <text x="34" y="${y}" font-family="sans-serif" font-size="15" font-weight="bold" fill="${INK}">${esc(name)}</text>
      <text x="${CARD_W - PAD * 2}" y="${y}" text-anchor="end" font-family="sans-serif" font-size="13" font-weight="bold" fill="${ACCENT}">${esc(tail)}</text>
    </g>`)
    if (sub) {
      y += 22
      lines.push(`<text x="34" y="${y}" font-family="sans-serif" font-size="12" fill="${INK}" opacity="0.55">${esc(subText)}</text>`)
    }
    y += 24
    if (it !== items[items.length - 1]) {
      lines.push(`<line x1="0" y1="${y - 6}" x2="${CARD_W - PAD * 2}" y2="${y - 6}" stroke="${INK}" stroke-width="0.6" opacity="0.12"/>`)
    }
  }
  if (more) {
    lines.push(`<text x="0" y="${y + 2}" font-family="sans-serif" font-size="12" fill="${ACCENT2}" font-weight="bold">${esc(more)}</text>`)
    y += LINE_H
  }

  const svg = cardFrame({
    title,
    badge,
    body: lines.join('\n'),
    bodyHeight: y,
  })
  return renderSvg(svg)
}

/** 标签徽章行（作者/标签/章节）：从 y 向下绘制。 */
function labelRow(k, v, y) {
  const v2 = fit(v, CARD_W - PAD * 2 - 60, 14)
  return `<g>
    <rect x="0" y="${y}" width="52" height="24" rx="4" fill="${INK}"/>
    <text x="26" y="${y + 17}" text-anchor="middle" font-family="sans-serif" font-size="13" font-weight="bold" fill="#fff">${esc(k)}</text>
    <text x="64" y="${y + 18}" font-family="sans-serif" font-size="14" fill="${INK}">${esc(v2)}</text>
  </g>`
}

function fmtNum(n) {
  const v = Number(n) || 0
  if (v >= 10000) return (v / 10000).toFixed(1) + 'w'
  if (v >= 1000) return (v / 1000).toFixed(1) + 'k'
  return String(v)
}

/** SVG → PNG buffer。 */
async function renderSvg(svg) {
  const sharp = await loadSharp()
  if (!sharp) throw new Error('未安装 sharp，无法渲染图片')
  return sharp(Buffer.from(svg)).png().toBuffer()
}
