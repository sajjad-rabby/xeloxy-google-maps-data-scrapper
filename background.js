// Xeloxy Google Maps Data Scrapper v3 - background engine.
//
// Design notes
// ------------
// * The popup is a live view only. All state lives in chrome.storage.local
//   and every write goes through one serialised queue, so a log line can
//   never clobber a row that was just scraped.
// * The run is resumable at row granularity. detailIndex / emailIndex are
//   written in the SAME storage transaction as the row they belong to, so a
//   worker restart can never skip or duplicate a row.
// * A 30 second alarm keeps the worker alive and, if the worker was killed
//   mid-run, resumes the run automatically.
// * Email discovery is tiered: mailto links beat visible text, which beats
//   structured data, which beats raw markup. The winner is then ranked
//   against the business name and the website domain.

import { collectMapsFeed, extractPlaceDetail, harvestPageEmails } from './lib/injected.js';
import {
  extractEmails, pickBestEmail, findContactUrls, commonContactPaths,
  hostOf, tierOf, isValidEmail
} from './lib/email.js';
import { buildXlsx } from './lib/xlsx.js';

const VERSION = '3.0.0';
const DEVELOPER = 'Sajjad Rabby';
const GITHUB = 'https://github.com/sajjad-rabby';

const COLUMNS = [
  'name', 'phone', 'address', 'email', 'rating', 'reviews', 'category',
  'website', 'hours', 'latitude', 'longitude', 'maps_url',
  'email_confidence', 'email_source'
];

const WIDTHS = [30, 18, 34, 30, 8, 10, 20, 34, 34, 12, 12, 40, 16, 14];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (base) => base + Math.random() * 700;

/* ------------------------------------------------------------- run state */

function freshRun() {
  return {
    status: 'idle',
    phase: '',
    rows: [],
    log: [],
    params: null,
    mapsTabId: null,
    searchUrl: '',
    stop: false,
    startedAt: 0,
    lastBeat: 0,
    feedDone: false,
    detailIndex: 0,
    emailIndex: 0,
    stats: {
      feed: { found: 0, target: 0 },
      details: { done: 0, total: 0, ok: 0, failed: 0 },
      emails: { done: 0, total: 0, found: 0, sites: 0, deep: 0 }
    },
    error: ''
  };
}

async function getRun() {
  const s = await chrome.storage.local.get(['gmRun']);
  return s.gmRun || freshRun();
}

// Every mutation of the run goes through this queue. Without it, a log write
// and a row write can interleave and the slower one wins, losing scraped data.
let writeChain = Promise.resolve();

function mutate(mutator) {
  const p = writeChain.then(async () => {
    const cur = await getRun();
    const patch = (await mutator(cur)) || {};
    const next = { ...cur, ...patch, lastBeat: Date.now() };
    await chrome.storage.local.set({ gmRun: next });
    return next;
  });
  writeChain = p.catch(() => {});
  return p;
}

async function blog(msg) {
  await mutate((cur) => ({ log: [...(cur.log || []), msg].slice(-80) }));
}

async function stopFlag() {
  return (await getRun()).stop;
}

/* --------------------------------------------------------------- helpers */

async function waitTabComplete(tabId, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t.status === 'complete') return true;
    } catch (e) {
      return false;
    }
    await sleep(500);
  }
  return false;
}

async function waitForInTab(tabId, fn, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await chrome.scripting.executeScript({ target: { tabId }, func: fn });
      if (r?.[0]?.result) return true;
    } catch (e) { /* page may be navigating */ }
    await sleep(700);
  }
  return false;
}

async function pageIsBlocked(tabId) {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const t = ((document.title || '') + ' ' + (document.body?.innerText || '').slice(0, 1500)).toLowerCase();
        return t.includes('unusual traffic') || t.includes('/sorry/') ||
          (t.includes('captcha') && t.includes('google')) ||
          t.includes('our systems have detected');
      }
    });
    return !!r?.[0]?.result;
  } catch (e) {
    return false;
  }
}

/** Fetches a page as text. Host permissions bypass CORS for static sites. */
async function bgGet(url, timeoutMs) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs || 15000);
  try {
    const r = await fetch(url, { signal: c.signal, redirect: 'follow' });
    if (!r.ok) return null;
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('html') && !ct.includes('text')) return null;
    return await r.text();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/* ---------------------------------------------------------- email hunting */

/**
 * Renders a site in an inactive tab and reads the DOM. This is the only way
 * to find addresses on JavaScript-built sites (Squarespace, Wix, GoDaddy,
 * Shopify and friends) where the address never appears in the raw HTML.
 */
