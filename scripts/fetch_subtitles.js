#!/usr/bin/env node
/**
 * B 站字幕抓取 —— 单一入口（多分P 视频 / ugc_season 合集 通吃）
 *
 * 用法：
 *   BILI_SESSDATA="<值>" node fetch_subtitles.js "<BV号或视频URL>" --out "<输出目录>" [选项]
 *
 * 选项：
 *   --out DIR       输出目录（必填；调用方应先向用户确认放到哪里）
 *   --p N           只取第 N 个分P（与 --from/--to/--all 互斥）
 *   --from N        起始分P（默认 1）
 *   --to N          结束分P（默认 全部分P）
 *   --all           取全部分P；URL 里带 ?p=N 时用它覆盖
 *   --interval MS   请求间隔毫秒（默认 3000，不建议调低）
 *   --scan          只探测字幕可用性，不下载（每分P 仅 1 个请求）
 *   --sample N      配合 --scan，在范围内均匀抽 N 个分P
 *   --force         忽略断点记录，重跑范围内所有分P
 *   --help          打印用法
 *
 * 登录态：只从环境变量 BILI_SESSDATA 读取，不读写任何文件。
 *   player/v2 匿名请求固定返回空数组，与"视频没字幕"长得一模一样，
 *   因此缺凭据时直接报错退出（码 3），一个请求都不发。
 *
 * 退出码：0 正常 / 2 参数错 / 3 缺登录态 / 5 命中风控已熔断 / 6 指定分P 未拿到
 *
 * 低风险设计：全程串行 + 固定间隔 + 无并发；view 只调 1 次拿全部分P 的 cid；
 *   命中风控码立刻熔断并保存进度；每分P 落盘 manifest，可断点续跑；
 *   凭据只发给 api.bilibili.com，字幕 CDN 不带凭据。
 *
 * 合集支持：view 返回 ugc_season 时自动切换分支 —— 目标清单取自
 *   sections[].episodes[]，每一集都用「各自的 bvid / cid / aid」去请求与校验
 *   （投毒校验的 aid·cid 路径前缀规则对每一集独立成立），产物按章节分目录。
 *   注意：合集的 pages 长度恒为 1，若只读 pages 会「成功地」只抓到 1 集。
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0';
const RISK_CODES = new Set([-352, -412, -509, -799]); // 风控 / 限流 / 拒绝服务
const REQUESTS_PER_PART = 4;   // 估算用：player 平均 2~3 次重试 + 字幕CDN 1 次（view 只调一次）
const MAX_VERIFY_ATTEMPTS = 8; // 单个分P 最多重试次数，防止接口持续投毒时无限重试

let requestCount = 0;
let authedRequestCount = 0;   // 真正带上 SESSDATA 的请求数（用于自检）
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 风控错误 —— 调用方应立即停止所有后续请求 */
class RiskControlError extends Error {
  constructor(msg) { super(msg); this.name = 'RiskControlError'; }
}
/** 可跳过的单点错误（某个分P 没字幕、CDN 404 等），不阻断批量 */
class SkipError extends Error {
  constructor(msg) { super(msg); this.name = 'SkipError'; }
}

/* ============================ HTTP ============================ */

/** 当前装载的登录态（只认环境变量，不落盘） */
function sessdataValue() {
  const v = process.env.BILI_SESSDATA;
  return v && v.trim() ? v.trim() : null;
}

function httpGet(url, referer) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = {
      'User-Agent': UA,
      Referer: referer,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Origin: 'https://www.bilibili.com',
      Connection: 'close'
    };
    // 登录态只发给 api.bilibili.com；字幕 CDN 是公开资源，不携带凭据
    const sd = sessdataValue();
    if (sd && u.hostname === 'api.bilibili.com') {
      headers.Cookie = 'SESSDATA=' + sd;
      authedRequestCount++;
    }
    requestCount++;
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers,
      timeout: 20000
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => body += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch { /* 字幕 CDN 偶发非 JSON */ }
        resolve({ status: res.statusCode, body, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end();
  });
}

