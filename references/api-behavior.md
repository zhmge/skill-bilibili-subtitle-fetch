# Bilibili subtitle API behaviour

What the endpoints actually do, and why the fetch script is shaped the way it is.
Read this before changing request or verification logic.

## The three requests

| # | Endpoint | Needs SESSDATA | Returns |
|---|---|---|---|
| 1 | `GET api.bilibili.com/x/web-interface/view?bvid=<BV>` | no | `aid`, title, `pages[]` (multi-part) **and** `ugc_season` (collection) |
| 2 | `GET api.bilibili.com/x/player/v2?bvid=<BV>&cid=<cid>` | **yes** | `data.subtitle.subtitles[]`, each with `lan`, `lan_doc`, `subtitle_url` |
| 3 | `GET <subtitle_url>` (on `aisubtitle.hdslb.com`) | no | `{ body: [{ from, to, content }, ...] }` |

Request 1 runs **once** and covers every target — all parts of a multi-part video,
or all episodes of a collection. That is why the per-target cost floor is two
requests, not three.

Request 3 points at a public CDN. The credential is deliberately **not** sent
there; the script only attaches `Cookie` when the host is `api.bilibili.com`.
Keep it that way.

## Collections (合集) — one separate video per episode

A `合集` is not a set of parts. It is a set of **separate videos**, each with its
own `bvid`, `cid` and `aid`. The `view` response of any member video carries the
whole structure:

```
data.ugc_season
  .id, .title
  .sections[]         ← chapters, e.g. 线性表 / 树 / 图 / 查找 / 排序 / 常见题型
     .title
     .episodes[]      ← { bvid, cid, aid, title } — one separate video each
```

The same three requests apply, but **per episode, with that episode's own
`bvid` / `cid` / `aid`**. There is no shared cid space to iterate over.

Cross-check the count before committing to a long run:
`GET api.bilibili.com/x/polymer/web-space/seasons_archives_list?mid=<mid>&season_id=<sid>&sort_reverse=false&page_num=1&page_size=100`
returns the same episodes plus `page.total`. If the two disagree, the
`ugc_season` block was truncated.

**The trap:** on a collection member, `data.pages` has exactly **one** entry. A
script that reads only `pages` fetches 1 episode out of 68 and exits `0`. Nothing
errors, no field is missing — the output is simply tiny. Verify the count, not
the exit code.

## Anonymously, request 2 returns an empty list

Not an error — `code=0`, `subtitles: []`, `lan: ""`. Indistinguishable from a
video that genuinely has no subtitles. Consequences:

- A credential is mandatory, and its absence must be an error, not an empty result.
  The script throws if the list is requested without a loaded credential, and
  refuses to start at all when `BILI_SESSDATA` is empty (exit code 3, zero requests).
- If you ever see `实发请求: N（其中带登录态 0）` in a run, the credential never
  went out. Every "no subtitle" in that run is meaningless. This exact bug —
  reading the credential but never putting it in the request headers — is easy to
  write and produces a completely wrong conclusion.

## Request 2 poisons its responses

To non-browser clients, `player/v2` returns **another video's subtitle entries**
at random. The response is well-formed: `code=0`, a real `auth_key`, plausible
`lan`/`lan_doc`. Only the content belongs to a different video. Observed share:
roughly **50%–75%** of responses. The same `cid` requested repeatedly yields
subtitles from several different videos.

Tried and **ineffective** — none of these fix it:

| Attempt | Result |
|---|---|
| Full Chrome/Edge UA + `Referer` + `Origin` | no effect |
| Adding `buvid3` / `buvid4` device-fingerprint cookies | no effect |
| Cache-busting timestamp parameter | no effect |
| Valid SESSDATA, including a paid membership account | no effect |

