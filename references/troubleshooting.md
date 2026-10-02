# Troubleshooting a run

Read this when a run fails, stalls, or returns something unexpected.

## Tell the failure shapes apart

Every part ends in exactly one state. They call for different responses:

| State | Reported as | Means | What to do |
|---|---|---|---|
| `ok` | `✓ <语言> N 条` | subtitle downloaded | nothing |
| `has_sub` | `● 有字幕` | probe only (`--scan`); not downloaded | drop `--scan` and re-run |
| `no_sub` | `○ 无字幕` | every attempt returned an empty list | this part genuinely has no subtitles; not fixable |
| `poisoned` | `! 重试 8 次全被投毒` | verification never matched | **just re-run the same command** |
| `skip` | `✗ <原因>` | CDN failure, HTTP error, bad JSON | re-run; investigate only if it repeats |
| `aborted` | `⛔ 命中风控` | risk control stopped the run | stop, wait, re-run with a larger interval |

`no_sub` and `poisoned` look similar in the summary but are opposites: one means
nothing exists to fetch, the other means the fetch was intercepted. Never report
a `poisoned` part to the user as "this part has no subtitles".

## Before believing any "no subtitles" result

Check the credential actually went out. The run prints:

```
登录态: 已装载（SESSDATA 长度 N，仅发给 api.bilibili.com）
...
实发请求: 210（其中带登录态 140）   耗时: 9分30秒
```

If `带登录态` is 0, or the `登录态` line is missing, the credential never reached
the request and **every** empty result in that run is meaningless. Fix that first,
then re-run. This failure is silent otherwise — an empty subtitle list is a
perfectly valid response.

Cheap way to separate "bad credential" from "video has no subtitles": call
`api.bilibili.com/x/web-interface/nav` with the credential. `data.isLogin === true`
means the credential is fine and the video really is subtitle-less.

## Risk control (exit code 5)

Triggered by codes `-352`, `-412`, `-509`, `-799`. The script aborts on the spot
and saves progress.

1. **Stop. Do not re-run immediately.** Retrying into rate limiting is how a
   temporary limit becomes a lasting one.
2. Wait hours, ideally to the next day.
3. Re-run with a wider gap: `--interval 6000` (or higher).
4. Completed parts are skipped automatically, so the re-run is cheap.

Everything the script does to stay under the radar is load-bearing: strict
serial requests, no concurrency, no retry storms, one `view` call per video,
verification done before the CDN download. Do not tune any of it for speed.

Two sanity figures:

- a **multi-part** course, 86 parts → **376 requests over ~12 minutes**;
- a **合集**, 68 separate videos → **~273 requests over ~14 minutes** (the figure
  printed up front; poisoning retries dominate the request count).

Both are fewer requests than scrolling the same material by hand in a browser,
which fires thousands. Neither run triggered risk control.

## Resumption

`_manifest.json` in the output directory is a per-video ledger of every part's
state. Re-running the same command:

- skips parts with status `ok`;
- retries everything else — `poisoned`, `no_sub`, `skip`, `aborted`.

It is keyed by BV id for a video, and by `season:<id>` for a 合集, so one output
directory can hold several videos and collections without their progress colliding.

`--force` ignores the ledger and re-fetches the whole requested range. Only use it
when you actually want to overwrite good files.

Deleting `_manifest.json` is safe but costly: the next run re-fetches everything
and re-spends the requests.

## A collection run that produced only one file

The signature of reading `pages` on a 合集: exit code `0`, no errors, and a
single `.srt` where you expected dozens. A collection member's `pages` array has
exactly one entry, so a `pages`-only path "succeeds" while fetching 1 of 68.

Check the header printed before the run starts:

```
类型: 合集（ugc_season id=3102780）  6 个章节 / 68 集
      01  线性表  5 集
      02  树  11 集
      ...
```

If instead it reads `类型: 多分P 视频  共 1 个分P`, the `ugc_season` block was not
picked up. Cross-check the real episode count with `seasons_archives_list` — see
`api-behavior.md`.

## Network and proxy

- If the machine sets `HTTP_PROXY`/`HTTPS_PROXY`, Node's core `https` module does
  **not** read them — the script connects directly. That is normally what you want
  for a China-hosted service: a direct connection is faster and its exit IP looks
  like an ordinary domestic user.
- If direct access fails and a proxy is genuinely required, that is an environment
  problem, not a script option — do not add proxy handling to the script.
- Probe connectivity independently before blaming the credential, e.g. call the
  `view` endpoint once. A single timeout is usually a transient blip; retry before
  drawing conclusions.

## Empty or short output for a part

- A part whose SRT has very few cues is usually a short clip, not a failure.
  Check the line count against the part's duration. Subtract the first two lines
  (the source link and the blank line after it) before comparing — they are not
  cues, and a line count that ignores them will look off by two.
- AI subtitles are segmented into individual cues; hundreds of cues for a
  20-minute lecture is normal.

## What not to do

- Do not fall back to scraping the page, driving a headless browser, or using the
  browser extension. Those routes avoid the poisoning problem but bring far larger
  costs — full browser profile access, or a page-DOM dependency that breaks on any
  site change.
- Do not lower `--interval` to finish sooner.
- Do not add a `.txt` export. SRT is the only deliverable.
- Do not strip or relocate the source link on line 1 of a `.srt`, and do not drop
  the blank line that follows it. Downstream skills depend on both; removing the
  blank line makes block-splitting parsers drop the first cue silently, which
  looks like a short clip rather than a bug.
