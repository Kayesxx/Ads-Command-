const $ = id => document.getElementById(id);

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------
let adAccounts = [];          // [{id, account_id, name, account_status}]
let selectedAnalyzeIds = [];  // account ids (without act_) ticked in Analyze tab
let controlPages = [];        // pages for the account picked in Control tab
let selectedPages = [];       // page ids ticked in Control tab's filter
let lastAnalyzeData = { pages: [], creatives: [], total: 0, preset: "" };
let lastSession = [];         // last paused-ads session (Control tab)

const tokenInput = $("tokenInput"), saveTokenBtn = $("saveTokenBtn"), tokenStatus = $("tokenStatus");
const toastEl = $("toast");

function showToast(msg, type = "info") {
  toastEl.textContent = msg;
  toastEl.className = `toast ${type}`;
  toastEl.classList.remove("hidden");
  setTimeout(() => toastEl.classList.add("hidden"), 4000);
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    $(`tab-${btn.dataset.tab}`).classList.add("active");
  });
});

// ---------------------------------------------------------------------------
// Token & account discovery (shared by both tabs)
// ---------------------------------------------------------------------------
saveTokenBtn.addEventListener("click", async () => {
  const token = tokenInput.value.trim();
  if (!token.startsWith("EA")) { showToast("Token should start with EA...", "error"); return; }
  saveTokenBtn.disabled = true;
  tokenStatus.textContent = "Validating...";
  const res = await chrome.runtime.sendMessage({ type: "VALIDATE_TOKEN", token });
  saveTokenBtn.disabled = false;
  if (res.ok) {
    adAccounts = res.data;
    renderAnalyzeAccounts();
    renderControlAccounts();
    renderReportAccounts();
    tokenStatus.textContent = `✅ Found ${adAccounts.length} ad account(s)`;
    showToast("Token valid!", "success");
  } else {
    tokenStatus.innerHTML = `<span style="color:#ef4444">❌ ${res.error}</span>`;
    showToast(res.error, "error");
  }
});

async function loadState() {
  const sync = await chrome.storage.sync.get([
    "accessToken", "adAccounts", "selectedAdAccountId", "selectedPageIds", "lastPausedSession"
  ]);
  const local = await chrome.storage.local.get(["lastPausedSession"]);

  if (sync.accessToken) tokenInput.value = sync.accessToken;
  adAccounts = sync.adAccounts || [];
  if (adAccounts.length) tokenStatus.textContent = `✅ ${adAccounts.length} ad account(s) loaded`;

  renderAnalyzeAccounts();
  renderControlAccounts(sync.selectedAdAccountId);
  renderReportAccounts();
  restoreLastReport();

  selectedPages = sync.selectedPageIds || [];
  lastSession = sync.lastPausedSession || local.lastPausedSession || [];
  $("sessionCount").textContent = lastSession.length;

  if (sync.selectedAdAccountId) fetchControlPages(sync.selectedAdAccountId);
}

// ---------------------------------------------------------------------------
// ANALYZE TAB
// ---------------------------------------------------------------------------

function renderAnalyzeAccounts() {
  const box = $("analyzeAccountsList");
  box.innerHTML = "";
  if (!adAccounts.length) { box.innerHTML = "<p class='muted'>Save a token first</p>"; return; }
  adAccounts.forEach(a => {
    const id = a.id.replace("act_", "");
    const isChecked = selectedAnalyzeIds.includes(id);
    const label = document.createElement("label");
    label.className = "page-item" + (isChecked ? " checked" : "");
    label.innerHTML = `
      <div class="check"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg></div>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${a.name} (${a.account_id})</span>
    `;
    label.addEventListener("click", e => {
      e.preventDefault();
      if (selectedAnalyzeIds.includes(id)) selectedAnalyzeIds = selectedAnalyzeIds.filter(x => x !== id);
      else selectedAnalyzeIds = [...selectedAnalyzeIds, id];
      renderAnalyzeAccounts();
    });
    box.appendChild(label);
  });
}

$("selectAllAccounts").addEventListener("click", () => {
  if (selectedAnalyzeIds.length === adAccounts.length) selectedAnalyzeIds = [];
  else selectedAnalyzeIds = adAccounts.map(a => a.id.replace("act_", ""));
  renderAnalyzeAccounts();
});

$("datePreset").addEventListener("change", e => {
  $("customRow").classList.toggle("hidden", e.target.value !== "custom");
});

$("viewMode").addEventListener("change", () => {
  if (!lastAnalyzeData.pages.length) return;
  if ($("viewMode").value === "page") renderPageTable(lastAnalyzeData.pages);
  else renderCreativeTable();
});

