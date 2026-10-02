---
name: bilibili-subtitle-fetch
description: Fetch Bilibili (B站) subtitles as SRT files. Handles both a multi-part video and a 合集 (ugc_season — a collection of separate videos, such as a whole course series). Use when the user wants the subtitles or captions of a Bilibili video or collection written to disk for later reading or processing. Requires a logged-in SESSDATA value from the user, since Bilibili returns an empty subtitle list to anonymous requests. Do not use for other video platforms, for downloading the video or audio itself, or for turning subtitles into notes or summaries.
---

# Bilibili Subtitle Fetch

Download Bilibili subtitles and write them as `.srt`. Two target shapes are
supported, and the script tells them apart from the `view` response:

- **multi-part video** — one BV id, many parts (`pages`); output stays flat;
- **合集 / ugc_season** — a collection of separate videos, e.g. a course series;
  output is grouped into one subfolder per chapter.

The work is done by `scripts/fetch_subtitles.js` — a zero-dependency Node script.
Do not rewrite it, and do not fetch subtitles by any other route (page scraping,
the browser extension, a headless browser): the script already carries the
handling that a naive request gets wrong.

## Use / do not use

Use when: the user gives a Bilibili video (BV id or URL) and wants its subtitle
text — a single part, a range, every part of a multi-part video, or every video
inside a 合集.

Do not use for: other platforms; downloading video, audio, or danmaku; user
comments; turning subtitles into notes (a separate skill does that); or any
request where the user only wants a summary of what the video says.

## Workflow

**1. Confirm three things with the user before running anything.** Do not guess
any of them:

- the video — BV id or full URL;
- **where the `.srt` files should go** (the script requires `--out`; there is no default);
- the scope — all, a range, or one item.

For a 合集 the target count is **not** the video's part count: a collection's
`pages` array holds exactly one entry while the real targets sit in
`ugc_season.sections[].episodes[]`. The script handles the switch itself, and
prints the chapter breakdown when it starts — compare that count against what the
user said to expect before letting a long run proceed.

Scope is explicit, never inferred by the script except in one case: a `?p=N` in
the URL selects that single item **unless** you pass a scope flag. So when the
user pastes a link and then says "actually, all of them", you must pass `--all`
— omitting the flags would silently fetch only the item in the URL. Collection
links usually carry no `?p=`, so the default (everything) applies.

For a multi-part series or a 合集 this is usually hundreds of requests over
several minutes; say the estimated figure out loud before starting (the script
prints it too).

**2. Get the SESSDATA value from the user.** It is required. Ask them to copy it
from a logged-in browser: `bilibili.com` → F12 → **Application** → **Cookies** →
`https://www.bilibili.com` → `SESSDATA` → copy the Value. Explain plainly that
they must do it by hand: the cookie is HttpOnly, so page scripts cannot read it.

**3. Probe before committing** whenever there is more than a handful of targets
(multi-part video or 合集). This costs one request per sampled item and answers
"is a full run worth it":

```bash
BILI_SESSDATA="<value>" node "<skill-dir>/scripts/fetch_subtitles.js" "<URL>" \
  --out "<dir>" --scan --sample 5
```

If the probe reports no subtitles anywhere, stop and tell the user — no amount
of retrying will produce subtitles that do not exist.

**4. Fetch.** Resolve `<skill-dir>` to wherever this skill actually lives; do not
assume the working directory is the skill directory.

```bash
BILI_SESSDATA="<value>" node "<skill-dir>/scripts/fetch_subtitles.js" "<URL>" \
  --out "<dir>"
```

One item: `--p 18`. A range: `--from 10 --to 20`. Everything: `--all`.
Run `... --help` for the full option list. On Windows quote both paths; Chinese
file names are the norm here.

For a 合集, numbering is a single running index across the whole collection in
chapter order (chapter 1's episodes first, then chapter 2's, and so on) — so
`--from 6 --to 16` means "the 树 chapter". The script prints the chapter
breakdown before it starts, which is how you map user intent onto those numbers.

The run is deliberately slow (serial, 3 s apart) and prints progress per part.
If it is long, run it in the background and report when it finishes.

**5. Report.** Tell the user how many parts were obtained out of how many, where
the `.srt` files are, and which parts came back empty or need a re-run.

## Non-negotiables