async function deepScan(url) {
  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id;
    await waitTabComplete(tabId, 20000);
    await sleep(2500);
    const r = await chrome.scripting.executeScript({ target: { tabId }, func: harvestPageEmails });
    return r?.[0]?.result || null;
  } catch (e) {
    return null;
  } finally {
    if (tabId) {
      try { await chrome.tabs.remove(tabId); } catch (e) { /* already gone */ }
    }
  }
}

function confidenceOf(tier) {
  if (tier <= 2) return 'high';
  if (tier === 3) return 'medium';
  return 'low';
}

/** A candidate good enough to stop looking for. */
function goodEnough(candidates, name, website) {
  const best = pickBestEmail(candidates, name, website);
  return best && best.score >= 12 ? best : null;
}

/**
 * Hunts for an email address for one business.
 * Returns { email, confidence, source, alternates[] }.
 */
async function huntEmail(row, params) {
  const website = row.website;
  const name = row.name || '';
  const depth = params.emailDepth || 'balanced';
  const candidates = [];
  const visited = new Set();
  let deepUsed = false;

  const addHtml = (html) => {
    if (!html) return;
    for (const c of extractEmails(html)) candidates.push(c);
  };

  // 1. The homepage.
  const home = await bgGet(website, 15000);
  addHtml(home);

  // 2. Contact pages linked from the homepage.
  if (home) {
    const links = findContactUrls(home, website, true).slice(0, depth === 'fast' ? 1 : 3);
    for (const l of links) {
      if (visited.has(l.url)) continue;
      visited.add(l.url);
      addHtml(await bgGet(l.url, 12000));
      if (goodEnough(candidates, name, website)) break;
    }
  }

  // 3. Common contact paths, for sites with no obvious contact link.
  if (!goodEnough(candidates, name, website) && depth !== 'fast') {
    for (const p of commonContactPaths(website).slice(0, 4)) {
      if (visited.has(p)) continue;
      visited.add(p);
      addHtml(await bgGet(p, 10000));
      if (goodEnough(candidates, name, website)) break;
    }
  }

  // 4. Render the page and read the DOM - catches JS-only addresses.
  if (!goodEnough(candidates, name, website) && params.deepEmail) {
    deepUsed = true;
    const deep = await deepScan(website);
    if (deep) {
      for (const e of deep.emails || []) {
        candidates.push({ email: e.email, tier: tierOf(e.source) });
      }
      // The rendered page may also reveal a contact link worth one more try.
      if (!goodEnough(candidates, name, website) && (deep.contactUrls || []).length) {
        for (const cu of deep.contactUrls.slice(0, 2)) {
          if (visited.has(cu)) continue;
          visited.add(cu);
          const deep2 = await deepScan(cu);
          if (deep2) {
            for (const e of deep2.emails || []) {
              candidates.push({ email: e.email, tier: tierOf(e.source) });
            }
          }
          if (goodEnough(candidates, name, website)) break;
        }
      }
    }
  }

  const best = pickBestEmail(candidates, name, website);
  if (!best) {
    return { email: '', confidence: '', source: deepUsed ? 'deep' : '', alternates: [] };
  }
  return {
    email: best.email,
    confidence: confidenceOf(best.tier),
    source: best.tier <= 2 ? 'page' : best.tier === 3 ? 'structured' : 'markup',
    alternates: best.alternates
  };
}

/* ------------------------------------------------------------- main engine */

let engineRunning = false;