$("fetchBtn").addEventListener("click", async () => {
  if (!selectedAnalyzeIds.length) { showToast("Tick at least one ad account", "error"); return; }
  const preset = $("datePreset").value, since = $("since").value, until = $("until").value;
  $("analyzeStatus").textContent = "Fetching...";
  $("fetchBtn").disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({
      type: "FETCH_INSIGHTS",
      accountIds: selectedAnalyzeIds,
      preset, since, until
    });
    if (!res.ok) throw new Error(res.error);
    lastAnalyzeData = {
      pages: res.pages, creatives: res.creatives, total: res.total,
      preset: $("datePreset").selectedOptions[0].textContent
    };
    if ($("viewMode").value === "page") renderPageTable(res.pages);
    else renderCreativeTable();
    $("resultCard").classList.remove("hidden");
    $("analyzeStatus").innerHTML = `<span style="color:#16a34a">Done: ${res.pages.length} pages, ${res.creatives.length} creatives, $${res.total.toFixed(2)}</span>`;
  } catch (err) {
    $("analyzeStatus").innerHTML = `<span style="color:#ef4444">${err.message}</span>`;
  } finally {
    $("fetchBtn").disabled = false;
  }
});

function esc(s) { return (s || "").replace(/[&<>"]/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m])); }

function renderPageTable(pages) {
  $("tableHead").innerHTML = "<th>Page</th><th>Page ID</th><th>Ads</th><th>Spend</th><th>CPC</th>";
  const body = $("tableBody"); body.innerHTML = "";
  pages.forEach(p => {
    const avg = p.total_clicks ? (p.total_spend / p.total_clicks).toFixed(4) : "-";
    const isIdSame = p.page_name === p.page_id;
    const displayName = isIdSame
      ? `<span style="color:#ef4444">⚠️ Unknown (${p.page_id})</span>`
      : `<b>${esc(p.page_name)}</b>`;
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${displayName}</td><td style="font-size:9px">${p.page_id}</td><td>${p.ad_count}</td><td><b>$${p.total_spend.toFixed(2)}</b></td><td>${avg}</td>`;
    body.appendChild(tr);
  });
}

function renderCreativeTable() {
  $("tableHead").innerHTML = "<th>Creative</th><th>Ad</th><th>Spend</th><th>CPC</th><th>Status</th>";
  const body = $("tableBody"); body.innerHTML = "";
  lastAnalyzeData.creatives.forEach((c, idx) => {
    const isWinner = idx < 3 && c.spend > 0;
    const isLoser = c.cpc > 0.05 && c.spend > 10;
    const status = isWinner
      ? '<span style="background:#dcfce7;color:#166534;padding:2px 6px;border-radius:10px;font-size:10px;font-weight:700">🏆 Winner</span>'
      : isLoser
        ? '<span style="background:#fee2e2;color:#991b1b;padding:2px 6px;border-radius:10px;font-size:10px">💸 High CPC</span>'
        : '<span style="background:#dbeafe;color:#1e40af;padding:2px 6px;border-radius:10px;font-size:10px">Running</span>';
    const tr = document.createElement("tr");
    tr.style.borderLeft = isWinner ? "4px solid #22c55e" : isLoser ? "4px solid #ef4444" : "";
    tr.innerHTML = `<td><img src="${c.thumbnail}" style="width:36px;height:36px;object-fit:cover;border-radius:6px" onerror="this.style.display='none'"></td><td>${esc((c.ad_name || "").slice(0, 26))}<br><span style="font-size:9px;color:#888">${esc(c.page_name)}</span></td><td>$${c.spend.toFixed(2)}</td><td>${c.cpc.toFixed(4)}</td><td>${status}</td>`;
    body.appendChild(tr);
  });
}

$("exportPdfBtn").addEventListener("click", () => {
  const w = window.open("", "_blank", "width=900,height=1000");
  const total = lastAnalyzeData.total.toFixed(2);
  const preset = lastAnalyzeData.preset;
  const pages = lastAnalyzeData.pages;
  const creatives = lastAnalyzeData.creatives.slice(0, 15);
  const now = new Date().toLocaleDateString() + " - " + new Date().toLocaleTimeString();
  const pageRows = pages.map(p => `<tr><td>${esc(p.page_name)}</td><td style="font-size:11px">${p.page_id}</td><td style="text-align:center">${p.ad_count}</td><td style="text-align:right;font-weight:700">$${p.total_spend.toFixed(2)}</td><td style="text-align:right">${p.total_clicks ? (p.total_spend / p.total_clicks).toFixed(4) : "-"}</td></tr>`).join("");
  const creativeRows = creatives.map((c, i) => `<tr style="${i < 3 ? "background:#f0fdf4" : ""}"><td>${i + 1}. ${esc((c.ad_name || "").slice(0, 40))}</td><td>${esc(c.page_name)} (${c.page_id})</td><td style="text-align:right">$${c.spend.toFixed(2)}</td><td style="text-align:right">${c.cpc.toFixed(4)}</td><td>${i < 3 ? "🏆 Top Spender" : c.cpc > 0.05 ? "💸 High CPC" : "Running"}</td></tr>`).join("");
  w.document.write(`
<html><head><meta charset="utf-8"><title>Ad Spend Report</title>
<style>
  body{font-family:Inter,sans-serif;margin:0;background:#f7f8fa;color:#1f2937}
  .header{background:#0B3D91;color:#fff;padding:28px 32px;border-radius:12px;margin:20px}
  .header h1{margin:0;font-size:22px} .header p{margin:8px 0 0;opacity:.8}
  .meta{display:grid;grid-template-columns:1fr 1fr;gap:12px;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:16px;margin:20px}
  .meta div{font-size:13px} .meta b{color:#6b7280}
  .summary{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin:20px}
  .card{background:#fff;border-radius:12px;padding:18px;text-align:center;border:1px solid #e5e7eb;border-top:4px solid #0B3D91}
  .card.green{border-top-color:#16a34a} .card.blue{border-top-color:#2563eb}
  .card h3{margin:0;font-size:12px;color:#6b7280} .card .val{font-size:26px;font-weight:800;margin-top:8px}
  .section{margin:20px} .section h2{font-size:16px;color:#0B3D91;border-bottom:2px solid #e5e7eb;padding-bottom:8px}
  table{width:100%;background:#fff;border-radius:12px;overflow:hidden;border-collapse:collapse;border:1px solid #e5e7eb}
  th{background:#f1f5f9;text-align:left;padding:10px 12px;font-size:12px} td{padding:10px 12px;font-size:12px;border-bottom:1px solid #f0f0f0}
  .footer{text-align:center;color:#9ca3af;font-size:11px;margin:30px}
  @media print{ .no-print{display:none} }
</style>
</head><body>
  <div class="header"><h1>Facebook Ad Spend Report</h1><p>FB Ads Command Center</p></div>
  <div class="meta"><div><b>Report date:</b> ${now}</div><div><b>Date range:</b> ${preset}</div><div><b>Accounts:</b> ${selectedAnalyzeIds.length}</div><div><b>Total pages:</b> ${pages.length} | Total ads: ${lastAnalyzeData.creatives.length}</div></div>
  <div class="summary"><div class="card green"><h3>Total Spend</h3><div class="val">$${total}</div></div><div class="card blue"><h3>Total Ads</h3><div class="val">${lastAnalyzeData.creatives.length}</div></div><div class="card"><h3>Avg CPC</h3><div class="val">$${(pages.reduce((s, p) => s + p.total_spend, 0) / (pages.reduce((s, p) => s + p.total_clicks, 0) || 1)).toFixed(4)}</div></div></div>
  <div class="section"><h2>Page-wise Breakdown</h2><table><thead><tr><th>Page</th><th>Page ID</th><th>Ads</th><th>Spend</th><th>Avg CPC</th></tr></thead><tbody>${pageRows}</tbody></table></div>
  <div class="section"><h2>🏆 Creative Winner Finder</h2><table><thead><tr><th>Ad</th><th>Page</th><th>Spend</th><th>CPC</th><th>Status</th></tr></thead><tbody>${creativeRows}</tbody></table></div>
  <div class="footer">Generated by FB Ads Command Center • ${now}</div>
  <div class="no-print" style="text-align:center;margin:20px"><button onclick="window.print()" style="background:#0B3D91;color:#fff;padding:12px 24px;border-radius:8px;border:0;cursor:pointer;font-weight:700">📄 Save as PDF / Print</button></div>
</body></html>
  `);
  w.document.close();
});

// ---------------------------------------------------------------------------
// PAGE REPORT TAB — pick a page, see every ad that ran for it:
// days, dates, spend, impressions, clicks. Download as CSV / PDF.
// ---------------------------------------------------------------------------

let rpPages = [];          // pages of the account picked in this tab
let rpSelected = [];       // page ids ticked
let rpReport = null;       // last report from background

// wider popup while this tab is open so the table fits
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => document.body.classList.toggle("wide", btn.dataset.tab === "report"));
});

let rpAccountsSel = [];    // ad account ids ticked in this tab
let rpLoadSeq = 0;

function renderReportAccounts() {
  const box = $("rpAccounts");
  box.innerHTML = "";
  if (!adAccounts.length) { box.innerHTML = "<p class='muted'>Save a token first</p>"; return; }
  adAccounts.forEach(a => {
    const id = a.id.replace("act_", "");
    const on = rpAccountsSel.includes(id);
    const label = document.createElement("label");
    label.className = "page-item" + (on ? " checked" : "");
    label.innerHTML = `
      <div class="check"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg></div>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.name)} (${esc(a.account_id)})</span>`;
    label.addEventListener("click", e => {
      e.preventDefault();
      rpAccountsSel = on ? rpAccountsSel.filter(x => x !== id) : [...rpAccountsSel, id];
      renderReportAccounts();
      loadReportPages();
    });
    box.appendChild(label);
  });
}

$("rpAccSelectAll").addEventListener("click", () => {
  rpAccountsSel = rpAccountsSel.length === adAccounts.length ? [] : adAccounts.map(a => a.id.replace("act_", ""));
  renderReportAccounts();
  loadReportPages();
});

// pages = union of the pages found in every ticked account
async function loadReportPages() {
  const seq = ++rpLoadSeq;
  if (!rpAccountsSel.length) {
    rpPages = []; rpSelected = [];
    $("rpPages").innerHTML = '<p class="muted">Select account first</p>';
    $("rpPageInfo").textContent = "";
    return;
  }
  $("rpPages").innerHTML = '<p class="muted">Loading pages...</p>';
  const map = new Map();
  let lastErr = "";
  for (const id of rpAccountsSel) {
    const res = await chrome.runtime.sendMessage({ type: "FETCH_PAGES", adAccountId: id });
    if (seq !== rpLoadSeq) return; // user changed ticks meanwhile
    if (res.ok) res.data.forEach(p => { if (!map.has(p.id)) map.set(p.id, p); });
    else lastErr = res.error;
  }
  rpPages = [...map.values()].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  rpSelected = rpSelected.filter(id => map.has(id));
  if (!rpPages.length && lastErr) { $("rpPages").innerHTML = `<p class="muted" style="color:#ef4444">${esc(lastErr)}</p>`; return; }
  renderReportPages();
}

function renderReportPages() {
  const box = $("rpPages");
  box.innerHTML = "";
  if (!rpPages.length) { box.innerHTML = "<p class='muted'>No pages found for this account</p>"; $("rpPageInfo").textContent = ""; return; }
  rpPages.forEach(p => {
    const on = rpSelected.includes(p.id);
    const label = document.createElement("label");
    label.className = "page-item" + (on ? " checked" : "");
    label.innerHTML = `
      <div class="check"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg></div>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:${on ? "600" : ""}">${esc(p.name)}</span>
      <span style="font-size:10px;color:#71717a">${p.fan_count ? p.fan_count.toLocaleString() + " likes" : ""}</span>`;
    label.addEventListener("click", e => {
      e.preventDefault();
      rpSelected = on ? rpSelected.filter(x => x !== p.id) : [...rpSelected, p.id];
      renderReportPages();
    });
    box.appendChild(label);
  });
  $("rpPageInfo").textContent = rpSelected.length ? `${rpSelected.length} page(s) selected` : "Tick the page(s) you want the report for";
}

$("rpSelectAll").addEventListener("click", () => { rpSelected = rpPages.map(p => p.id); renderReportPages(); });
$("rpClear").addEventListener("click", () => { rpSelected = []; renderReportPages(); });
$("rpPreset").addEventListener("change", e => $("rpCustomRow").classList.toggle("hidden", e.target.value !== "custom"));
$("rpOnlySpend").addEventListener("change", () => { if (rpReport) renderReport(); });

chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === "REPORT_PROGRESS") $("rpStatus").textContent = msg.text;
});