- **The credential never touches disk.** Pass SESSDATA as the `BILI_SESSDATA`
  environment variable only. Never write it to a file, never echo it back, and do
  not repeat it in later commands. Note that it will be visible in the command
  text of the run itself — mention that once rather than pretending otherwise.
- **Do not speed it up.** The serial pacing and the request interval are the
  cost of not being rate-limited. Never raise concurrency or lower `--interval`.
- **On a risk-control stop, stop.** Exit code 5 means Bilibili refused the
  request. Do not retry immediately; wait hours and offer a larger `--interval`.
- **Never conclude "this video has no subtitles" from an empty list** without
  first confirming the credential was actually loaded — the run prints
  `登录态: 已装载` and `实发请求: N（其中带登录态 M）`. If `M` is 0, the credential
  never went out and every result is meaningless.
- **A part that failed is not a part that is missing.** Parts failing verification
  and parts with genuinely no subtitles are reported differently; keep them apart.
- **`.srt` is the only deliverable.** Do not add `.txt`, do not "helpfully" merge
  parts into one plain-text file.
- **Keep the source link as line 1 of every `.srt`**, followed by a blank line.
  It is what lets a downstream skill produce correct jump links. Do not strip it,
  do not move it into a comment, and do not drop the blank line after it.

## Output

Into `<dir>`:

| File | What it is |
|---|---|
| `<视频标题>_P<n>_<分P名>.srt` | multi-part video: the deliverable, one per part, flat in `<dir>` |
| `<NN_章节名>/<NN_标题>.srt` | 合集: one subfolder per chapter, one file per episode |
| `_index.md` | table of every item: chapter, status, language, line count, link to the video and to its `.srt` |
| `_manifest.json` | progress ledger — this is what makes a re-run cheap |

**Every `.srt` starts with its own source link.** Line 1 is the bare URL of that
part (or of that episode, for a 合集), line 2 is blank, and the normal `1`-indexed
cues follow. Downstream skills read this line to build jump-to-timestamp links
instead of guessing a video id out of the file name — so a file name needs no BV
id at all.

Line 2 must stay blank. Parsers that split SRT into blank-line-separated blocks
would otherwise glue the link onto the first cue and silently drop it.

For a multi-part video the link carries `?p=N`, because without it every part
would jump to the default part. A 合集 episode does not: each episode is its own
video, so its own bare BV id is already the full address.

A 合集 therefore lands as a small chapter tree; a multi-part video stays flat.
Both shapes can share one `<dir>` — the ledger keys them separately.

Re-running the same command skips parts already marked `ok` and retries only the
rest. After a run where some parts were poisoned (see below), **just run the same
command again**: it is normal for those parts to succeed on the next pass.

## Exit codes

`0` success · `2` bad arguments · `3` missing credential (no request was sent) ·
`5` risk control hit, aborted · `6` the requested single part was not obtained.

## Collections (合集)

A Bilibili 合集 is **not** a multi-part video. Each episode is a separate video
with its own `bvid`, `cid` and `aid`. The script reads
`ugc_season.sections[].episodes[]` from the same single `view` call and requests
each episode with **its own** bvid, so the poisoning check (`<aid><cid>` path
prefix) stays valid per episode.

This is why a collection's own `pages` array must never be used as the target
list: it holds exactly one entry, so a `pages`-only script reports success while
having fetched a single video out of 68. There is no error to catch — only a
suspiciously small output. Check the printed chapter breakdown for that.

## Why the script verifies every response

Bilibili's `player/v2` endpoint returns **another video's subtitles** to
non-browser clients at random — a valid-looking response, `code=0`, correct
structure, wrong content. Roughly half to three quarters of responses. The script
detects this by checking that the subtitle path starts with `<aid><cid>` and
retries until it matches. This is why the fetch is not a simple two-request loop,
and why a re-run can succeed where a part previously failed.

Do not "simplify" this away. Read `references/api-behavior.md` before touching
the request or verification logic.

## References

- `references/api-behavior.md` — read when working on the request/verification
  logic, or when the user asks why subtitles come back empty, wrong, or missing.
  Covers the poisoning behaviour, the endpoints and what each one requires, and
  how SESSDATA is obtained and expires.
- `references/troubleshooting.md` — read when a run fails or returns something
  unexpected. How to tell "no subtitles" from "poisoned" from "rate-limited" from
  "network", what to do about each, and how resumption works.