async function runEngine(params, resume) {
  if (engineRunning) {
    await blog('A run is already in progress.');
    return;
  }
  engineRunning = true;

  try {
    let run = await getRun();
    if (run.status === 'running' && !resume) {
      await blog('A run is already in progress.');
      return;
    }

    let tabId = run.mapsTabId;
    let searchUrl = run.searchUrl;

    if (!resume) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        await mutate(() => ({ status: 'error', error: 'No active tab.' }));
        await blog('No active tab.');
        return;
      }
      tabId = tab.id;
      searchUrl = tab.url || '';
      await chrome.storage.local.set({ gmRun: { ...freshRun(), status: 'running', phase: 'feed', params, mapsTabId: tabId, searchUrl, stop: false, startedAt: Date.now(), lastBeat: Date.now(), log: [`Started: max ${params.maxResults}, scrolls ${params.maxScrolls}, delay ${params.delayMs}ms, email depth ${params.emailDepth || 'balanced'}`] } });
      await chrome.scripting.executeScript({ target: { tabId }, func: () => { window.__xeloxyMapsStop = false; } }).catch(() => {});
    } else {
      await mutate(() => ({ status: 'running', stop: false, error: '' }));
      run = await getRun();
      params = run.params || params;
      tabId = run.mapsTabId;
      searchUrl = run.searchUrl;
      await blog(`Resumed at row ${run.detailIndex + run.emailIndex + 1}.`);
    }

    const P = params;
    startKeepAlive();

    /* ---- Phase 1: feed ---- */
    if (!run.feedDone) {
      await mutate(() => ({ phase: 'feed' }));
      await blog(`Phase 1/3: scrolling the feed (max ${P.maxResults}, ${P.maxScrolls} scrolls)...`);
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        func: collectMapsFeed,
        args: [P.maxResults, P.maxScrolls, P.delayMs]
      });
      const rows = res?.[0]?.result?.rows || [];
      const reason = res?.[0]?.result?.reason || '?';
      await mutate((cur) => ({
        rows,
        feedDone: true,
        stats: {
          feed: { found: rows.length, target: P.maxResults },
          details: { done: 0, total: rows.length, ok: 0, failed: 0 },
          emails: { done: 0, total: rows.length, found: 0, sites: 0, deep: 0 }
        }
      }));
      await blog(`Feed done (${reason}): ${rows.length} places found.`);
      if (!rows.length) {
        await mutate(() => ({ status: 'done', phase: 'done' }));
        await blog('No places found. Scroll the left panel once manually, then press Start again.');
        stopKeepAlive();
        return;
      }
    } else {
      await blog(`Feed already collected (${run.rows.length} places).`);
    }

    /* ---- Phase 2: place details, same tab ---- */
    if (P.deepDetails) {
      await mutate(() => ({ phase: 'details' }));
      let cur = await getRun();
      for (let i = cur.detailIndex; i < cur.rows.length; i++) {
        if (await stopFlag()) {
          await mutate(() => ({ status: 'stopped' }));
          await blog('Stopped by user. Press Resume to carry on from here.');
          stopKeepAlive();
          return;
        }
        const row = cur.rows[i];
        await blog(`Detail ${i + 1}/${cur.rows.length}: ${(row.name || '').slice(0, 60)}`);

        let det = null;
        try {
          await chrome.tabs.update(tabId, { url: row.maps_url });
          await waitTabComplete(tabId, 25000);
          await sleep(2200);
          if (await pageIsBlocked(tabId)) {
            await mutate(() => ({ status: 'captcha', phase: 'details' }));
            await blog('CAPTCHA / unusual traffic. Solve it in the Maps tab, then press Resume - nothing is lost.');
            stopKeepAlive();
            return;
          }
          const ok = await waitForInTab(tabId, () => !!document.querySelector('h1'), 15000);
          if (ok) {
            const d = await chrome.scripting.executeScript({ target: { tabId }, func: extractPlaceDetail });
            det = d?.[0]?.result || null;
          } else {
            await blog(`Detail ${i + 1}: the place page did not render, keeping the card data.`);
          }
        } catch (e) {
          await blog(`Detail ${i + 1}: skipped (${String(e.message || e).slice(0, 80)}).`);
        }

        const ok = !!(det && !det.empty);
        await mutate((c) => {
          const rows = c.rows.slice();
          const base = rows[i] || {};
          rows[i] = {
            ...base,
            name: (det && det.name) || base.name || '',
            phone: (det && det.phone) || base.phone || '',
            address: (det && det.address) || base.address || '',
            website: (det && det.website) || base.website || '',
            rating: (det && det.rating) || base.rating || '',
            reviews: (det && det.reviews) || base.reviews || '',
            category: (det && det.category) || base.category || '',
            hours: (det && det.hours) || base.hours || '',
            latitude: (det && det.latitude) || base.latitude || '',
            longitude: (det && det.longitude) || base.longitude || '',
            _detailDone: true
          };
          const st = c.stats.details;
          return {
            rows,
            detailIndex: i + 1,
            stats: {
              ...c.stats,
              details: { ...st, done: i + 1, ok: st.ok + (ok ? 1 : 0), failed: st.failed + (ok ? 0 : 1) }
            }
          };
        });
        await sleep(jitter(1400));
      }

      try {
        if (searchUrl) {
          await chrome.tabs.update(tabId, { url: searchUrl });
          await waitTabComplete(tabId, 20000);
          await sleep(1800);
        }
      } catch (e) { /* the tab may have been closed */ }
      await blog('Details done. Back on the search page.');
    }

    /* ---- Phase 3: email hunt ---- */
    if (P.findEmail) {
      await mutate(() => ({ phase: 'emails' }));
      const cur = await getRun();
      for (let i = cur.emailIndex; i < cur.rows.length; i++) {
        if (await stopFlag()) {
          await mutate(() => ({ status: 'stopped' }));
          await blog('Stopped by user. Press Resume to carry on from here.');
          stopKeepAlive();
          return;
        }
        const row = cur.rows[i];
        if (!row.website || row.email) {
          // Nothing to hunt for. Still normalise the row so every row has the
          // same keys, and advance the cursor in the same transaction.
          await mutate((c) => {
            const rows = c.rows.slice();
            const base = rows[i] || {};
            rows[i] = {
              ...base,
              email: base.email || '',
              email_confidence: base.email_confidence || '',
              email_source: base.email_source || '',
              _emailDone: true
            };
            const st = c.stats.emails;
            return {
              rows,
              emailIndex: i + 1,
              stats: { ...c.stats, emails: { ...st, done: i + 1 } }
            };
          });
          continue;
        }

        await blog(`Email ${i + 1}/${cur.rows.length}: ${(row.name || '').slice(0, 60)}`);
        let found = { email: '', confidence: '', source: '', alternates: [] };
        try {
          found = await huntEmail(row, P);
        } catch (e) {
          await blog(`Email ${i + 1}: failed (${String(e.message || e).slice(0, 80)}).`);
        }

        await mutate((c) => {
          const rows = c.rows.slice();
          const base = rows[i] || {};
          rows[i] = {
            ...base,
            email: found.email || base.email || '',
            email_confidence: found.email ? found.confidence : '',
            email_source: found.email ? found.source : '',
            email_alternates: found.alternates || [],
            _emailDone: true
          };
          const st = c.stats.emails;
          return {
            rows,
            emailIndex: i + 1,
            stats: {
              ...c.stats,
              emails: {
                ...st,
                done: i + 1,
                found: st.found + (found.email ? 1 : 0),
                sites: st.sites + 1,
                deep: st.deep + (found.source === 'deep' ? 1 : 0)
              }
            }
          };
        });
        await sleep(jitter(700));
      }
      await blog('Email hunt done.');
    }

    await mutate((c) => ({
      status: 'done',
      phase: 'done',
      rows: c.rows.map((r) => {
        const clean = { ...r };
        delete clean._detailDone;
        delete clean._emailDone;
        delete clean.email_alternates;
        return clean;
      })
    }));
    stopKeepAlive();

    const fin = await getRun();
    const phones = fin.rows.filter((r) => r.phone).length;
    const emails = fin.rows.filter((r) => r.email).length;
    const sites = fin.rows.filter((r) => r.website).length;
    await blog(`DONE: ${fin.rows.length} rows. Phones ${phones} | Emails ${emails} | Websites ${sites}.`);
    try {
      await autoExport();
      await blog('Auto-export done. The file is in your Downloads folder.');
    } catch (e) {
      await blog('Auto-export hiccup (your rows are safe): ' + String(e.message || e).slice(0, 120) + ' - use the Export buttons.');
    }
  } catch (e) {
    await mutate(() => ({ status: 'error', error: String(e.message || e).slice(0, 200) }));
    await blog('Error: ' + String(e.message || e).slice(0, 200) + ' - your rows are saved, press Resume.');
  } finally {
    engineRunning = false;
  }
}