$("rpFetchBtn").addEventListener("click", async () => {
  if (!rpAccountsSel.length) { showToast("Tick at least one ad account", "error"); return; }
  if (!rpSelected.length) { showToast("Tick at least one page", "error"); return; }
  const preset = $("rpPreset").value;
  $("rpFetchBtn").disabled = true;
  $("rpStatus").textContent = "Starting...";
  try {
    const res = await chrome.runtime.sendMessage({
      type: "FETCH_PAGE_REPORT",
      accountIds: rpAccountsSel, pageIds: rpSelected, preset,
      since: $("rpSince").value, until: $("rpUntil").value
    });
    if (!res.ok) throw new Error(res.error);
    rpReport = res.report;
    renderReport();
    const warn = (rpReport.errors || []).length ? `<br><span style="color:#d97706">⚠ ${esc(rpReport.errors.join(" | "))}</span>` : "";
    $("rpStatus").innerHTML = `<span style="color:#16a34a">Done: ${rpReport.ads.length} ads from ${(rpReport.accountIds || []).length} account(s)</span>${warn}`;
  } catch (err) {
    $("rpStatus").innerHTML = `<span style="color:#ef4444">${esc(err.message)}</span>`;
  } finally {
    $("rpFetchBtn").disabled = false;
  }
});

