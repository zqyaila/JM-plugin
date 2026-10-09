# JMReader 插件（TRSS-Yunzai）

把 [JM Reader](https://github.com/)（一个 Kotlin + Jetpack Compose 的漫画阅读器）的核心能力移植到 **TRSS-Yunzai** QQ 机器人上，用 Node.js 复刻了它的完整网络协议（主机发现、请求签名、AES 响应解密、图片打乱还原）。

> [!IMPORTANT]
> **免责声明** — 这是**非官方的第三方客户端**，仅供个人学习与技术研究。
> 与 18comic / JMComic / 禁漫天堂 **无任何关联**，未获其认可或授权。
> 所有漫画内容版权归原作者所有，由第三方源提供；本插件**自身不托管、不存储任何内容**。
> 请尊重版权，并遵守内容来源的服务条款。

## 功能

- 🔎 **搜索** — `#jm搜索` 一个框自适应：关键词（标题/作者/标签）走站内搜索，纯数字 / `JM123456` / 链接直接跳转作品
- 📕 **详情** — `#jm详情` 看作者、标签、章节数、观看/图片/点赞统计、简介
- 📚 **章节 / 阅读** — `#jm章节` 列章节，`#jm看` 直接把漫画页发成图片（自动打乱还原）
- 📕 **加密 PDF 下载** — `#jmpdf` 把整本/单章漫画合成一个**加密 PDF** 发出来（自动打乱还原后逐页嵌入）
- 🔥 **热门 / 随机 / 分类** — `#jm热门` `#jm随机` `#jm分类`
- 👤 **会员** — `#jm登录` / `#jm退出` / `#jm收藏` / `#jm历史`

### PDF 加密说明

`#jmpdf` 生成的 PDF 带打开密码，密码规则：

```
PDF 密码 = 通用密码 + 漫画ID
```

- **通用密码**在插件配置里设置（见下文「配置」），默认空字符串。
- 例如通用密码配成 `abc123`，漫画 `JM1480269`，则 PDF 密码为 `abc1231480269`。
- 加密采用 PDF 标准安全处理器（RC4/AES-128，PDF 1.7），主流阅读器（Adobe、浏览器、WPS）都能正常打开并输入密码。

## 命令一览

| 命令 | 说明 |
| --- | --- |
| `#jm搜索 <关键词|JM号|链接>` | 搜索作品，纯数字直接跳详情 |
| `#jm详情 <JM号>` | 作品详情 |
| `#jm章节 <JM号>` | 章节列表 |
| `#jm看 <JM号> [章节序号] [页码]` | 阅读发图（默认第 1 章第 1 页） |
| `#jm热门` | 最新更新列表 |
| `#jm随机` | 随机推荐一部 |
| `#jm分类` | 分类列表 |
| `#jm登录 <用户名> <密码>` | 登录会员（解锁收藏/历史/评论） |
| `#jm退出` | 退出登录 |
| `#jm收藏` | 我的收藏（需登录） |
| `#jm历史` | 观看历史（需登录） |
| `#jmpdf <JM号> [章节序号]` | 下载为加密 PDF（不填章节=整本，填了=单章） |
| `#jm帮助` | 帮助菜单 |

## 安装

把 `jmreader-plugin/` 整个目录放到 Yunzai 的 `plugins/` 下：

```bash
cd Yunzai/plugins
# 复制本插件目录进去，例如：
cp -r /path/to/jmreader-plugin ./jmreader-plugin
```

然后在插件目录内安装依赖（图片打乱还原 + PDF 生成）：

```bash
cd jmreader-plugin
npm install
```

重启机器人，或使用 Yunzai 的热更新（`#更新` 后加载）。

> 依赖说明：核心协议（签名/加密/解密/主机发现）**只用 Node.js 内置模块**，零第三方依赖。
> - `sharp` — 图片打乱还原（像素级）与 PDF 页转码，必装才能正确还原打乱的页。
> - `@muhammara/wasm` — PDF 生成与加密（WebAssembly 实现，跨平台、无需原生编译）。

## 目录结构

```plaintext
jmreader-plugin/
├─ index.js         插件入口（注册全部命令）
└─ apps/
   ├─ jmcore.js     JMComic 协议核心（签名 / AES 解密 / 主机发现 / 打乱算法）
   └─ jm.js         数据仓库层（类型化接口 + 图片下载还原）
```

## 实现原理

与 Kotlin 版 `app/src/main/kotlin/com/jm/reader/data/net/` 一一对应：

1. **主机发现** — 从 CDN 拉取加密服务器列表（AES 解密，key = `md5("diosfjckwpqpdfjkvnqQjsik")`），
   逐个用 `GET /setting` 探测，取第一个 `code:200` 的主机，失败回退内置主机。
2. **请求签名** — 每个请求带 `Tokenparam` = `<unixSecs>,<appVersion>`、
   `Token` = `md5("<unixSecs>185Hcomic3PAPP7R")`。
3. **响应加密** — `{ "code":200, "data":"<base64 AES-256-ECB>" }`，
   解密 key = `md5("<本次时间戳>185Hcomic3PAPP7R")`（必须用本次请求发送的时间戳）。
4. **图片打乱** — 阅读器按 `md5(专辑ID + 页码)` 计算切片数，重组倒序水平条带。

## 配置

本插件配置保存在 Yunzai 的 `config/jmreader.yaml`（首次运行自动生成）：

```yaml
pdfPassword: ''   # PDF 通用密码前缀，最终密码 = 该值 + 漫画ID
```

其余无需额外配置即可使用（主机自动发现）。如需调整：

- **接口语言**：默认 `TW`（繁体），在 `apps/jmcore.js` 里 `this.lang` 改为 `CN` 即简体。
- **图片主机**：默认自动从 `/setting` 获取，兜底 `cdn-msp3.jmdanjonproxy.vip`。

## 已知限制

- `sharp` / `@muhammara/wasm` 未安装时无法生成 PDF（发图阅读不受影响）。
- 评论/签到/收藏管理等进阶接口已在 `apps/jm.js` 预留，命令层未全部接出，可按需扩展。
- 登录密码会出现在聊天记录里，请仅在私聊/可信环境使用。
- 整本漫画合成 PDF 会较大，发送大文件时可能受 QQ 群文件大小限制；建议单章下载，或分卷。

## 协议

与上游一致采用 [GNU General Public License v3.0](../LICENSE)。

Copyright © 2026 — 仅供学习交流。