/* ------------------------------------------------------------- keep alive */

function startKeepAlive() {
  chrome.alarms.create('gmKeepAlive', { periodInMinutes: 0.5 });
}

function stopKeepAlive() {
  chrome.alarms.clear('gmKeepAlive');
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'gmKeepAlive') return;
  const run = await getRun();
  if (run.status !== 'running') {
    stopKeepAlive();
    return;
  }
  // If the heartbeat has gone stale the worker was killed mid-run. Resume it
  // automatically so a long scrape survives a service worker restart.
  if (run.lastBeat && Date.now() - run.lastBeat > 90000) {
    await blog('Worker restarted - resuming automatically.');
    runEngine(run.params || {}, true);
  }
});

/* ---------------------------------------------------------------- export */

function filterRows(rows, minRating, requirePhone) {
  return (rows || []).filter((r) => {
    if (minRating > 0 && parseFloat(r.rating || '0') < minRating) return false;
    if (requirePhone && !r.phone) return false;
    return true;
  });
}

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(rows) {
  const lines = [COLUMNS.join(',')];
  for (const r of rows) lines.push(COLUMNS.map((k) => csvEscape(r[k])).join(','));
  // UTF-8 BOM so Excel reads the file as UTF-8.
  return '\uFEFF' + lines.join('\r\n');
}

function bytesToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function downloadBytes(bytes, filename, mime) {
  // Service workers have no DOM, but URL.createObjectURL and Blob do exist.
  try {
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename, saveAs: false }, () => {
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) { /* gone */ } }, 30000);
    });
    return;
  } catch (e) {
    // Fall back to a data URL.
    const url = 'data:' + mime + ';base64,' + bytesToBase64(bytes);
    chrome.downloads.download({ url, filename, saveAs: false });
  }
}

function downloadText(text, filename, mime) {
  downloadBytes(new TextEncoder().encode(text), filename, mime);
}

async function autoExport() {
  const run = await getRun();
  const P = run.params || {};
  const rows = filterRows(run.rows, parseFloat(P.minRating || '0'), !!P.requirePhone);
  if (!rows.length) return;
  const base = String(P.fileName || 'maps-leads').replace(/[^\w\-]+/g, '-');
  const fmt = P.fmt || 'csv';

  if (fmt === 'csv' || fmt === 'both') {
    downloadText(toCsv(rows), base + '.csv', 'text/csv;charset=utf-8');
  }
  if (fmt === 'xlsx' || fmt === 'both') {
    const bytes = buildXlsx(COLUMNS, rows.map((r) => COLUMNS.map((k) => r[k] ?? '')), {
      sheetName: 'Leads',
      widths: WIDTHS
    });
    downloadBytes(bytes, base + '.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }
}

/* --------------------------------------------------------------- messages */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'START': {
          await chrome.storage.local.set({ gmParams: msg.params });
          // Respond straight away - the engine runs detached so the popup can
          // be closed without stopping the scrape.
          runEngine(msg.params, false).catch((e) => {
            mutate(() => ({ status: 'error', error: String(e.message || e).slice(0, 200) }));
          });
          sendResponse({ ok: true });
          break;
        }

        case 'RESUME': {
          const r = await getRun();
          runEngine(r.params || msg.params, true).catch((e) => {
            mutate(() => ({ status: 'error', error: String(e.message || e).slice(0, 200) }));
          });
          sendResponse({ ok: true });
          break;
        }

        case 'STOP': {
          await mutate(() => ({ stop: true }));
          const r = await getRun();
          if (r.mapsTabId) {
            chrome.scripting.executeScript({
              target: { tabId: r.mapsTabId },
              func: () => { window.__xeloxyMapsStop = true; }
            }).catch(() => {});
          }
          await blog('Stop requested - finishing the current item.');
          sendResponse({ ok: true });
          break;
        }

        case 'RESET': {
          await mutate(() => ({ stop: true }));
          const r0 = await getRun();
          if (r0.mapsTabId) {
            chrome.scripting.executeScript({
              target: { tabId: r0.mapsTabId },
              func: () => { window.__xeloxyMapsStop = true; }
            }).catch(() => {});
          }
          stopKeepAlive();
          await chrome.storage.local.set({
            gmRun: { ...freshRun(), log: ['Session cleared. Set your options and press Start for a fresh run.'] }
          });
          sendResponse({ ok: true });
          break;
        }

        case 'EXPORT': {
          try {
            const run = await getRun();
            const P = run.params || {};
            const rows = filterRows(run.rows, parseFloat(P.minRating || '0'), !!P.requirePhone);
            if (!rows.length) {
              await blog('Nothing to export.');
              sendResponse({ ok: false, error: 'No rows to export.' });
              return;
            }
            const base = String(P.fileName || 'maps-leads').replace(/[^\w\-]+/g, '-');
            if (msg.fmt === 'csv') {
              downloadText(toCsv(rows), base + '.csv', 'text/csv;charset=utf-8');
            } else {
              const bytes = buildXlsx(COLUMNS, rows.map((r) => COLUMNS.map((k) => r[k] ?? '')), {
                sheetName: 'Leads',
                widths: WIDTHS
              });
              downloadBytes(bytes, base + '.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            }
            await blog(`Exported ${rows.length} rows as ${msg.fmt.toUpperCase()}. Check your Downloads folder.`);
            sendResponse({ ok: true, count: rows.length });
          } catch (e) {
            await blog('Export failed: ' + String(e.message || e).slice(0, 150) + ' - your rows are still saved, try again.');
            sendResponse({ ok: false, error: String(e.message || e).slice(0, 150) });
          }
          break;
        }

        case 'GET_RUN': {
          sendResponse({ ok: true, run: await getRun(), version: VERSION, developer: DEVELOPER, github: GITHUB });
          break;
        }

        default:
          sendResponse({ ok: false, error: 'Unknown message type.' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e.message || e).slice(0, 200) });
    }
  })();
  return true;
});