async function restoreLastReport() {
  const { lastPageReport } = await chrome.storage.local.get("lastPageReport");
  if (lastPageReport && lastPageReport.ads) {
    rpReport = lastPageReport;
    renderReport();
    $("rpStatus").textContent = "Showing your last report (" + new Date(rpReport.generatedAt).toLocaleString() + ")";
  }
}

function money(n, cur) {
  if (cur === "MIXED") cur = "";
  const v = (Number(n) || 0).toFixed(2);
  return cur === "USD" ? "$" + v : `${cur || ""} ${v}`;
}
function visibleAds() {
  if (!rpReport) return [];
  return $("rpOnlySpend").checked ? rpReport.ads.filter(a => a.spend > 0) : rpReport.ads;
}
function reportTotals(ads) {
  const ids = new Set(ads.map(a => a.ad_id));
  const daily = rpReport.daily.filter(d => ids.has(d.ad_id));
  const spendDates = [...new Set(daily.filter(d => d.spend > 0).map(d => d.date))].sort();
  const spend = ads.reduce((s, a) => s + a.spend, 0);
  const first = spendDates[0] || "", last = spendDates[spendDates.length - 1] || "";
  const span = first ? Math.round((new Date(last) - new Date(first)) / 86400000) + 1 : 0;
  return {
    spend, daysWithSpend: spendDates.length, first, last, span,
    impressions: ads.reduce((s, a) => s + a.impressions, 0),
    clicks: ads.reduce((s, a) => s + a.clicks, 0),
    avgPerDay: spendDates.length ? spend / spendDates.length : 0
  };
}

