// ============================================================================
// FB Ads Command Center - background.js
// Merges two engines behind one message API:
//   1. Insights/Spend Analysis engine   (from "FB Ad Spend Analyzer Pro")
//   2. Batch Pause/Resume engine        (from "FB Ads Smart Controller")
// Both talk to https://graph.facebook.com using a token the user pastes in —
// no cookies, no session data, nothing read from the Facebook page itself.
// ============================================================================

const GRAPH_VERSION = "v20.0";
const BATCH_SIZE = 50;
const BATCH_DELAY_MS = 1200;
const MAX_RETRIES = 3;

// ---------------------------------------------------------------------------
// Shared: page-name cache (used by both the Analyze and Control tabs so we
// only ever look a given Page ID up once, no matter which tab found it).
// ---------------------------------------------------------------------------

async function getPageCache() {
  const { pageMap } = await chrome.storage.local.get("pageMap");
  return pageMap || {};
}

async function mergePageCache(newEntries) {
  const current = await getPageCache();
  const merged = { ...current, ...newEntries };
  await chrome.storage.local.set({ pageMap: merged });
  return merged;
}

// ---------------------------------------------------------------------------
// Shared: small fetch helper with basic retry on transient/rate-limit errors
// ---------------------------------------------------------------------------

async function graphFetch(url, options, retries = MAX_RETRIES) {
  let attempt = 0;
  let lastErr;
  while (attempt < retries) {
    try {
      const res = await fetch(url, options);
      const json = await res.json();
      if (json.error) {
        const isRateLimit = json.error.code === 4 || json.error.code === 80004 || json.error.code === 17;
        if (isRateLimit && attempt < retries - 1) {
          await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
          attempt++;
          continue;
        }
        throw new Error(json.error.message);
      }
      return json;
    } catch (e) {
      lastErr = e;
      attempt++;
      if (attempt >= retries) throw lastErr;
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Engine 1: Token validation + ad account discovery (from Smart Controller)
// ---------------------------------------------------------------------------

async function validateToken(token) {
  const json = await graphFetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/me/adaccounts?fields=id,account_id,name,account_status&limit=200&access_token=${encodeURIComponent(token)}`
  );
  return json.data || [];
}

// ---------------------------------------------------------------------------
// Engine 1: Page discovery for a given ad account (from Smart Controller,
// generalized) — tries promotable_pages first, falls back to me/accounts.
// Also seeds the shared page-name cache.
// ---------------------------------------------------------------------------

async function fetchPagesForAccount(token, adAccountId) {
  const pagesMap = new Map();
  const urls = [
    `https://graph.facebook.com/${GRAPH_VERSION}/act_${adAccountId}/promotable_pages?fields=id,name,fan_count&limit=100&access_token=${encodeURIComponent(token)}`,
    `https://graph.facebook.com/${GRAPH_VERSION}/me/accounts?fields=id,name,fan_count,category&limit=200&access_token=${encodeURIComponent(token)}`
  ];
  for (const url of urls) {
    try {
      const json = await graphFetch(url);
      (json.data || []).forEach(p => pagesMap.set(p.id, p));
    } catch (e) {
      // one source failing is fine, we still try the other
    }
  }
  const pages = Array.from(pagesMap.values());
  const cacheEntries = {};
  pages.forEach(p => { cacheEntries[p.id] = p.name; });
  await mergePageCache(cacheEntries);
  return pages;
}

// ---------------------------------------------------------------------------
// Engine 2: Spend/Insights analysis (ported from Spend Analyzer Pro)
// Supports multiple ad accounts at once, page-level or creative-level view.
// ---------------------------------------------------------------------------

async function fetchInsights({ token, accountIds, preset, since, until }) {
  const presetMap = {
    last_30d: "last_30d",
    last_90d: "last_90d",
    last_365d: "last_year",
    lifetime: "maximum",
    last_year: "last_year"
  };
  const fbPreset = presetMap[preset] || "last_90d";

  let allAds = [];
  for (const actId of accountIds) {
    let url = `https://graph.facebook.com/${GRAPH_VERSION}/act_${actId}/insights?fields=ad_id,ad_name,campaign_name,spend,impressions,clicks,cpc,ctr&level=ad&limit=500&access_token=${encodeURIComponent(token)}`;
    if (preset !== "custom") url += `&date_preset=${fbPreset}`;
    else url += `&time_range={'since':'${since}','until':'${until}'}`;

    let pageUrl = url;
    while (pageUrl) {
      const json = await graphFetch(pageUrl);
      (json.data || []).forEach(r => { r._actId = actId; allAds.push(r); });
      pageUrl = json.paging?.next || null;
    }
  }

  const total = allAds.reduce((s, r) => s + parseFloat(r.spend || 0), 0);
  const adIds = [...new Set(allAds.map(r => r.ad_id).filter(Boolean))];

  const adToPage = {};
  const adToCreative = {};
  for (let i = 0; i < adIds.length; i += 40) {
    const chunk = adIds.slice(i, i + 40);
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/?ids=${chunk.join(",")}&fields=id,name,creative{thumbnail_url,image_url,object_story_spec{page_id},effective_object_story_id,name}&access_token=${encodeURIComponent(token)}`;
    const json = await graphFetch(url);
    for (const aid of chunk) {
      const info = json[aid];
      const pageId =
        info?.creative?.object_story_spec?.page_id ||
        (info?.creative?.effective_object_story_id ? info.creative.effective_object_story_id.split("_")[0] : "Unknown");
      adToPage[aid] = pageId || "Unknown";
      adToCreative[aid] = {
        thumbnail: info?.creative?.thumbnail_url || info?.creative?.image_url || "",
        title: info?.creative?.name || info?.name || "Ad",
        page_id: pageId
      };
    }
  }

  // Resolve page names: shared cache first, then fetch anything missing
  let pageNames = await getPageCache();
  const pageIds = [...new Set(Object.values(adToPage).filter(v => v !== "Unknown"))];
  const toFetch = pageIds.filter(id => !pageNames[id] && /^\d+$/.test(id));
  if (toFetch.length > 0) {
    const fetched = {};
    for (let i = 0; i < toFetch.length; i += 40) {
      const chunk = toFetch.slice(i, i + 40);
      try {
        const url = `https://graph.facebook.com/${GRAPH_VERSION}/?ids=${chunk.join(",")}&fields=id,name&access_token=${encodeURIComponent(token)}`;
        const json = await graphFetch(url);
        for (const pid of chunk) {
          if (json[pid]?.name) fetched[pid] = json[pid].name;
        }
      } catch (e) { /* skip individual failures */ }
    }
    pageNames = await mergePageCache(fetched);
  }

  const grouped = {};
  allAds.forEach(r => {
    const pid = adToPage[r.ad_id] || "Unknown";
    const displayName = pageNames[pid] || pid;
    if (!grouped[pid]) {
      grouped[pid] = { page_id: pid, page_name: displayName, total_spend: 0, ad_count: 0, total_impr: 0, total_clicks: 0 };
    }
    grouped[pid].total_spend += parseFloat(r.spend || 0);
    grouped[pid].total_impr += parseInt(r.impressions || 0);
    grouped[pid].total_clicks += parseInt(r.clicks || 0);
    grouped[pid].ad_count += 1;
  });
  const pages = Object.values(grouped).sort((a, b) => b.total_spend - a.total_spend);

  const creatives = allAds
    .map(r => {
      const c = adToCreative[r.ad_id] || {};
      return {
        ad_id: r.ad_id,
        ad_name: r.ad_name,
        campaign_name: r.campaign_name,
        page_id: c.page_id,
        page_name: pageNames[c.page_id] || c.page_id,
        thumbnail: c.thumbnail,
        spend: parseFloat(r.spend || 0),
        impressions: parseInt(r.impressions || 0),
        clicks: parseInt(r.clicks || 0),
        cpc: parseFloat(r.cpc || 0) || (r.clicks ? parseFloat(r.spend) / parseInt(r.clicks) : 0),
        ctr: parseFloat(r.ctr || 0)
      };
    })
    .sort((a, b) => b.spend - a.spend);

  return { pages, creatives, total };
}