/** 统一的响应检查：风控码抛 RiskControlError，其余非 0 抛 SkipError */
function guard(label, r) {
  if (r.status !== 200) throw new Error(`${label}: HTTP ${r.status}`);
  const j = r.json;
  if (!j) return null;
  if (RISK_CODES.has(j.code)) {
    throw new RiskControlError(`${label}: 命中风控/限流 code=${j.code} msg=${j.message}`);
  }
  if (j.code !== 0) throw new SkipError(`${label}: code=${j.code} msg=${j.message}`);
  return j.data;
}

/* ============================ 小工具 ============================ */

function toSrtTime(sec) {
  const ms = Math.round((sec || 0) * 1000);
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
  return `${h}:${m}:${s},${String(ms % 1000).padStart(3, '0')}`;
}

function safeName(n) {
  return String(n || '').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function parseTarget(input) {
  const m = String(input || '').match(/BV[0-9A-Za-z]{10}/);
  if (!m) throw new Error('没识别出 BV 号');
  const p = String(input).match(/[?&]p=(\d+)/);
  return { bvid: m[0], page: p ? Number(p[1]) : null };
}

function fmtTime(s) {
  const m = Math.floor(s / 60), sec = Math.round(s % 60);
  return `${m}分${String(sec).padStart(2, '0')}秒`;
}

/* ============================ 接口 ============================ */

/** ① 取视频信息 + 全部分P 的 cid（一次请求覆盖所有分P） */
async function getVideoInfo(bvid, referer) {
  const d = guard('view 接口',
    await httpGet(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, referer));
  // ugc_season 存在时说明该视频属于一个合集 —— 真正的抓取目标是合集里的每一集
  const season = d.ugc_season ? {
    id: d.ugc_season.id,
    title: d.ugc_season.title,
    sections: (d.ugc_season.sections || []).map(s => ({
      title: s.title,
      episodes: (s.episodes || []).map(e => ({ bvid: e.bvid, cid: e.cid, aid: e.aid, title: e.title }))
    }))
  } : null;
  return {
    aid: d.aid, title: d.title, owner: d.owner && d.owner.name,
    pages: d.pages, videos: d.videos, season
  };
}

/* ==================== 目标清单归一化 ====================
 * 把「多分P 的 pages」与「合集的 sections[].episodes[]」统一成同一种目标结构，
 * 后续主循环不必区分两者。
 *   { page 全局序号, part 标题, cid, bvid, aid, referer, url 来源链接, section|null, indexInSection }
 *
 * referer 与 url 是两件事：referer 只用于请求头，url 是要写进 srt 首行的可点击地址。
 * 多分P 的 url 必须带 ?p=N（referer 不带），否则每个分P 的链接都会跳到默认分P。
 */

/** 去掉标题里对所在章节而言冗余的合集前缀（"数据结构合集 - 树(...)" → "树(...)"） */
function cleanTitle(t) {
  return String(t || '').replace(/^数据结构合集\s*[-–—]\s*/, '').replace(/\s+/g, ' ').trim();
}

/** 多分P：一个 bvid，N 个 cid */
function normalizeParts(info, bvid) {
  const pages = info.pages || [];
  const multi = pages.length > 1;
  return pages.map(p => ({
    page: p.page,
    part: cleanTitle(p.part),
    cid: p.cid,
    bvid,
    aid: info.aid,
    referer: `https://www.bilibili.com/video/${bvid}/`,
    // 来源链接写进 srt 首行；多分P 必须带 ?p=N，单分P 用规范短地址
    url: multi
      ? `https://www.bilibili.com/video/${bvid}/?p=${p.page}`
      : `https://www.bilibili.com/video/${bvid}/`,
    section: null,
    indexInSection: p.page
  }));
}

/** 合集：68 个独立视频，各自带 bvid / cid / aid */
function normalizeSeason(season) {
  const targets = [];
  const sections = [];
  let globalIdx = 0;
  for (const sec of (season.sections || [])) {
    const eps = (sec.episodes || []).filter(e => e && e.bvid && e.cid);
    if (!eps.length) continue;
    const secInfo = { index: sections.length + 1, title: sec.title || `章节${sections.length + 1}` };
    sections.push(secInfo);
    eps.forEach((e, ei) => {
      globalIdx++;
      targets.push({
        page: globalIdx,
        part: cleanTitle(e.title),
        cid: e.cid,
        bvid: e.bvid,
        aid: e.aid,
        referer: `https://www.bilibili.com/video/${e.bvid}/`,
        // 合集每集都是独立视频，链接就是它自己的 BV，不带 ?p
        url: `https://www.bilibili.com/video/${e.bvid}/`,
        section: secInfo,
        indexInSection: ei + 1
      });
    });
  }
  return { targets, sections };
}

/** 决定某个目标的落盘位置：合集按章节建子目录，多分P 直接平铺 */
function targetOutput(outDir, videoTitle, t, isSeason) {
  if (isSeason && t.section) {
    const dir = path.join(outDir, safeName(`${String(t.section.index).padStart(2, '0')}_${t.section.title}`));
    const base = safeName(`${String(t.indexInSection).padStart(2, '0')}_${t.part}`);
    return { dir, base };
  }
  return { dir: outDir, base: safeName(`${videoTitle}_P${t.page}_${t.part}`) };
}

/** ② 取某分P 的字幕清单（需要登录态） */
async function getSubtitleList(bvid, cid, referer) {
  // 防御：没装载登录态就发这个请求，结果必然是空的空数组，会误导判断
  if (!sessdataValue()) {
    throw new Error('内部错误：未装载登录态就发起了字幕列表请求（结果会假性为空）');
  }
  const d = guard('player 接口',
    await httpGet(`https://api.bilibili.com/x/player/v2?bvid=${bvid}&cid=${cid}`, referer));
  return (d.subtitle && d.subtitle.subtitles) || [];
}

/** 挑选优先级：中文人工 > 中文AI > 任意中文 > 第一条 */
function pickSubtitle(subs) {
  return subs.find(s => s.lan === 'zh-CN') ||
         subs.find(s => s.lan === 'ai-zh') ||
         subs.find(s => String(s.lan).startsWith('zh')) ||
         subs[0];
}

/* ============ 数据投毒校验 ============
 * api.bilibili.com/x/player/v2 对非浏览器客户端会非确定性地返回「其它视频」的
 * 字幕条目（code=0、结构合法、内容完全无关），实测命中率约 50%~75%。
 * 加设备指纹、加防缓存参数都无效。详见 references/api-behavior.md。
 *
 * 判别依据：正确的字幕对象路径形如
 *   //aisubtitle.hdslb.com/bfs/ai_subtitle/prod/<aid><cid><hash>?auth_key=...
 * 即路径前缀恰好是 aid 直接拼接 cid。用这个做校验，错了就重试。
 */

function subtitlePathHash(subtitleUrl) {
  const m = String(subtitleUrl || '').match(/\/prod\/([^?]+)/);
  return m ? m[1] : null;
}

function isOwnSubtitle(subtitleUrl, aid, cid) {
  const hash = subtitlePathHash(subtitleUrl);
  if (!hash) return false;                       // 空 URL / 结构异常，也算失败
  return hash.startsWith(String(aid) + String(cid));
}

/**
 * 反复请求 player 接口，直到拿到确认属于本分P 的字幕条目。
 * 返回 { pick, attempts, poisoned } —— pick 为 null 表示重试用尽仍未命中。
 */
async function getVerifiedSubtitle(bvid, aid, cid, referer, opts = {}) {
  const maxAttempts = opts.maxAttempts || MAX_VERIFY_ATTEMPTS;
  const delayMs = opts.delayMs === undefined ? 800 : opts.delayMs;
  let poisoned = 0;

  for (let att = 1; att <= maxAttempts; att++) {
    if (att > 1) await sleep(delayMs);
    const subs = await getSubtitleList(bvid, cid, referer);
    const valid = subs.filter(s => isOwnSubtitle(s.subtitle_url, aid, cid));
    if (valid.length) {
      return { pick: pickSubtitle(valid), attempts: att, poisoned, total: subs.length };
    }
    if (subs.length) poisoned++;
  }
  return { pick: null, attempts: maxAttempts, poisoned };
}

/** ③ 下载字幕正文（CDN 公开，无需 cookie） */
async function downloadSubtitle(subtitleUrl, referer) {
  let u = subtitleUrl;
  if (u.startsWith('//')) u = 'https:' + u;
  const r = await httpGet(u, referer);
  if (r.status !== 200) throw new SkipError(`字幕CDN: HTTP ${r.status}`);
  let j = r.json;
  if (!j) { try { j = JSON.parse(r.body); } catch { throw new SkipError('字幕正文不是合法 JSON'); } }
  const body = Array.isArray(j.body) ? j.body : [];
  if (!body.length) throw new SkipError('字幕内容为空');
  return body;
}

/* ============================ 落盘 ============================ */

/** 只写 SRT（交付产物只有 SRT）。首行是该目标的来源链接，紧随一个空行。 */
function writeSrt(outDir, base, body, sourceUrl) {
  fs.mkdirSync(outDir, { recursive: true });
  // 来源链接独占一行且后面必须紧跟一个空行：下游解析器（srt-course-outline 等）
  // 靠这个空行把链接行与第 1 个字幕块隔开。若省掉空行，按「空行分块」的解析器
  // 会把链接行与第 1 块并成一块，从而静默丢掉第 1 块。
  let srt = sourceUrl ? String(sourceUrl).trim() + '\n\n' : '', count = 0;
  body.forEach(it => {
    const text = String(it.content || '').trim();
    if (!text) return;
    count++;
    srt += `${count}\n${toSrtTime(it.from)} --> ${toSrtTime(it.to)}\n${text}\n\n`;
  });
  const srtPath = path.join(outDir, base + '.srt');
  fs.writeFileSync(srtPath, srt, 'utf8');
  return { srtPath, count };
}

/* ============================ 参数 ============================ */

const USAGE = [
  '用法: BILI_SESSDATA="<值>" node fetch_subtitles.js "<BV号或视频URL>" --out "<目录>" [选项]',
  '',
  '支持两种目标，自动判别：',
  '  · 多分P 视频（pages）      → 产物平铺在输出目录',
  '  · 合集  （ugc_season）     → 逐集用各自的 bvid 请求，产物按章节建子目录',
  '',
  '  --out DIR       输出目录（必填）',
  '  --p N           只取第 N 个（多分P 的分P / 合集的第 N 集）',
  '  --from N        起始序号（默认 1）',
  '  --to N          结束序号（默认 全部）',
  '  --all           取全部；URL 里带 ?p=N 时用它覆盖',
  '  --interval MS   请求间隔毫秒（默认 3000）',
  '  --scan          只探测字幕可用性，不下载',
  '  --sample N      配合 --scan，在范围内均匀抽样',
  '  --force         忽略断点记录，重跑范围内所有目标',
  '  --help          打印本说明'
].join('\n');

function parseArgs(argv) {
  const out = { input: null, outDir: null, p: null, from: 1, to: null, interval: 3000, force: false, scan: false, sample: null, all: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help') { console.log(USAGE); process.exit(0); }
    else if (a === '--force') out.force = true;
    else if (a === '--scan') out.scan = true;
    else if (a === '--all') out.all = true;
    else if (a === '--out') out.outDir = argv[++i];
    else if (a === '--p') out.p = Number(argv[++i]);
    else if (a === '--sample') out.sample = Number(argv[++i]);
    else if (a === '--from') out.from = Number(argv[++i]);
    else if (a === '--to') out.to = Number(argv[++i]);
    else if (a === '--interval') out.interval = Number(argv[++i]);
    else if (!a.startsWith('--')) out.input = a;
  }
  return out;
}

/* ============================ 主流程 ============================ */

async function main() {
  const args = parseArgs(process.argv);

  if (!args.input) { console.error('✗ 缺少视频 BV 号或 URL\n\n' + USAGE); process.exit(2); }
  if (!args.outDir) { console.error('✗ 缺少 --out（输出目录）。请先向用户确认 .srt 放到哪里。\n\n' + USAGE); process.exit(2); }
  if (args.p !== null && (args.p < 1 || !Number.isFinite(args.p))) { console.error('✗ --p 不合法'); process.exit(2); }
  if (args.p !== null && (args.from !== 1 || args.to !== null)) { console.error('✗ --p 与 --from/--to 互斥'); process.exit(2); }
  if (args.all && (args.p !== null || args.from !== 1 || args.to !== null)) { console.error('✗ --all 与 --p/--from/--to 互斥'); process.exit(2); }
  if (!Number.isFinite(args.from) || args.from < 1) { console.error('✗ --from 不合法'); process.exit(2); }

  const sessdata = sessdataValue();
  if (!sessdata) {
    console.error('✗ 缺少登录态：环境变量 BILI_SESSDATA 为空。');
    console.error('  字幕列表接口匿名请求固定返回空数组，与"视频没字幕"无法区分，故一个请求都不发。');
    console.error('  取法：已登录的浏览器打开 bilibili.com → F12 → Application → Cookies');
    console.error('        → https://www.bilibili.com → SESSDATA → 复制 Value。');
    console.error('  用法：BILI_SESSDATA="<值>" node fetch_subtitles.js "<URL>" --out "<目录>"');
    process.exit(3);
  }

  const { bvid, page: pageFromUrl } = parseTarget(args.input);
  // URL 里的 ?p=N 只在调用方没有显式指定范围时才生效（--p / --from / --to / --all 都算显式）
  const scopeGiven = args.p !== null || args.from !== 1 || args.to !== null || args.all;
  const scopeFromUrl = args.p === null && !scopeGiven && pageFromUrl !== null && pageFromUrl !== undefined;
  if (scopeFromUrl) args.p = pageFromUrl;
  const videoUrl = `https://www.bilibili.com/video/${bvid}/`;
  const outDir = path.resolve(args.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const manifestPath = path.join(outDir, '_manifest.json');

  // 进度记录：按 bvid 分桶，允许同一输出目录承接多个视频
  let manifest = { videos: {} };
  if (fs.existsSync(manifestPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (raw && raw.videos) manifest = raw;
      else if (raw && raw.bvid) manifest.videos[raw.bvid] = { title: raw.title, parts: raw.parts || {} };
    } catch { /* 坏文件就重建 */ }
  }
  if (!manifest.videos) manifest.videos = {};

  console.log(`▶ 目标: ${bvid}`);
  console.log(`  登录态: 已装载（SESSDATA 长度 ${sessdata.length}，仅发给 api.bilibili.com）`);
  console.log(`  输出目录: ${outDir}`);

  // ① 一次请求，拿完整结构（多分P 的 pages 或 合集的 ugc_season）
  const info = await getVideoInfo(bvid, videoUrl);

  const isSeason = !!(info.season && (info.season.sections || []).some(s => (s.episodes || []).length));
  const unitLabel = isSeason ? '集' : '分P';
  args._unit = unitLabel;
  let allTargets;
  let sectionCount = 0;
  if (isSeason) {
    const norm = normalizeSeason(info.season);
    allTargets = norm.targets;
    sectionCount = norm.sections.length;
  } else {
    allTargets = normalizeParts(info, bvid);
  }

  const bucketKey = isSeason ? `season:${info.season.id}` : bvid;
  const bucket = manifest.videos[bucketKey] ||
    (manifest.videos[bucketKey] = { title: info.title, parts: {} });
  if (!bucket.parts) bucket.parts = {};
  // 合集用合集自己的标题（入口 BV 只是其中一集，它的标题代表不了整个合集）
  bucket.title = isSeason ? info.season.title : info.title;
  bucket.kind = isSeason ? 'season' : 'video';

  console.log(`  标题: ${info.title}`);
  console.log(`  UP: ${info.owner}`);
  if (isSeason) {
    console.log(`  类型: 合集（ugc_season id=${info.season.id}）  ${sectionCount} 个章节 / ${allTargets.length} 集`);
    (info.season.sections || []).forEach((s, i) => {
      const n = (s.episodes || []).length;
      if (n) console.log(`        ${String(i + 1).padStart(2, '0')}  ${s.title}  ${n} 集`);
    });
  } else {
    console.log(`  类型: 多分P 视频  共 ${info.videos} 个分P`);
    // 资产年代预检：AI 字幕只观测到存在于 2023-12~2024-06 重编码窗口的资产上。
    // pages[].ctime 由 view 接口免费提供，这里零成本提示「整门课可能没有字幕」的事实。
    if (info.videos > 1) {
      const ct = (info.pages || []).map(p => p.ctime).filter(Boolean);
      if (ct.length && ct.length === info.pages.length) {
        const pre = ct.filter(t => t < 1672531200).length;                    // 2023-01-01 前
        const win = ct.filter(t => t >= 1701388800 && t < 1719792000).length; // AI 字幕重编码窗口
        const post = ct.length - pre - win;
        console.log(`  资产年代: 早期资产(2023前) ${pre} 个 · AI字幕窗口重编码(2023-12~2024-06) ${win} 个 · 更新 ${post} 个`);
        if (pre / ct.length >= 0.5) {
          console.log('  ⚠ 大部分分P为早期资产：B站可能从未为其生成 AI 字幕，扫描出现大量「无字幕」属正常现象，不是故障');
        }
      }
    }
  }

  if (!allTargets.length) {
    console.error('✗ 未解析出任何抓取目标（既无 pages 也无 ugc_season.sections）');
    process.exit(2);
  }

  const single = args.p !== null;
  const from = single ? args.p : args.from;
  const to = single ? args.p : (args.to ? Math.min(args.to, allTargets.length) : allTargets.length);

  if (single && !allTargets.some(t => t.page === args.p)) {
    console.error(`✗ 第 ${args.p} 个${unitLabel}不存在（共 ${allTargets.length} 个）`);
    process.exit(2);
  }

  let targets = allTargets.filter(t => t.page >= from && t.page <= to);

  // --sample N：在范围内均匀抽 N 个分P，用于低成本判断"这套视频到底有没有字幕"
  if (args.sample && args.sample < targets.length) {
    const n = Math.max(1, args.sample);
    const picked = [];
    for (let i = 0; i < n; i++) {
      picked.push(targets[Math.round(i * (targets.length - 1) / (n - 1 || 1))]);
    }
    targets = [...new Map(picked.map(t => [t.page, t])).values()];
  }

  const pending = targets.filter(t => args.force || (bucket.parts[t.page] || {}).status !== 'ok');
  const skipped = targets.length - pending.length;

  const perPart = args.scan ? 1 : REQUESTS_PER_PART;
  console.log(`  范围: 第 ${from} ~ ${to} 个${unitLabel}（${targets.length} 个${args.sample ? ' 抽样' : ''}）${scopeFromUrl ? `  ← 来自 URL 的 ?p=${args.p}` : ''}`);
  console.log(`  模式: ${args.scan ? '扫描（只探测可用性，不下载）' : '下载'}`);
  console.log(`  待处理: ${pending.length} 个   已有记录跳过: ${skipped} 个`);
  console.log(`  请求间隔: ${args.interval}ms   预计耗时约 ${fmtTime(pending.length * perPart * args.interval / 1000 + 10)}`);
  console.log(`  预计请求数: ${1 + pending.length * perPart}`);
  console.log('');

  const stat = { ok: 0, no_sub: 0, skip: 0, has_sub: 0, poisoned: 0 };
  const noSubParts = [];
  const poisonedParts = [];
  const t0 = Date.now();

  function save() {
    manifest.updatedAt = new Date().toISOString();
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  }
  save();

  for (let i = 0; i < pending.length; i++) {
    const p = pending[i];
    const tag = `[${i + 1}/${pending.length}] ${isSeason ? '第' + p.page + '集' : 'P' + p.page}`;
    const rec = bucket.parts[p.page] || (bucket.parts[p.page] = { page: p.page });
    rec.page = p.page;
    rec.cid = p.cid;
    rec.bvid = p.bvid;
    rec.aid = p.aid;
    rec.part = p.part;
    rec.url = p.url;
    if (p.section) { rec.section = p.section.title; rec.indexInSection = p.indexInSection; }

    await sleep(args.interval);

    let vr;
    try {
      vr = await getVerifiedSubtitle(p.bvid, p.aid, p.cid, p.referer, { maxAttempts: MAX_VERIFY_ATTEMPTS });
    } catch (e) {
      if (e.name === 'RiskControlError') {
        rec.status = 'aborted'; rec.reason = e.message;
        save();
        console.error(`\n⛔ ${e.message}`);
        console.error('   已立即熔断，后续请求全部取消。进度已保存，可稍后断点续跑。');
        return summary(stat, noSubParts, poisonedParts, t0, args, manifestPath, 5, bucket);
      }
      console.log(`${tag}  ${p.part}  ✗ ${e.message}`);
      rec.status = 'skip'; rec.reason = e.message;
      stat.skip++; save();
      continue;
    }

    // 真·无字幕：所有尝试返回的都是空清单
    if (!vr.pick && vr.poisoned === 0) {
      console.log(`${tag}  ${p.part}  ○ 无字幕`);
      rec.status = 'no_sub';
      stat.no_sub++; noSubParts.push(p.page); save();
      continue;
    }

    // 用尽重试仍被投毒：接口持续返回其它视频的字幕
    if (!vr.pick) {
      console.log(`${tag}  ${p.part}  ! 重试 ${vr.attempts} 次全被投毒（拿到的是其它视频的字幕）`);
      rec.status = 'poisoned';
      rec.reason = `${vr.attempts} 次全被投毒`;
      stat.poisoned++; poisonedParts.push(p.page); save();
      continue;
    }

    const pick = vr.pick;

    // 扫描模式：只记录可用性，不下载、不额外发 CDN 请求
    if (args.scan) {
      console.log(`${tag}  ${p.part}  ● 有字幕 [${pick.lan}]  校验:第${vr.attempts}次命中`);
      rec.status = 'has_sub';
      rec.lang = pick.lan;
      rec.lang_doc = pick.lan_doc;
      rec.verifyAttempts = vr.attempts;
      rec.poisoned = vr.poisoned;
      stat.has_sub++; save();
      continue;
    }

    await sleep(args.interval);

    try {
      const body = await downloadSubtitle(pick.subtitle_url, p.referer);
      const { dir, base } = targetOutput(outDir, info.title, p, isSeason);
      const files = writeSrt(dir, base, body, p.url);
      rec.status = 'ok';
      rec.lang = pick.lan; rec.lang_doc = pick.lan_doc;
      rec.count = files.count;
      // 一律存正斜杠相对路径：manifest 可移植，索引里的链接也不会被 encodeURI 编成 %5C
      rec.srt = path.relative(outDir, files.srtPath).split(path.sep).join('/');
      rec.verifyAttempts = vr.attempts;
      delete rec.reason;
      console.log(`${tag}  ${p.part}  ✓ ${pick.lan_doc} ${files.count} 条`);
      stat.ok++; save();
    } catch (e) {
      if (e.name === 'RiskControlError') {
        rec.status = 'aborted'; rec.reason = e.message;
        save();
        console.error(`\n⛔ ${e.message}`);
        console.error('   已立即熔断，后续请求全部取消。进度已保存，可稍后断点续跑。');
        return summary(stat, noSubParts, poisonedParts, t0, args, manifestPath, 5, bucket);
      }
      console.log(`${tag}  ${p.part}  ✗ 下载失败: ${e.message}`);
      rec.status = 'skip'; rec.reason = e.message;
      stat.skip++; save();
    }
  }

  backfillUrls(bucket);
  writeIndex(outDir, bucket, bvid);

  // 单分P 模式：没拿到就算失败（退出码 6）
  if (single && (bucket.parts[args.p] || {}).status !== 'ok') {
    return summary(stat, noSubParts, poisonedParts, t0, args, manifestPath, 6, bucket);
  }
  return summary(stat, noSubParts, poisonedParts, t0, args, manifestPath, 0, bucket);
}

/** 兼容旧 manifest：给缺 url 的记录补上来源链接（老版本没写这个字段）。
 *  多分P 与合集的判别不依赖 bucket.kind，只看记录：所有记录共用同一个 bvid
 *  且不止一条 → 是多分P（链接必须带 ?p=N）；bvid 各异 → 是合集（每集独立视频）。 */
function backfillUrls(bucket) {
  const rows = Object.values(bucket.parts || {});
  if (!rows.length) return;
  const distinct = new Set(rows.map(r => r.bvid).filter(Boolean));
  const multi = distinct.size === 1 && rows.length > 1;
  for (const r of rows) {
    if (r.url || !r.bvid) continue;
    r.url = multi
      ? `https://www.bilibili.com/video/${r.bvid}/?p=${r.page}`
      : `https://www.bilibili.com/video/${r.bvid}/`;
  }
}

/** 写索引表（链 SRT 与本集视频） */
function writeIndex(outDir, bucket, bvid) {
  const rows = Object.values(bucket.parts).sort((a, b) => a.page - b.page);
  const ok = rows.filter(r => r.status === 'ok');
  const LABEL = { ok: '已下载', has_sub: '有字幕·未下载', no_sub: '无字幕', skip: '失败', poisoned: '被投毒', aborted: '被熔断' };
  const lines = [
    `# ${bucket.title} — 字幕索引`,
    '',
    `- 类型：${bucket.kind === 'season' ? '合集（ugc_season）' : '多分P 视频'}`,
    `- 入口 BV 号：${bvid}`,
    `- 更新于：${new Date().toISOString()}`,
    `- 已下载：${ok.length} / 已记录：${rows.length}`,
    '',
    '| 序号 | 章节 | 标题 | 状态 | 语言 | 条数 | 视频 | 文件 |',
    '|---|---|---|---|---|---|---|---|',
    ...rows.map(r => `| ${r.page} | ${r.section || '—'} | ${r.part} | ${LABEL[r.status] || r.status} | ${r.lang_doc || '—'} | ${r.count || '—'} | ${r.url ? `[视频](${r.url})` : '—'} | ${r.srt ? `[srt](${encodeURI(r.srt)})` : '—'} |`)
  ];
  fs.writeFileSync(path.join(outDir, '_index.md'), lines.join('\n'), 'utf8');
}

function summary(stat, noSubParts, poisonedParts, t0, args, manifestPath, code, bucket) {
  const secs = (Date.now() - t0) / 1000;

  // 累计状态（含历史断点记录）
  const cum = { has_sub: [], no_sub: [], ok: [], poisoned: [] };
  for (const r of Object.values((bucket && bucket.parts) || {})) {
    if (cum[r.status]) cum[r.status].push(r.page);
  }
  for (const k in cum) cum[k].sort((a, b) => a - b);

  console.log(`\n${'─'.repeat(52)}`);
  console.log(`汇总（本次）：成功 ${stat.ok}   有字幕未下载 ${stat.has_sub}   无字幕 ${stat.no_sub}   被投毒 ${stat.poisoned}   其它失败 ${stat.skip}`);
  console.log(`累计记录：已下载 ${cum.ok.length}   有字幕待下载 ${cum.has_sub.length}   无字幕 ${cum.no_sub.length}   被投毒 ${cum.poisoned.length}`);
  console.log(`实发请求: ${requestCount}（其中带登录态 ${authedRequestCount}）   耗时: ${fmtTime(secs)}`);
  if (poisonedParts.length) console.log(`本次被投毒: ${poisonedParts.map(n => '#' + n).join(', ')}`);
  if (noSubParts.length) console.log(`本次无字幕: ${noSubParts.map(n => '#' + n).join(', ')}`);
  console.log(`进度文件: ${manifestPath}`);
  console.log(`${'─'.repeat(52)}`);

  const unit = args._unit || '分P';
  const confirmed = cum.has_sub.length + cum.ok.length;
  if (args.scan && cum.has_sub.length) {
    console.log(`✓ 结论：有字幕。去掉 --scan 重跑即可下载全部 ${cum.has_sub.length} 个${unit}。`);
    if (cum.poisoned.length) {
      console.log(`  注意：另有 ${cum.poisoned.length} 个${unit}被投毒，真实情况未定 —— 重跑时才会确认（可能还有更多有字幕的）。`);
    }
  } else if (args.scan && !confirmed && cum.poisoned.length) {
    console.log(`? 结论：暂未确认任何字幕，且有 ${cum.poisoned.length} 个${unit}全被投毒 —— 状态未定，被投毒≠无字幕。`);
    console.log('  建议：隔一段时间重跑同一条 --scan 命令；已确认的会跳过，被投毒的会重新探测。');
  } else if (args.scan && !confirmed) {
    console.log(`✗ 结论：扫描范围内没有任何${unit}带字幕 —— 这不是凭据问题，是视频本身没有。`);
  }
  if (code === 0 && stat.ok > 0) {
    console.log('✓ 断点续跑：再次执行同一命令即可，已成功的分P 不会重复请求。');
  }
  if (code === 5) {
    console.log('⛔ 已因风控熔断。请停手，隔几小时再重跑，并考虑加大 --interval。');
  }
  if (code === 6) {
    console.log(`✗ 指定${unit} 未拿到（无字幕或被投毒）。可稍后重跑同一命令再试。`);
  }
  process.exit(code);
}

main().catch(e => {
  console.error('\n✗ 意外中止:', e.message);
  console.error(`  累计请求数: ${requestCount}`);
  process.exit(e.name === 'RiskControlError' ? 5 : 1);
});