function renderReport() {
  const cur = rpReport.currency;
  const ads = visibleAds();
  const t = reportTotals(ads);
  const names = Object.values(rpReport.pageNames || {}).join(", ");
  $("rpTitle").textContent = `${names || "Page"} — ${rpReport.range.since} → ${rpReport.range.until}`;
  $("rpSummary").innerHTML = `
    <div class="rp-box big"><span>TOTAL SPENT</span><b>${money(t.spend, cur)}</b></div>
    <div class="rp-box big"><span>DAYS WITH SPEND</span><b>${t.daysWithSpend} <small style="font-weight:400">of ${t.span}</small></b></div>
    <div class="rp-box"><span>ADS</span><b>${ads.length}</b></div>
    <div class="rp-box"><span>AVG / ACTIVE DAY</span><b>${money(t.avgPerDay, cur)}</b></div>
    <div class="rp-box"><span>FIRST SPEND</span><b style="font-size:12px">${t.first || "-"}</b></div>
    <div class="rp-box"><span>LAST SPEND</span><b style="font-size:12px">${t.last || "-"}</b></div>
    <div class="rp-box"><span>IMPRESSIONS</span><b>${t.impressions.toLocaleString()}</b></div>
    <div class="rp-box"><span>CLICKS</span><b>${t.clicks.toLocaleString()}</b></div>`;

  $("rpHead").innerHTML = `<th>Ad</th><th>Campaign</th><th>Status</th><th>First</th><th>Last</th><th class="num">Days</th><th class="num">Spend (${esc(cur)})</th><th class="num">Impr.</th><th class="num">Clicks</th><th class="num">CPC</th>`;
  const body = $("rpBody"); body.innerHTML = "";
  ads.forEach(a => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td title="${esc(a.ad_name)}">${esc((a.ad_name || "").slice(0, 28))}<br><span style="font-size:9px;color:#888">${esc(a.page_name)}</span></td>
      <td>${esc((a.campaign_name || "").slice(0, 24))}</td>
      <td><span class="pill ${esc(a.status)}">${esc(a.status)}</span></td>
      <td>${a.first_spend_date || "-"}</td><td>${a.last_spend_date || "-"}</td>
      <td class="num"><b>${a.days_with_spend}</b></td>
      <td class="num"><b>${a.spend.toFixed(2)}</b></td>
      <td class="num">${a.impressions.toLocaleString()}</td>
      <td class="num">${a.clicks.toLocaleString()}</td>
      <td class="num">${a.cpc ? a.cpc.toFixed(3) : "-"}</td>`;
    body.appendChild(tr);
  });
  if (!ads.length) body.innerHTML = '<tr><td colspan="10" class="muted">No ads with spend in this date range. Try a longer range or untick "Only ads that spent money".</td></tr>';
  $("rpResult").classList.remove("hidden");
}

function csvCell(v) { return `"${String(v ?? "").replace(/"/g, '""')}"`; }
function downloadCsv(filename, headers, rows) {
  const csv = [headers.map(csvCell).join(","), ...rows.map(r => r.map(csvCell).join(","))].join("\r\n");
  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" }); // BOM so Excel reads UTF-8
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
function reportFileStem() {
  const n = Object.values(rpReport.pageNames || {})[0] || "page";
  return "page-report_" + n.replace(/[^a-z0-9]+/gi, "-").slice(0, 30) + "_" + rpReport.range.since + "_to_" + rpReport.range.until;
}

$("rpCsvAds").addEventListener("click", () => {
  if (!rpReport) return;
  const cur = rpReport.currency;
  const headers = ["Page", "Page ID", "Ad Account ID", "Ad ID", "Ad Name", "Campaign", "Ad Set", "Objective", "Status", "Created",
    "First Spend Date", "Last Spend Date", "Days With Spend", "Days Between First & Last", `Total Spend (${cur})`,
    "Impressions", "Clicks", "CPC", "CTR %", "CPM", "Avg Spend / Active Day"];
  const rows = visibleAds().map(a => [a.page_name, a.page_id, a.account_id || "", a.ad_id, a.ad_name, a.campaign_name, a.adset_name, a.objective,
    a.status, a.created, a.first_spend_date, a.last_spend_date, a.days_with_spend, a.span_days, a.spend.toFixed(2),
    a.impressions, a.clicks, a.cpc.toFixed(4), a.ctr.toFixed(2), a.cpm.toFixed(2), a.avg_spend_per_day.toFixed(2)]);
  const t = reportTotals(visibleAds());
  rows.push([]);
  rows.push(["TOTAL", "", "", "", `${rows.length - 1} ads`, "", "", "", "", "", t.first, t.last, t.daysWithSpend, t.span, t.spend.toFixed(2), t.impressions, t.clicks, "", "", "", t.avgPerDay.toFixed(2)]);
  downloadCsv(reportFileStem() + "_ads.csv", headers, rows);
});

$("rpCsvDaily").addEventListener("click", () => {
  if (!rpReport) return;
  const cur = rpReport.currency;
  const adMap = new Map(visibleAds().map(a => [a.ad_id, a]));
  const rows = rpReport.daily.filter(d => adMap.has(d.ad_id)).map(d => {
    const a = adMap.get(d.ad_id);
    return [d.date, a.page_name, a.ad_id, a.ad_name, a.campaign_name, d.spend.toFixed(2), d.impressions, d.clicks];
  });
  downloadCsv(reportFileStem() + "_daily.csv", ["Date", "Page", "Ad ID", "Ad Name", "Campaign", `Spend (${cur})`, "Impressions", "Clicks"], rows);
});

$("rpPdf").addEventListener("click", () => {
  if (!rpReport) return;
  const cur = rpReport.currency, ads = visibleAds(), t = reportTotals(ads);
  const names = Object.values(rpReport.pageNames || {}).join(", ");
  const now = new Date().toLocaleString();
  const rows = ads.map((a, i) => `<tr><td>${i + 1}</td><td>${esc(a.ad_name)}<br><small>${esc(a.campaign_name)}</small></td><td>${esc(a.status)}</td><td>${a.first_spend_date || "-"}</td><td>${a.last_spend_date || "-"}</td><td class="r">${a.days_with_spend}</td><td class="r"><b>${a.spend.toFixed(2)}</b></td><td class="r">${a.impressions.toLocaleString()}</td><td class="r">${a.clicks.toLocaleString()}</td></tr>`).join("");
  const w = window.open("", "_blank", "width=1000,height=1000");
  w.document.write(`<html><head><meta charset="utf-8"><title>Page Report</title><style>
    body{font-family:Inter,Arial,sans-serif;margin:24px;color:#1f2937}
    h1{margin:0 0 4px;font-size:20px;color:#0B3D91} .sub{color:#6b7280;font-size:12px;margin-bottom:16px}
    .sum{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:18px}
    .b{border:1px solid #e5e7eb;border-radius:8px;padding:10px} .b span{display:block;font-size:10px;color:#6b7280;font-weight:700} .b b{font-size:16px}
    table{width:100%;border-collapse:collapse;font-size:11px} th{background:#f1f5f9;text-align:left;padding:7px} td{padding:7px;border-bottom:1px solid #eee;vertical-align:top}
    .r{text-align:right} small{color:#888}
  </style></head><body>
  <h1>Page Report: ${esc(names)}</h1>
  <div class="sub">${rpReport.range.since} → ${rpReport.range.until} · Generated ${esc(now)}</div>
  <div class="sum">
    <div class="b"><span>TOTAL SPENT</span><b>${money(t.spend, cur)}</b></div>
    <div class="b"><span>DAYS WITH SPEND</span><b>${t.daysWithSpend} / ${t.span}</b></div>
    <div class="b"><span>ADS</span><b>${ads.length}</b></div>
    <div class="b"><span>AVG / ACTIVE DAY</span><b>${money(t.avgPerDay, cur)}</b></div>
    <div class="b"><span>FIRST SPEND</span><b>${t.first || "-"}</b></div>
    <div class="b"><span>LAST SPEND</span><b>${t.last || "-"}</b></div>
    <div class="b"><span>IMPRESSIONS</span><b>${t.impressions.toLocaleString()}</b></div>
    <div class="b"><span>CLICKS</span><b>${t.clicks.toLocaleString()}</b></div>
  </div>
  <table><thead><tr><th>#</th><th>Ad / Campaign</th><th>Status</th><th>First spend</th><th>Last spend</th><th class="r">Days</th><th class="r">Spend (${esc(cur)})</th><th class="r">Impr.</th><th class="r">Clicks</th></tr></thead><tbody>${rows}</tbody></table>
  </body></html>`);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 500);
});

