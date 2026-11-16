/**
 * 极简 ZIP 打包器（store 模式，无压缩）
 *
 * 为什么不装 `archiver` / `jszip`：一个几百 MB 的作品用 JS 压缩纯属浪费 CPU，
 * PDF 内部本身已经是压缩流，store 模式（只存不压）打包耗时接近磁盘拷贝。
 * 自己写 30 行头部 + 一张 CRC32 表，零依赖、零安装成本。
 *
 * 支持：UTF-8 文件名（通用标志位 bit 11）、目录项、流式写盘。
 * 不支持：ZIP64（单文件或总量超过 4 GB）。漫画 PDF 远到不了这个量级。
 */

import fs from 'node:fs'
import path from 'node:path'
import fsp from 'node:fs/promises'

// ---------------------------------------------------------------- CRC32

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

/** DOS 时间：ZIP 头部用的老格式，秒精度只有 2 秒。 */
function dosDateTime(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, day }
}

// ---------------------------------------------------------------- 写入器

/**
 * @param {string} outPath 输出 zip 路径
 */
export function createZipWriter(outPath) {
  const out = fs.createWriteStream(outPath)
  const opened = new Promise((resolve, reject) => {
    out.once('open', resolve)
    out.once('error', reject)
  })

  let offset = 0
  const entries = []

  const write = (buf) =>
    new Promise((resolve, reject) => {
      out.write(buf, (err) => (err ? reject(err) : resolve()))
    })

  async function addBuffer(name, data, { directory = false } = {}) {
    await opened
    const nameBuf = Buffer.from(directory && !name.endsWith('/') ? `${name}/` : name, 'utf8')
    const payload = directory ? Buffer.alloc(0) : data
    const crc = directory ? 0 : crc32(payload)
    const { time, day } = dosDateTime()

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // 本地文件头签名
    local.writeUInt16LE(20, 4) // 解压所需版本 2.0
    local.writeUInt16LE(0x0800, 6) // bit 11：文件名是 UTF-8
    local.writeUInt16LE(0, 8) // 压缩方式 0 = store
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(day, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18) // 压缩后大小
    local.writeUInt32LE(payload.length, 22) // 原始大小
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28) // 扩展字段长度

    const entryOffset = offset
    await write(local)
    await write(nameBuf)
    if (payload.length) await write(payload)
    offset += local.length + nameBuf.length + payload.length

    entries.push({ nameBuf, crc, size: payload.length, offset: entryOffset, time, day, directory })
  }

  /** 从磁盘添加一个文件（一次只把一个文件读进内存，不会累积）。 */
  async function addFile(name, filePath) {
    return addBuffer(name, await fsp.readFile(filePath))
  }

  async function close() {
    await opened
    const cdStart = offset
    for (const e of entries) {
      const cd = Buffer.alloc(46)
      cd.writeUInt32LE(0x02014b50, 0) // 中央目录签名
      cd.writeUInt16LE(0x0314, 4) // made by: UNIX + 2.0
      cd.writeUInt16LE(20, 6) // needed 2.0
      cd.writeUInt16LE(0x0800, 8)
      cd.writeUInt16LE(0, 10)
      cd.writeUInt16LE(e.time, 12)
      cd.writeUInt16LE(e.day, 14)
      cd.writeUInt32LE(e.crc, 16)
      cd.writeUInt32LE(e.size, 20)
      cd.writeUInt32LE(e.size, 24)
      cd.writeUInt16LE(e.nameBuf.length, 28)
      cd.writeUInt16LE(0, 30) // extra
      cd.writeUInt16LE(0, 32) // comment
      cd.writeUInt16LE(0, 34) // disk start
      cd.writeUInt16LE(0, 36) // internal attrs
      cd.writeUInt32LE(e.directory ? 0x10 : 0, 38) // external attrs：目录位
      cd.writeUInt32LE(e.offset, 42)
      await write(cd)
      await write(e.nameBuf)
      offset += cd.length + e.nameBuf.length
    }

    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(0, 4)
    eocd.writeUInt16LE(0, 6)
    eocd.writeUInt16LE(entries.length, 8)
    eocd.writeUInt16LE(entries.length, 10)
    eocd.writeUInt32LE(offset - cdStart, 12)
    eocd.writeUInt32LE(cdStart, 16)
    eocd.writeUInt16LE(0, 20)
    await write(eocd)

    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())))
    return { files: entries.length, size: offset + eocd.length }
  }

  return { addBuffer, addFile, close, path: outPath }
}

/** 把一组文件按给定内部路径打包，供命令行/脚本复用。 */
export async function zipFiles(outPath, files) {
  await fsp.mkdir(path.dirname(outPath), { recursive: true })
  const zip = createZipWriter(outPath)
  for (const f of files) await zip.addFile(f.name, f.path)
  return zip.close()
}

export default createZipWriter