// ---------------------------------------------------------------------------
// Engine 3: Batch pause/resume (ported from Smart Controller, with its
// rate-limit handling, retry logic, and per-op success verification intact)
// ---------------------------------------------------------------------------

async function executeBatched(token, operations, onProgress) {
  const allResults = [];
  const successMap = [];

  for (let i = 0; i < operations.length; i += BATCH_SIZE) {
    const chunk = operations.slice(i, i + BATCH_SIZE);
    const chunkStartIndex = i;

    const form = new FormData();
    form.append("access_token", token);
    form.append("batch", JSON.stringify(chunk));
    form.append("include_headers", "false");

    let attempt = 0;
    let batchResults = null;

    while (attempt < MAX_RETRIES) {
      try {
        const res = await fetch("https://graph.facebook.com/", { method: "POST", body: form });
        const data = await res.json();
        if (data.error && (data.error.code === 4 || data.error.code === 80004)) throw new Error("RATE_LIMIT");
        if (Array.isArray(data) && data.some(r => r.code === 429)) throw new Error("RATE_LIMIT");
        batchResults = Array.isArray(data) ? data : [data];
        break;
      } catch (e) {
        attempt++;
        if (attempt >= MAX_RETRIES) throw e;
        await new Promise(r => setTimeout(r, 2000 * attempt * (e.message === "RATE_LIMIT" ? 2 : 1)));
      }
    }

    batchResults.forEach((result, idx) => {
      const globalOpIndex = chunkStartIndex + idx;
      let isSuccess = false;
      if (result.code === 200) {
        try {
          const body = typeof result.body === "string" ? JSON.parse(result.body) : result.body;
          if (body.id && !body.error) isSuccess = true;
        } catch {
          if (!result.body || !result.body.includes("error")) isSuccess = true;
        }
      }
      successMap.push({ opIndex: globalOpIndex, success: isSuccess, result });
      allResults.push(result);
    });

    if (onProgress) {
      onProgress({
        completed: Math.min(i + BATCH_SIZE, operations.length),
        total: operations.length,
        successCount: successMap.filter(s => s.success).length
      });
    }

    if (i + BATCH_SIZE < operations.length) await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
  }

  return { allResults, successMap };
}