// ---------------------------------------------------------------------------
// CONTROL TAB
// ---------------------------------------------------------------------------

const controlAccountSelect = $("controlAccountSelect");
const pagesList = $("pagesList"), filterInfo = $("filterInfo"), clearPages = $("clearPages");
const pauseBtn = $("pauseBtn"), resumeBtn = $("resumeBtn"), exportCsv = $("exportCsv"), exportJson = $("exportJson");
const logsEl = $("logs"), sessionCountEl = $("sessionCount");
const progressWrap = $("progressWrap"), progLabel = $("progLabel"), progPct = $("progPct"), progBar = $("progBar"), successInfo = $("successInfo");

function log(msg, type = "") {
  const d = document.createElement("div");
  d.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  if (type === "success") d.style.color = "#10b981";
  if (type === "error") d.style.color = "#ef4444";
  logsEl.prepend(d);
  if (logsEl.children.length > 120) logsEl.lastChild.remove();
}

function renderControlAccounts(selected) {
  controlAccountSelect.innerHTML = '<option value="">Select Ad Account</option>';
  adAccounts.forEach(a => {
    const o = document.createElement("option");
    o.value = a.id.replace("act_", "");
    o.textContent = `${a.name} (${a.account_id})`;
    if (o.value === selected) o.selected = true;
    controlAccountSelect.appendChild(o);
  });
}

