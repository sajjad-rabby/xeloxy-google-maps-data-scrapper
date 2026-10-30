// Xeloxy Maps Data Scrapper v3 - popup.
//
// The popup is a live view. It never owns the run: it reads the run state
// from chrome.storage.local and sends commands to the background engine.

const $ = (id) => document.getElementById(id);

const state = {
  run: null,
  mapsTab: null,
  timer: null
};

const PHASE_LABEL = {
  feed: 'scrolling the results feed',
  details: 'reading place details',
  emails: 'hunting for email addresses',
  done: 'finished'
};

const DEPTH_HINT = {
  fast: 'Homepage plus one contact page. Quickest, lowest hit rate.',
  balanced: 'Homepage plus up to 3 contact pages and 4 common contact paths.',
  deep: 'Everything in Balanced, plus more contact pages and a rendered-page scan.'
};

/* ------------------------------------------------------------ helpers */

function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { t.hidden = true; }, 2600);
}

function fmtElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function fmtEta(seconds) {
  if (!isFinite(seconds) || seconds <= 0) return '--';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

/** Overall progress across the three phases, weighted by how long each takes. */
function overallPct(run) {
  const st = (run && run.stats) || {};
  const feed = st.feed || { found: 0, target: 0 };
  const det = st.details || { done: 0, total: 0 };
  const em = st.emails || { done: 0, total: 0 };

  const feedPct = feed.target ? Math.min(1, feed.found / feed.target) : 0;
  const detPct = det.total ? det.done / det.total : 0;
  const emPct = em.total ? em.done / em.total : 0;

  if (run.status === 'done') return 100;
  if (run.phase === 'feed') return Math.round(15 * feedPct);
  if (run.phase === 'details') return Math.round(15 + 55 * detPct);
  if (run.phase === 'emails') return Math.round(70 + 30 * emPct);
  return 0;
}

/* ------------------------------------------------------------- render */

function render(run) {
  state.run = run || { status: 'idle', phase: '', rows: [], log: [], stats: {} };
  const r = state.run;
  const rows = r.rows || [];
  const st = r.stats || {};
  const feed = st.feed || { found: 0, target: 0 };
  const det = st.details || { done: 0, total: 0 };
  const em = st.emails || { done: 0, total: 0 };

  const phones = rows.filter((x) => x.phone).length;
  const emails = rows.filter((x) => x.email).length;
  const sites = rows.filter((x) => x.website).length;

  // --- status pill ---
  const pill = $('statusPill');
  let pillText = 'Idle';
  let pillClass = '';
  if (r.status === 'running') { pillText = 'Running'; pillClass = 'running'; }
  else if (r.status === 'done') { pillText = 'Finished'; pillClass = 'done'; }
  else if (r.status === 'stopped') { pillText = 'Stopped'; pillClass = 'warn'; }
  else if (r.status === 'captcha') { pillText = 'Captcha'; pillClass = 'warn'; }
  else if (r.status === 'error') { pillText = 'Error'; pillClass = 'error'; }
  pill.textContent = pillText;
  pill.className = 'pill ' + pillClass;

  // --- status detail ---
  let detail = 'Not started';
  if (r.status === 'running') detail = PHASE_LABEL[r.phase] || r.phase || 'working';
  else if (r.status === 'done') detail = `${rows.length} leads collected`;
  else if (r.status === 'stopped') detail = 'Paused - press Resume to continue';
  else if (r.status === 'captcha') detail = 'Solve the captcha in the Maps tab, then Resume';
  else if (r.status === 'error') detail = r.error || 'Something went wrong';
  $('statusDetail').textContent = detail;

  // --- elapsed ---
  $('elapsed').textContent = r.startedAt ? fmtElapsed(Date.now() - r.startedAt) : '00:00';

  // --- steps ---
  const stepState = (name, done, total, active) => {
    const el = document.querySelector(`.step[data-step="${name}"]`);
    if (!el) return;
    el.classList.toggle('done', !!done);
    el.classList.toggle('active', !!active);
  };
  stepState('feed', feed.found > 0 && r.phase !== 'feed', feed.found, r.phase === 'feed');
  stepState('details', det.total > 0 && det.done >= det.total, det.done, r.phase === 'details');
  stepState('emails', em.total > 0 && em.done >= em.total, em.done, r.phase === 'emails');

  $('stepFeed').textContent = feed.found ? `${feed.found}` : '-';
  $('stepDetails').textContent = det.total ? `${det.done}/${det.total}` : '-';
  $('stepEmails').textContent = em.total ? `${em.done}/${em.total}` : '-';

  // --- bar ---
  const pct = overallPct(r);
  $('barFill').style.width = pct + '%';

  let barText = 'Ready when you are.';
  if (r.status === 'running') {
    barText = `${pct}% - ${rows.length} rows so far, ${emails} email${emails === 1 ? '' : 's'} found`;
  } else if (r.status === 'done') {
    barText = `Finished - ${rows.length} rows, ${emails} with email, ${phones} with phone`;
  } else if (r.status === 'stopped') {
    barText = `Paused at ${pct}% - ${rows.length} rows kept`;
  } else if (r.status === 'captcha') {
    barText = `Paused at ${pct}% - waiting for you to solve the captcha`;
  } else if (r.status === 'error') {
    barText = `Stopped at ${pct}% - ${rows.length} rows are safe`;
  }
  $('barText').textContent = barText;

  // --- tiles ---
  $('statPlaces').textContent = rows.length;
  $('statPhones').textContent = phones;
  $('statEmails').textContent = emails;
  $('statSites').textContent = sites;

  // --- ETA ---
  let eta = '--';
  if (r.status === 'running' && r.startedAt && pct > 3) {
    const elapsed = Date.now() - r.startedAt;
    eta = fmtEta((elapsed / pct) * (100 - pct) / 1000);
  }
  $('statEta').textContent = eta;

  // --- current item ---
  const cur = $('current');
  if (r.status === 'running' && r.phase) {
    cur.hidden = false;
    // Show the row the engine is actually working on, not simply the last one
    // collected - during the detail phase that is the next row in the list.
    let idx = -1;
    if (r.phase === 'details') idx = r.detailIndex;
    else if (r.phase === 'emails') idx = r.emailIndex;
    const active = idx >= 0 && idx < rows.length ? rows[idx] : rows[rows.length - 1];
    $('currentValue').textContent = active && active.name
      ? active.name
      : (r.phase === 'feed' ? 'collecting places...' : 'working...');
  } else {
    cur.hidden = true;
  }

  // --- buttons ---
  const running = r.status === 'running';
  $('start').disabled = running;
  $('stop').disabled = !running;
  $('resume').disabled = running || !rows.length || r.status === 'done';
  $('expCsv').disabled = !rows.length;
  $('expXlsx').disabled = !rows.length;
  $('expCopy').disabled = !rows.length;

  // --- results table ---
  $('previewCount').textContent = rows.length;
  const body = $('resultsBody');
  body.textContent = '';
  if (!rows.length) {
    const tr = document.createElement('tr');
    tr.className = 'empty';
    const td = document.createElement('td');
    td.colSpan = 4;
    td.textContent = 'No leads yet';
    tr.appendChild(td);
    body.appendChild(tr);
  } else {
    const frag = document.createDocumentFragment();
    for (const row of rows.slice(-60).reverse()) {
      const tr = document.createElement('tr');

      const tdName = document.createElement('td');
      tdName.textContent = row.name || '';
      tr.appendChild(tdName);

      const tdPhone = document.createElement('td');
      tdPhone.textContent = row.phone || '-';
      tr.appendChild(tdPhone);

      const tdEmail = document.createElement('td');
      tdEmail.className = 'email ' + (row.email ? (row.email_confidence === 'low' ? 'low' : '') : 'none');
      tdEmail.textContent = row.email || '-';
      if (row.email && row.email_confidence) tdEmail.title = `confidence: ${row.email_confidence}`;
      tr.appendChild(tdEmail);

      const tdSite = document.createElement('td');
      if (row.website) {
        const a = document.createElement('a');
        a.href = row.website;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = row.website.replace(/^https?:\/\//, '').replace(/\/$/, '').slice(0, 40);
        a.style.color = 'var(--accent)';
        a.style.textDecoration = 'none';
        tdSite.appendChild(a);
      } else {
        tdSite.textContent = '-';
      }
      tr.appendChild(tdSite);

      frag.appendChild(tr);
    }
    body.appendChild(frag);
  }

  // --- log ---
  const log = (r.log || []).slice(-40).join('\n');
  $('log').textContent = log || 'Ready. Search something on Google Maps first, for example "dentists in Austin".';
  $('log').scrollTop = $('log').scrollHeight;
}

/* ------------------------------------------------------------- target */

async function checkTarget() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: '*://*.google.com/maps*' });
  } catch (e) {
    tabs = [];
  }
  const dot = $('targetDot');
  const title = $('targetTitle');
  const sub = $('targetSub');

  if (tabs && tabs.length) {
    const t = tabs[tabs.length - 1];
    state.mapsTab = t;
    dot.className = 'dot ok';
    title.textContent = 'Google Maps tab ready';
    const q = decodeURIComponent((t.url || '').split('?')[1] || '').replace(/^q=/, '').split('&')[0];
    sub.textContent = q ? `Search: ${q}` : 'Run a search in the left panel, then press Start.';
  } else {
    state.mapsTab = null;
    dot.className = 'dot bad';
    title.textContent = 'No Google Maps tab found';
    sub.textContent = 'Open google.com/maps and run a search first.';
  }
}

