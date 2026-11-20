/**
 * 把 offline 覆盖率换算成「这次请求能不能纯本地出 PDF」。
 *
 * 从 index.js 抽出来的纯函数：不碰磁盘、不发请求，方便单测各种区间边界。
 */

/**
 * @param {null|{total:number, name?:string, complete?:boolean,
 *               pagesCached?:number, chapters:Array<{sort:number,cid:string,name:string,pages:number,cached:number,complete:boolean}>}} cov
 * @param {null|number|{from:number,to:number|null}} chapterIdx
 * @returns {null|{ready:boolean, chapters:Array, pages:number, cached:number, expect:number, name:string}}
 */
export function planFromCoverage(cov, chapterIdx) {
  if (!cov || !Array.isArray(cov.chapters) || !cov.chapters.length) return null

  const total = Number(cov.total) || cov.chapters.length

  if (chapterIdx == null) {
    const pages = cov.chapters.reduce((s, c) => s + (Number(c.pages) || 0), 0)
    return {
      ready: cov.complete === true,
      chapters: cov.chapters,
      pages,
      cached: Number(cov.pagesCached) || 0,
      expect: total,
      name: cov.name || '',
    }
  }

  let from
  let to
  if (typeof chapterIdx === 'number') {
    from = to = Number(chapterIdx)
  } else {
    from = Number(chapterIdx.from) || 1
    // 「1-x」这类没有上限的写法，按作品总章数收口
    to = chapterIdx.to == null ? total : Number(chapterIdx.to)
  }
  const lo = Math.min(from, to)
  const hi = Math.max(from, to)

  const chapters = cov.chapters.filter((c) => c.sort >= lo && c.sort <= hi)
  if (!chapters.length) return null

  const pages = chapters.reduce((s, c) => s + (Number(c.pages) || 0), 0)
  const cached = chapters.reduce((s, c) => s + (Number(c.cached) || 0), 0)
  const expect = hi - lo + 1

  return {
    ready: chapters.length >= expect && chapters.every((c) => c.complete),
    chapters,
    pages,
    cached,
    expect,
    name: cov.name || '',
  }
}

export default planFromCoverage