async function fetchActiveAdsStrict(adAccountId, token, filterPageIds) {
  let url = `https://graph.facebook.com/${GRAPH_VERSION}/act_${adAccountId}/ads?fields=id,name,campaign{id,name},adset_id,effective_status,status,creative{id,name,object_story_spec{page_id},effective_object_story_id}&filtering=[{"field":"effective_status","operator":"IN","value":["ACTIVE"]}]&limit=500&access_token=${encodeURIComponent(token)}`;
  const all = [];
  while (url) {
    const json = await graphFetch(url);
    const filteredBatch = (json.data || []).filter(ad => ad.effective_status === "ACTIVE");
    all.push(...filteredBatch);
    url = json.paging?.next || null;
  }

  if (!filterPageIds || filterPageIds.length === 0) return all;
  return all.filter(ad => {
    const pid = ad.creative?.object_story_spec?.page_id;
    return pid && filterPageIds.includes(pid);
  });
}

// ---------------------------------------------------------------------------
// Engine 4: Page Report — pick a Page, get every ad that ran for it with
// spend, days, dates, impressions, clicks (daily breakdown included).
// ---------------------------------------------------------------------------

const ALL_AD_STATUSES = [
  "ACTIVE", "PAUSED", "DELETED", "PENDING_REVIEW", "DISAPPROVED", "PREAPPROVED",
  "PENDING_BILLING_INFO", "CAMPAIGN_PAUSED", "ARCHIVED", "ADSET_PAUSED",
  "IN_PROCESS", "WITH_ISSUES"
];