/* ------------------------------------------------------------ actions */

function readParams() {
  return {
    maxResults: Math.max(5, Math.min(100, parseInt($('maxResults').value || '20', 10))),
    maxScrolls: Math.max(2, Math.min(30, parseInt($('maxScrolls').value || '8', 10))),
    delayMs: Math.max(1000, Math.min(8000, parseInt($('delayMs').value || '2200', 10))),
    deepDetails: $('deepDetails').checked,
    findEmail: $('findEmail').checked,
    deepEmail: $('deepEmail').checked,
    minRating: parseFloat($('minRating').value || '0'),
    requirePhone: $('requirePhone').checked,
    emailDepth: (document.querySelector('input[name="emailDepth"]:checked') || {}).value || 'balanced',
    fmt: (document.querySelector('input[name="fmt"]:checked') || {}).value || 'csv',
    fileName: ($('fileName').value || 'maps-leads').trim()
  };
}

$('start').addEventListener('click', async () => {
  await checkTarget();
  if (!state.mapsTab) {
    showToast('Open a Google Maps search first');
    return;
  }
  const params = readParams();
  await chrome.storage.local.set({ gmParams: params });
  chrome.runtime.sendMessage({ type: 'START', params });
  showToast('Scraping started');
  setTimeout(refresh, 250);
});

