# FB Ads Command Center

A single Chrome extension merging two tools, plus a **Page Report** tab:

- **FB Ad Spend Analyzer Pro** — page-wise spend breakdown, creative winner
  finder, PDF export
- **FB Ads Smart Controller** — bulk pause/resume of active ads with page
  filtering, batch processing, CSV/JSON export

Both talked to the official Facebook **Graph API** using a token you paste
in yourself — merging them kept that model unchanged. Nothing here reads
cookies, session data, or anything from the Facebook page itself.

## 📄 Page Report tab (new)

Tick one or more ad accounts (results are merged), tick one or more Pages, choose a date range and click
**Get Page Report**. You get every ad that ran for those pages:

- total spent (in the ad account's real currency, e.g. USD / BDT)
- **days with spend**, first spend date, last spend date
- per ad: campaign, ad set, status, created date, spend, impressions,
  clicks, CPC, CTR, CPM, average spend per active day
- download: **CSV (Ads)**, **CSV (Daily, day-by-day spend)**, **PDF**

Notes:
- "Max" date range = last 3 years (Facebook only allows ~37 months of
  day-by-day data).
- "Only ads that spent money" hides ads with zero spend (untick to see all).
- The last report is saved, so it is still there when you reopen the popup.
- Ads are matched to a Page via the ad creative's Page ID.

## Why merge this way

**One token, one account list.** The Analyzer required manually typing
comma-separated ad account IDs; the Controller validated a token and
auto-discovered accounts with names via `/me/adaccounts`. The merged app
uses the Controller's approach everywhere — you paste a token once, and
both tabs share the resulting account list. Less typing, fewer typos.

**One page-name cache.** Both tools independently resolved Facebook Page
IDs to names (Analyzer via `/me/accounts` + per-ad lookups, Controller via
`promotable_pages` + `/me/accounts`). These are now one shared cache in
`chrome.storage.local` (`pageMap`), populated by whichever tab runs first
and reused by the other — so you don't pay for the same lookup twice.

**Two tabs, not two extensions.** Analyze (reporting) and Control
(pause/resume) are different mental modes, so they stay as separate tabs
rather than a single crowded screen — but they're one popup, one token
entry, one settings surface.

**Kept intact, not rewritten:**
- The Controller's batch engine (50 ops/batch, 1.2s spacing, 3 retries,
  rate-limit backoff, per-operation 200-OK verification) — this logic was
  already handling Facebook's batch API edge cases correctly, so it was
  ported as-is into `background.js`.
- The Analyzer's insights pipeline (ad-level insights → creative lookup →
  page-id resolution → grouping) — also ported as-is, just wrapped in a
  message handler instead of running inline in a single popup script.

**Moved to the background script.** Both original tools ran their API
calls directly in `popup.js`. Because the popup document is destroyed the
moment it loses focus, any in-flight request in the old Analyzer would
silently die if you clicked away mid-fetch. All network logic now lives in
`background.js` (a persistent-enough service worker) and the popup just
sends messages and renders results — safer for slower multi-account fetches.

## Structure

```
manifest.json          — MV3 config, single service worker, no cookies/scripting permissions
background.js           — all Graph API calls: token validation, page discovery,
                           insights/spend engine, batch pause/resume engine
popup/index.html         — tabbed UI: shared token card + Analyze + Page Report + Control tabs
popup/style.css          — merged visual identity (Analyzer's card layout,
                           Controller's dark log panel and progress bar)
popup/popup.js            — tab switching, rendering, PDF/CSV/JSON export
icon16/48/128.png          — bar-chart + pause icon representing both halves
```

## Setup

1. Get a token from [Graph API Explorer](https://developers.facebook.com/tools/explorer/)
   with `ads_read`, `ads_management`, `business_management`,
   `pages_read_engagement` permissions
2. `chrome://extensions` → Developer mode → Load unpacked → select this folder
3. Open the popup, paste the token, click **Save & Validate**
4. **Analyze tab:** tick one or more ad accounts, pick a date range, Fetch & Analyze
5. **Control tab:** pick one ad account, optionally tick specific pages to
   target, then Smart Pause / Smart Resume

## Notes

- Tokens and account lists live in `chrome.storage.sync`; the page-name
  cache lives in `chrome.storage.local`. Nothing leaves your browser except
  calls to `graph.facebook.com`.
- Short-lived tokens expire — use a long-lived token if you don't want to
  re-paste it often.
- Facebook UI/API field names change over time; if a request starts
  failing, check the Graph API version pinned at the top of `background.js`
  (`GRAPH_VERSION`) against Facebook's current docs.