async function fetchControlPages(adAccountId) {
  log(`Fetching pages for act_${adAccountId}...`);
  pagesList.innerHTML = '<p class="muted">Loading pages...</p>';
  const res = await chrome.runtime.sendMessage({ type: "FETCH_PAGES", adAccountId });
  if (res.ok) { controlPages = res.data; renderControlPages(); log(`Found ${controlPages.length} pages`, "success"); }
  else { log(`Error: ${res.error}`, "error"); showToast(res.error, "error"); }
}

function renderControlPages() {
  pagesList.innerHTML = "";
  if (!controlPages.length) { pagesList.innerHTML = "<p class='muted'>No pages found for this account</p>"; filterInfo.textContent = ""; return; }
  controlPages.forEach(p => {
    const isChecked = selectedPages.includes(p.id);
    const label = document.createElement("label");
    label.className = "page-item" + (isChecked ? " checked" : "");
    label.innerHTML = `
      <div class="check"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg></div>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:${isChecked ? "600" : ""}">${esc(p.name)}</span>
      <span style="font-size:10px;color:#71717a">${p.fan_count ? p.fan_count.toLocaleString() + " likes" : ""}</span>
    `;
    label.addEventListener("click", e => {
      e.preventDefault();
      if (selectedPages.includes(p.id)) selectedPages = selectedPages.filter(x => x !== p.id);
      else selectedPages = [...selectedPages, p.id];
      chrome.storage.sync.set({ selectedPageIds: selectedPages });
      renderControlPages();
    });
    pagesList.appendChild(label);
  });
  updateFilterInfo();
}

function updateFilterInfo() {
  filterInfo.textContent = selectedPages.length === 0
    ? "No tick = ALL pages (all ads in account)"
    : `Ticked ${selectedPages.length} page(s) - actions apply ONLY to those`;
}