$('stop').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'STOP' });
  showToast('Stopping after the current item');
});

$('resume').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'RESUME', params: readParams() });
  showToast('Resuming');
  setTimeout(refresh, 250);
});

$('reset').addEventListener('click', () => {
  if (!confirm('Reset? This stops the run and clears every scraped row.')) return;
  chrome.runtime.sendMessage({ type: 'RESET' });
  showToast('Session cleared');
  setTimeout(refresh, 250);
});

$('expCsv').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'EXPORT', fmt: 'csv' });
  showToast('Exporting CSV');
});

$('expXlsx').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'EXPORT', fmt: 'xlsx' });
  showToast('Exporting XLSX');
});

$('expCopy').addEventListener('click', async () => {
  const rows = (state.run && state.run.rows) || [];
  if (!rows.length) return;
  const cols = ['name', 'phone', 'address', 'email', 'rating', 'reviews', 'category', 'website', 'hours', 'latitude', 'longitude', 'maps_url'];
  const tsv = [cols.join('\t')]
    .concat(rows.map((r) => cols.map((c) => String(r[c] ?? '').replace(/[\t\r\n]+/g, ' ')).join('\t')))
    .join('\n');
  try {
    await navigator.clipboard.writeText(tsv);
    showToast(`${rows.length} rows copied to the clipboard`);
  } catch (e) {
    showToast('Could not copy - use the CSV export instead');
  }
});

$('openMaps').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://www.google.com/maps' });
});

document.querySelectorAll('input[name="emailDepth"]').forEach((r) => {
  r.addEventListener('change', () => {
    $('depthHint').textContent = DEPTH_HINT[r.value] || '';
  });
});

/* -------------------------------------------------------------- init */

async function refresh() {
  const s = await chrome.storage.local.get(['gmRun']);
  render(s.gmRun);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.gmRun) render(changes.gmRun.newValue);
});

(async function init() {
  const meta = await chrome.runtime.sendMessage({ type: 'GET_RUN' }).catch(() => null);
  if (meta && meta.version) $('version').textContent = 'v' + meta.version;
  await refresh();
  await checkTarget();
  setInterval(refresh, 1000);
  setInterval(checkTarget, 5000);
})();
