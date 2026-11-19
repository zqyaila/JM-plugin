/**
 * 命令里的章节参数解析（插件侧）。
 *
 *   （空）  整本
 *   5       只下第 5 章
 *   1-5     第 1-5 章（区间，默认合并成一个 PDF）
 *   1-x     第 1 章到最后一章
 *   1-      同上
 *   5-3     写反了，自动纠正成 3-5
 *
 * 分隔符兼容 `-` `~` `～` `到` `至`。独立成模块是为了能单测：这类
 * 字符串解析最容易在边界上翻车，而它又直接决定"下多少内容"。
 */

/** @returns {{ok:true, range:null|number|{from:number,to:number|null}, label:string} | {ok:false}} */
export function parseChapterArg(raw) {
  const text = String(raw || '').trim().toLowerCase()
  if (!text) return { ok: true, range: null, label: '整本' }

  let m = /^(\d+)$/.exec(text)
  if (m) {
    const n = Number(m[1])
    return n > 0 ? { ok: true, range: n, label: `第 ${n} 章` } : { ok: false }
  }

  m = /^(\d+)\s*(?:[-~～]|到|至)\s*(\d+|x|end|末)?$/.exec(text)
  if (m) {
    let from = Number(m[1])
    const tail = m[2]
    let to = tail && !/^(x|end|末)$/.test(tail) ? Number(tail) : null
    if (from <= 0 || (to != null && to <= 0)) return { ok: false }
    if (to != null && to < from) [from, to] = [to, from]
    // `3-3` 就是单章：退化成 number，缓存键才和网页端（_c3）对得上
    if (to === from) return { ok: true, range: from, label: `第 ${from} 章` }
    return {
      ok: true,
      range: { from, to },
      label: to == null ? `第 ${from} 章起` : `第 ${from}-${to} 章`,
    }
  }
  return { ok: false }
}

/** 章节参数 → 文件名后缀，与缓存键保持同一套写法。 */
export function chapterSuffix(range) {
  if (range == null) return ''
  if (typeof range === 'number') return `_c${range}`
  return `_r${range.from ?? 1}-${range.to ?? 'end'}`
}