controlAccountSelect.addEventListener("change", async e => {
  const id = e.target.value;
  if (!id) return;
  await chrome.storage.sync.set({ selectedAdAccountId: id });
  fetchControlPages(id);
});

clearPages.addEventListener("click", async () => {
  selectedPages = [];
  await chrome.storage.sync.set({ selectedPageIds: [] });
  renderControlPages();
});

chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === "PROGRESS") {
    progressWrap.classList.remove("hidden");
    progLabel.textContent = `Processing ${msg.completed}/${msg.total}`;
    const pct = Math.round((msg.completed / msg.total) * 100);
    progPct.textContent = pct + "%";
    progBar.style.width = pct + "%";
    successInfo.textContent = `✅ Processed: ${msg.successCount || 0} / ${msg.total}`;
  }
});

pauseBtn.addEventListener("click", async () => {
  const { selectedAdAccountId } = await chrome.storage.sync.get("selectedAdAccountId");
  if (!selectedAdAccountId) { showToast("Select ad account first", "error"); return; }
  pauseBtn.disabled = true; resumeBtn.disabled = true;
  progressWrap.classList.remove("hidden");
  progLabel.textContent = "Fetching ACTIVE ads only...";
  log(`PAUSE: Strict filter - ACTIVE only, Pages: ${selectedPages.length ? selectedPages.length + " ticked" : "ALL"}`);

  const pageMap = Object.fromEntries(controlPages.map(p => [p.id, p.name]));
  const res = await chrome.runtime.sendMessage({ type: "PAUSE_ADS", payload: { adAccountId: selectedAdAccountId, pageIds: selectedPages, pageMap } });

  pauseBtn.disabled = false; resumeBtn.disabled = false;
  if (res.ok) {
    const { lastPausedSession } = await chrome.storage.sync.get("lastPausedSession");
    lastSession = lastPausedSession || [];
    sessionCountEl.textContent = lastSession.length;
    log(`Found ${res.totalFound} ACTIVE ads matching filter. Paused ${res.successCount} successfully.`, "success");
    successInfo.textContent = `Result: ${res.successCount}/${res.totalFound} actually paused (verified by API)`;
    if (res.successCount === 0 && res.totalFound > 0) showToast(`Found ${res.totalFound} but 0 paused - check permissions`, "error");
    else if (res.successCount > 0) showToast(`✅ Paused ${res.successCount} ads`, "success");
    else showToast("No ACTIVE ads matched filter", "info");
  } else {
    log(`Pause failed: ${res.error}`, "error");
    showToast(res.error, "error");
    progressWrap.classList.add("hidden");
  }
});

resumeBtn.addEventListener("click", async () => {
  const syncData = await chrome.storage.sync.get("lastPausedSession");
  const localData = await chrome.storage.local.get("lastPausedSession");
  const session = syncData.lastPausedSession || localData.lastPausedSession || [];
  if (!session.length) { showToast("No paused session found", "error"); return; }
  pauseBtn.disabled = true; resumeBtn.disabled = true;
  progressWrap.classList.remove("hidden");
  log(`RESUME: Reactivating ${session.length} previously-paused ads...`);
  const res = await chrome.runtime.sendMessage({ type: "RESUME_ADS" });
  pauseBtn.disabled = false; resumeBtn.disabled = false;
  if (res.ok) {
    log(`Resumed ${res.successCount}/${res.count} ads (verified)`, "success");
    showToast(`✅ Resumed ${res.successCount} ads`, "success");
    successInfo.textContent = `Resumed: ${res.successCount}/${res.count} verified`;
  } else {
    log(`Resume failed: ${res.error}`, "error");
    showToast(res.error, "error");
    progressWrap.classList.add("hidden");
  }
});

function doExport(format) {
  const session = lastSession;
  if (!session?.length) { showToast("No session to export", "error"); return; }
  if (format === "json") {
    const blob = new Blob([JSON.stringify(session, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `paused_ads_${Date.now()}.json`; a.click();
  } else {
    const headers = ["ad_id", "ad_name", "campaign_id", "campaign_name", "adset_id", "page_id", "page_name", "boost_id", "paused_at"];
    const rows = session.map(r => headers.map(h => {
      const v = h === "boost_id" ? r.effective_object_story_id : r[h] || "";
      return `"${String(v).replace(/"/g, '""')}"`;
    }).join(","));
    const csv = [headers.join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `paused_ads_${Date.now()}.csv`; a.click();
  }
  log(`Exported ${session.length} records as ${format.toUpperCase()}`, "success");
}

exportCsv.addEventListener("click", () => doExport("csv"));
exportJson.addEventListener("click", () => doExport("json"));
$("clearLog").addEventListener("click", () => logsEl.innerHTML = "");

loadState();
