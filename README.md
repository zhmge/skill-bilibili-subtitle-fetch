# Bilibili Subtitle Fetch

把 B 站视频的字幕抓成 `.srt` 文件 —— 多分P 视频和**合集（ugc_season）**通吃。

> An agent skill that fetches Bilibili subtitles as `.srt` files, handling both
> multi-part videos and 合集 (ugc_season collections, e.g. a whole course series).

## 它能做什么

- 取单个分P、一个范围、或全部分P
- 自动识别**合集**：B 站的合集不是多分P，每一集是独立视频（自己的 `bvid`/`cid`/`aid`），
  脚本会按章节建子目录，一集一个文件
- 断点续跑：中断或部分失败后，重跑同一条命令只补没拿到的

## 依赖

- **Node.js** —— 零第三方依赖，只用内置的 `https` / `fs` / `path`
- **一个登录态 cookie 值 `SESSDATA`** —— 必需，原因见下

> 为什么必须带登录态：B 站的 `player/v2` 接口对匿名请求**固定返回空字幕列表**，
> 而且和"这个视频真的没有字幕"长得一模一样（`code=0`，`subtitles: []`）。
> 所以脚本在缺凭据时直接报错退出（退出码 3），一个请求都不发 —— 免得把
> "没登录"误判成"没字幕"。

## 快速开始

```bash
BILI_SESSDATA="<你的值>" node scripts/fetch_subtitles.js "<BV号或视频URL>" --out "<输出目录>"
```

### 怎么拿到 SESSDATA

1. 浏览器登录 B 站
2. `F12` → **Application**（应用）→ **Cookies** → `https://www.bilibili.com`
3. 找到 `SESSDATA`，复制它的 **Value**

它是 **HttpOnly** cookie，所以页面控制台里 `document.cookie` 读不到；浏览器磁盘上的
cookie 库是加密的（Chrome/Edge 的 App-Bound Encryption），也解不出来。**只能手动复制。**

有效期通常数周到数月。它等同于你的账号凭据 —— 谁拿到谁就能以你的身份操作，别外传。

### 常用选项

| 选项 | 说明 |
|---|---|
| `--out DIR` | 输出目录（**必填**，没有默认值） |
| `--p N` | 只取第 N 个分P |
| `--from N --to N` | 取一个范围 |
| `--all` | 取全部分P；URL 里带 `?p=N` 时用它覆盖 |
| `--interval MS` | 请求间隔毫秒（默认 3000，**不建议调低**） |
| `--scan --sample N` | 只探测字幕可用性、不下载，在范围内均匀抽 N 个 |
| `--force` | 忽略断点记录，重跑范围内所有分P |
| `--help` | 打印完整用法 |

先跑一次探针，再决定要不要全量抓（几百个目标时值得）：

```bash
BILI_SESSDATA="<值>" node scripts/fetch_subtitles.js "<URL>" \
  --out "<目录>" --scan --sample 5
```

## 产物

| 文件 | 说明 |
|---|---|
| `<视频标题>_P<n>_<分P名>.srt` | 多分P 视频：每个分P 一个文件，平铺在输出目录 |
| `<NN_章节名>/<NN_标题>.srt` | 合集：一个章节一个子目录，一集一个文件 |
| `_index.md` | 全部条目的索引表：章节、状态、语言、行数、指向 `.srt` |
| `_manifest.json` | 断点续跑台账 |

`.srt` 是唯一的交付物。脚本不会额外生成 `.txt`，也不合并分P。

## 它为什么不是"两个请求的循环"

B 站的 `player/v2` 接口会给非浏览器客户端**随机返回别的视频的字幕** —— 响应结构
完全正常（`code=0`、真实的 `auth_key`、合理的 `lan`），只有内容是错的。实测占比
约 **50%–75%**。

脚本用「字幕 CDN 路径是否以 `<aid><cid>` 开头」来校验，不匹配就重试（最多 8 次），
且校验在 `player/v2` 响应上就完成，所以被投毒的响应**不会触发 CDN 下载**，重试
只花一个请求。

两个直接后果：

- 某个分P 失败**通常是暂时性的**，重跑同一条命令往往第一次就过
- 把失败当成"这个分P 没有字幕"是错的 —— 两者在报告里是不同状态

详见 [`references/api-behavior.md`](references/api-behavior.md)。

## 退出码

`0` 正常 · `2` 参数错 · `3` 缺登录态（一个请求都没发） · `5` 命中风控已熔断 · `6` 指定分P 未拿到

## 已知限制

- 只在 B 站**确实有字幕**时有效
- AI 字幕（`ai-zh`）由音频自动转写，**含识别错误**，不要当作逐字稿引用
- 多人对话、强剪辑、音乐为主的视频，AI 字幕质量差
- 串行请求 + 3 秒间隔是刻意设计，用于避开风控；调快会导致限流，得不偿失

## 合规提示

- 字幕 CDN 的请求**不携带凭据**，凭据只发给 `api.bilibili.com`
- 抓取字幕用于**个人学习**是一回事；批量抓取或再分发涉及 B 站的服务条款，请自行判断

## 项目结构

```
.
├── SKILL.md                 给 AI agent 的完整指令入口
├── README.md                本文件（给人看）
├── LICENSE                  MIT
├── references/
│   ├── api-behavior.md      接口行为、投毒机制、校验原理、SESSDATA 说明
│   └── troubleshooting.md   排错手册：状态区分、风控、断点续跑
└── scripts/
    └── fetch_subtitles.js   零依赖 Node 脚本（唯一入口）
```

安装为 agent skill 时，把整个目录放进你的 skills 目录即可；`SKILL.md` 是入口。

## License

[MIT](LICENSE) © 2026 zhmge