The likely discriminator is the TLS fingerprint (Node's `https` stack is not
Chrome's JA3/JA4), or HTTP/1.1 vs HTTP/2. Nothing available to a plain HTTP
client changes it.

**Accept it and verify instead.**

## The verification key

A correct subtitle URL has this shape:

```
//aisubtitle.hdslb.com/bfs/ai_subtitle/prod/<aid><cid><hash>?auth_key=...
                                            └─ aid ──┘└─ cid ─┘
```

The path segment after `/prod/` **starts with the video's `aid` immediately
followed by the part's `cid`**. That prefix is the whole test: if it does not
match, the response is someone else's subtitle and must be discarded.

In a collection every episode has its own `aid`+`cid` pair, so the test must run
with **that episode's** pair. The rule itself needs no change — which is why the
same verification code serves both shapes.

Two properties make this cheap:

- The check runs on the `player/v2` response itself, so a poisoned response
  **never triggers a CDN download** — a retry costs exactly one request.
- It needs nothing but `aid` and `cid`, both already known.

The script retries up to `MAX_VERIFY_ATTEMPTS` (8) times, 800 ms apart. Empirically
most parts hit on attempt 1; a few take 3–4. A part that exhausts all 8 attempts
is recorded as `poisoned`, not as missing.

Observed on an 8-episode sample spread across a 68-episode collection: hits on
attempts 2, 1, 1, 3, 1, 5, 2, 3 — mean ≈ 2.25, worst case 5 of 8. Budget roughly
`2.5 × targets + targets` requests for a collection run.

**A failed part is usually a transient one.** In the reference run, 10 of 86 parts
exhausted all 8 attempts; re-running the same command the next minute, all 10 hit
on the first attempt. Re-run before investigating.

A third failure shape exists: `subtitle_url` present but **empty string**. Treat
it as a verification failure and retry — the same code path already handles it.

## Empty list, poisoning, and actual existence

Three answers hide behind request 2, and only two of them are evidence:

- An **own-hit** (path prefix `<aid><cid>`) is the only "yes": this part really
  has subtitles.
- An **empty list** (`subtitles: []`) is the only "no": as close as the endpoint
  gets to "this video has no subtitles".
- A **poisoned response** is evidence about *nothing* for this part. It is
  undetermined — not yes, not no. Reading a poisoned-heavy run as "the course
  has no subtitles" is the most expensive misread of this API.

When a run comes back all-poisoned (or a poisoned/empty mix), existence is still
open. Two checks narrow it down:

**Cross-stack probe.** Node (OpenSSL TLS) and curl.exe (Schannel TLS) present
different TLS fingerprints, and Bilibili's classifier can treat the same cid
differently per stack. In the reference case, one part was poisoned on every
Node attempt while curl consistently got an empty list, and two other parts were
the exact opposite. But curl gets poisoned too — parts returned another video's
subtitles through curl as well. Only when *both* stacks return an empty list for
a cid is "no subtitles" well-supported.

**Asset age.** AI subtitles (`ai-zh`) are generated per video asset, and in the
reference case they existed only for assets re-encoded in a 2023-12 ~ 2024-06
window. A course uploaded in 2019 whose assets were never re-encoded has no AI
subtitles on any part, no matter how many retries. `pages[].ctime` comes free
with the `view` response, so this can be checked before spending a single
player/v2 request.

Reference case in full: a 314-part course from 2019. Node produced 800+
responses across the whole range without a single own-hit; a curl sweep of every
part (two probes each, 628 requests) agreed: exactly 4 parts (P1/P2/P3/P103)
have AI subtitles — all four inside the re-encode window — and 310 parts have
none, matching ground truth from the user's real-browser extension. Storm-level
poisoning (~50–75%, peaks ~92%) delayed that answer but did not change it.

## Which subtitle to pick

`pickSubtitle` prefers `zh-CN` (human-made) → `ai-zh` (AI-generated) → any `zh*`
→ the first entry. Many Chinese courses only have `ai-zh`; it is auto-transcribed
from the audio by Bilibili, and quality is generally good enough for reading, but
it contains speech-recognition errors. Do not present AI subtitles as verbatim.

## SESSDATA

- A cookie, not a token from an endpoint. Only way to get it is to read it out of
  a logged-in browser: F12 → **Application** → **Cookies** →
  `https://www.bilibili.com` → `SESSDATA` → copy Value.
- **HttpOnly**, so `document.cookie` in the page console will not show it.
- Browsers encrypt the on-disk cookie store (Chrome/Edge App-Bound Encryption), so
  it cannot be decrypted from the SQLite file either. Manual copy is the only path.
- Long-lived — typically weeks to months — which is exactly why it must not be
  written to a file.
- Treat it as a bearer credential: whoever holds it acts as that account.
  If it leaks, the user should end sessions for all devices in Bilibili's account
  security settings.
- `GET api.bilibili.com/x/web-interface/nav` with the credential confirms it is
  live (`data.isLogin === true`, plus `uname`/`mid`). Useful when distinguishing
  a bad credential from a video with no subtitles.

## Known limits

- Only works where Bilibili has subtitles. Videos with none (including
  `allow_submit: false` videos, which are often AI-subtitle-less) stay empty
  through every retry.
- AI subtitles (`ai-zh`, `type: AISubtitle`) carry transcription errors.
- Multi-speaker, heavily edited, or music-heavy videos produce poor AI subtitles.
- Fetching subtitles for personal study is one thing; bulk scraping or
  redistribution runs into Bilibili's terms of service.