function ymd(d) {
  const z = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

function resolveRange(preset, since, until) {
  if (preset === "custom") return { since, until };
  const days = { last_30d: 30, last_90d: 90, last_365d: 365, lifetime: 1095 }[preset] || 90;
  const s = new Date();
  s.setDate(s.getDate() - days);
  return { since: ymd(s), until: ymd(new Date()) };
}

function adPageId(ad) {
  return (
    ad.creative?.object_story_spec?.page_id ||
    (ad.creative?.effective_object_story_id ? ad.creative.effective_object_story_id.split("_")[0] : "")
  );
}

async function fetchPageReport({ token, accountId, pageIds, preset, since, until }, onProgress) {
  const range = resolveRange(preset, since, until);
  if (!range.since || !range.until) throw new Error("Pick Since and Until dates");
  const enc = encodeURIComponent;
  const base = `https://graph.facebook.com/${GRAPH_VERSION}`;
  const pageNames = await getPageCache();

  // 1) account currency (so "dollar" is the real currency of the account)
  let currency = "USD";
  try {
    const acc = await graphFetch(`${base}/act_${accountId}?fields=currency&access_token=${enc(token)}`);
    if (acc.currency) currency = acc.currency;
  } catch (e) { /* keep USD default */ }

  // 2) every ad in the account (all statuses), keep only ads of the chosen pages
  const adFields = "id,name,effective_status,created_time,campaign{id,name,objective},adset{id,name},creative{object_story_spec{page_id},effective_object_story_id}";
  const statusFilter = JSON.stringify([{ field: "effective_status", operator: "IN", value: ALL_AD_STATUSES }]);
  let url = `${base}/act_${accountId}/ads?fields=${enc(adFields)}&filtering=${enc(statusFilter)}&limit=200&access_token=${enc(token)}`;
  const ads = [];
  let scanned = 0;
  while (url) {
    const json = await graphFetch(url);
    for (const ad of json.data || []) {
      scanned++;
      const pid = adPageId(ad);
      if (!pid || !pageIds.includes(pid)) continue;
      ads.push({
        ad_id: ad.id,
        ad_name: ad.name || "",
        status: ad.effective_status || "",
        created: (ad.created_time || "").slice(0, 10),
        campaign_name: ad.campaign?.name || "",
        objective: ad.campaign?.objective || "",
        adset_name: ad.adset?.name || "",
        page_id: pid,
        page_name: pageNames[pid] || pid
      });
    }
    onProgress && onProgress(`Scanned ${scanned} ads, ${ads.length} belong to selected page(s)...`);
    url = json.paging?.next || null;
  }

  // 3) day-by-day insights for those ads only
  const daily = [];
  const adIds = ads.map(a => a.ad_id);
  const CHUNK = 25;
  for (let i = 0; i < adIds.length; i += CHUNK) {
    const chunk = adIds.slice(i, i + CHUNK);
    const filtering = JSON.stringify([{ field: "ad.id", operator: "IN", value: chunk }]);
    const timeRange = JSON.stringify({ since: range.since, until: range.until });
    let u = `${base}/act_${accountId}/insights?level=ad&fields=ad_id,spend,impressions,clicks&time_increment=1&time_range=${enc(timeRange)}&filtering=${enc(filtering)}&limit=500&access_token=${enc(token)}`;
    while (u) {
      const json = await graphFetch(u);
      for (const r of json.data || []) {
        daily.push({
          date: r.date_start,
          ad_id: r.ad_id,
          spend: parseFloat(r.spend || 0),
          impressions: parseInt(r.impressions || 0),
          clicks: parseInt(r.clicks || 0)
        });
      }
      u = json.paging?.next || null;
    }
    onProgress && onProgress(`Loading spend data: ${Math.min(i + CHUNK, adIds.length)}/${adIds.length} ads...`);
  }

  // 4) per-ad totals
  const dayMs = 86400000;
  const byAd = new Map(ads.map(a => [a.ad_id, { ...a, spend: 0, impressions: 0, clicks: 0, _dates: new Set() }]));
  for (const d of daily) {
    const a = byAd.get(d.ad_id);
    if (!a) continue;
    a.spend += d.spend;
    a.impressions += d.impressions;
    a.clicks += d.clicks;
    if (d.spend > 0) a._dates.add(d.date);
  }
  const result = [...byAd.values()].map(a => {
    const dates = [...a._dates].sort();
    const first = dates[0] || "";
    const last = dates[dates.length - 1] || "";
    const span = first ? Math.round((new Date(last) - new Date(first)) / dayMs) + 1 : 0;
    const out = {
      ...a,
      first_spend_date: first,
      last_spend_date: last,
      days_with_spend: dates.length,
      span_days: span,
      cpc: a.clicks ? a.spend / a.clicks : 0,
      ctr: a.impressions ? (a.clicks / a.impressions) * 100 : 0,
      cpm: a.impressions ? (a.spend / a.impressions) * 1000 : 0,
      avg_spend_per_day: dates.length ? a.spend / dates.length : 0
    };
    delete out._dates;
    return out;
  }).sort((x, y) => y.spend - x.spend);

  const names = {};
  pageIds.forEach(id => { names[id] = pageNames[id] || id; });

  return {
    ads: result,
    daily: daily.filter(d => d.spend > 0 || d.impressions > 0).sort((a, b) => a.date.localeCompare(b.date)),
    currency,
    range,
    accountId,
    pageNames: names,
    generatedAt: Date.now()
  };
}

// Run the report for several ad accounts and merge them into one.
async function fetchPageReportMulti({ token, accountIds, pageIds, preset, since, until }, onProgress) {
  const parts = [];
  const errors = [];
  for (const id of accountIds) {
    onProgress && onProgress(`Account ${id}: starting...`);
    try {
      parts.push(await fetchPageReport(
        { token, accountId: id, pageIds, preset, since, until },
        t => onProgress && onProgress(`Account ${id}: ${t}`)
      ));
    } catch (e) {
      errors.push(`Account ${id}: ${e.message}`);
    }
  }
  if (!parts.length) throw new Error(errors.join(" | ") || "No data");
  const currencies = [...new Set(parts.map(p => p.currency))];
  const pageNames = Object.assign({}, ...parts.map(p => p.pageNames));
  return {
    ads: parts.flatMap(p => p.ads.map(a => ({ ...a, account_id: p.accountId }))).sort((x, y) => y.spend - x.spend),
    daily: parts.flatMap(p => p.daily).sort((a, b) => a.date.localeCompare(b.date)),
    currency: currencies.length === 1 ? currencies[0] : "MIXED",
    currencies,
    range: parts[0].range,
    accountIds: parts.map(p => p.accountId),
    errors,
    pageNames,
    generatedAt: Date.now()
  };
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "VALIDATE_TOKEN": {
          const accounts = await validateToken(msg.token);
          await chrome.storage.sync.set({ accessToken: msg.token, adAccounts: accounts });
          sendResponse({ ok: true, data: accounts });
          break;
        }

        case "FETCH_PAGES": {
          const { accessToken } = await chrome.storage.sync.get("accessToken");
          const pages = await fetchPagesForAccount(accessToken, msg.adAccountId);
          sendResponse({ ok: true, data: pages });
          break;
        }

        case "FETCH_INSIGHTS": {
          const { accessToken } = await chrome.storage.sync.get("accessToken");
          const result = await fetchInsights({
            token: accessToken,
            accountIds: msg.accountIds,
            preset: msg.preset,
            since: msg.since,
            until: msg.until
          });
          sendResponse({ ok: true, ...result });
          break;
        }

        case "FETCH_PAGE_REPORT": {
          const { accessToken } = await chrome.storage.sync.get("accessToken");
          if (!accessToken) throw new Error("Save a token first");
          const accountIds = msg.accountIds || (msg.accountId ? [msg.accountId] : []);
          if (!accountIds.length) throw new Error("Select at least one ad account");
          const report = await fetchPageReportMulti(
            { token: accessToken, accountIds, pageIds: msg.pageIds, preset: msg.preset, since: msg.since, until: msg.until },
            text => chrome.runtime.sendMessage({ type: "REPORT_PROGRESS", text }).catch(() => {})
          );
          await chrome.storage.local.set({ lastPageReport: report });
          sendResponse({ ok: true, report });
          break;
        }

        case "PAUSE_ADS": {
          const { adAccountId, pageIds, pageMap } = msg.payload;
          const { accessToken } = await chrome.storage.sync.get("accessToken");

          const ads = await fetchActiveAdsStrict(adAccountId, accessToken, pageIds);
          if (ads.length === 0) {
            await chrome.storage.local.set({ lastPausedSession: [] });
            await chrome.storage.sync.set({ lastPausedSession: [] });
            sendResponse({ ok: true, count: 0, successCount: 0, totalFound: 0, records: [] });
            break;
          }

          const ops = ads.map(ad => ({ method: "POST", relative_url: `${ad.id}`, body: "status=PAUSED" }));
          const { successMap } = await executeBatched(accessToken, ops, progress => {
            chrome.runtime.sendMessage({ type: "PROGRESS", ...progress }).catch(() => {});
          });

          const successfulAds = successMap.filter(e => e.success).map(e => ads[e.opIndex]);
          const records = successfulAds.map(ad => ({
            ad_id: ad.id,
            ad_name: ad.name,
            campaign_id: ad.campaign?.id || "",
            campaign_name: ad.campaign?.name || "",
            adset_id: ad.adset_id || "",
            page_id: ad.creative?.object_story_spec?.page_id || "",
            page_name: pageMap?.[ad.creative?.object_story_spec?.page_id] || ad.creative?.object_story_spec?.page_id || "Unknown",
            effective_object_story_id: ad.creative?.effective_object_story_id || "",
            paused_at: Date.now()
          }));

          await chrome.storage.local.set({ lastPausedSession: records });
          await chrome.storage.sync.set({
            lastPausedSession: records,
            lastAction: "PAUSE",
            lastPausedMeta: { adAccountId, pageIds, timestamp: Date.now(), totalFound: ads.length, successCount: records.length },
            selectedPageIds: pageIds
          });

          sendResponse({ ok: true, count: ads.length, successCount: records.length, totalFound: ads.length, records });
          break;
        }

        case "RESUME_ADS": {
          const { accessToken } = await chrome.storage.sync.get("accessToken");
          const syncData = await chrome.storage.sync.get("lastPausedSession");
          const localData = await chrome.storage.local.get("lastPausedSession");
          const lastPausedSession = syncData.lastPausedSession || localData.lastPausedSession || [];
          if (!lastPausedSession.length) throw new Error("No paused session found. Pause ads first.");

          const ops = lastPausedSession.map(r => ({ method: "POST", relative_url: `${r.ad_id}`, body: "status=ACTIVE" }));
          const { successMap } = await executeBatched(accessToken, ops, progress => {
            chrome.runtime.sendMessage({ type: "PROGRESS", ...progress }).catch(() => {});
          });

          const successCount = successMap.filter(s => s.success).length;
          await chrome.storage.sync.set({ lastAction: "RESUME" });
          sendResponse({ ok: true, count: lastPausedSession.length, successCount });
          break;
        }

        default:
          sendResponse({ ok: false, error: "Unknown message type: " + msg.type });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true; // keep the message channel open for the async response
});
