// Integration test for the background engine against a mock Chrome API.
//
// It exercises the three-phase run, the resume cursors, the storage write
// queue and both export formats.

import { collectMapsFeed, extractPlaceDetail, harvestPageEmails } from '../lib/injected.js';

/* ------------------------------------------------------------- mock chrome */

const store = {};
const downloads = [];
const blobs = [];
const alarms = {};
let messageListener = null;
let nextTabId = 100;

const FEED_ROWS = [
  {
    name: 'Ross Natural Therapy', phone: '(512) 555-0142', address: '123 Main St, Austin, TX',
    website: 'https://rossnt.com', rating: '4.8', reviews: '127', category: 'Alternative Medicine',
    hours: 'Mon-Fri 8am-5pm', latitude: '30.2672', longitude: '-97.7431',
    maps_url: 'https://www.google.com/maps/place/rossnt'
  },
  {
    name: 'Ampersand Clinic', phone: '(512) 555-0199', address: '456 Oak Ave, Austin, TX',
    website: 'https://ampersand.com', rating: '4.5', reviews: '42', category: 'Clinic',
    hours: 'Mon-Sat 9am-6pm', latitude: '30.2501', longitude: '-97.7201',
    maps_url: 'https://www.google.com/maps/place/ampersand'
  },
  {
    name: 'No Site Dental', phone: '', address: '789 Pine Rd, Austin, TX',
    website: '', rating: '4.1', reviews: '9', category: 'Dentist',
    hours: '', latitude: '', longitude: '',
    maps_url: 'https://www.google.com/maps/place/nosite'
  }
];

const DETAILS = {
  'https://www.google.com/maps/place/rossnt': {
    name: 'Ross Natural Therapy', phone: '(512) 555-0142', address: '123 Main St, Austin, TX 78701',
    website: 'https://rossnt.com', rating: '4.8', reviews: '127', category: 'Alternative Medicine',
    hours: 'Mon-Fri 8am-5pm', latitude: '30.2672', longitude: '-97.7431', empty: false
  },
  'https://www.google.com/maps/place/ampersand': {
    name: 'Ampersand Clinic', phone: '(512) 555-0199', address: '456 Oak Ave, Austin, TX 78702',
    website: 'https://ampersand.com', rating: '4.5', reviews: '42', category: 'Clinic',
    hours: 'Mon-Sat 9am-6pm', latitude: '30.2501', longitude: '-97.7201', empty: false
  },
  'https://www.google.com/maps/place/nosite': { empty: true }
};

const SITES = {
  'https://rossnt.com/': `<html><body><a href="mailto:kim@rossnt.com">Mail</a>
    <a href="/contact">Contact</a><a href="/blog/post">Blog</a></body></html>`,
  'https://rossnt.com/contact': `<html><body><p>Reach Dr Kim Ross at kim@rossnt.com</p></body></html>`,
  'https://ampersand.com/': `<html><body><p>Questions? info@ampersand.com</p>
    <a href="/contact-us">Contact</a></body></html>`,
  'https://ampersand.com/contact-us': `<html><body><p>info@ampersand.com</p></body></html>`
};

let currentTabUrl = 'https://www.google.com/maps/search/dentists+austin';

globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        if (keys == null) return { ...store };
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of list) if (k in store) out[k] = store[k];
        return out;
      },
      async set(obj) { Object.assign(store, obj); }
    }
  },
  tabs: {
    async query(q) {
      if (q && q.active) return [{ id: 7, url: currentTabUrl, status: 'complete' }];
      return [{ id: 7, url: currentTabUrl, status: 'complete' }];
    },
    async get(id) { return { id, url: currentTabUrl, status: 'complete' }; },
    async update(id, opts) { if (opts && opts.url) currentTabUrl = opts.url; return { id, url: currentTabUrl, status: 'complete' }; },
    async create(opts) { const id = nextTabId++; return { id, url: opts.url, status: 'complete' }; },
    async remove(id) { /* gone */ }
  },
  scripting: {
    async executeScript({ func, args }) {
      if (func === collectMapsFeed) {
        return [{ result: { rows: FEED_ROWS.slice(0, args[0]), reason: 'target reached' } }];
      }
      if (func === extractPlaceDetail) {
        const d = DETAILS[currentTabUrl];
        return [{ result: d || { empty: true } }];
      }
      if (func === harvestPageEmails) {
        return [{ result: { emails: [{ email: 'deep@rossnt.com', source: 'visible' }], contactUrls: [] } }];
      }
      // The h1 readiness probe.
      if (String(func).includes('querySelector')) return [{ result: true }];
      // The captcha probe.
      if (String(func).includes('unusual traffic')) return [{ result: false }];
      // The stop-flag setter.
      return [{ result: undefined }];
    }
  },
  alarms: {
    create(name, info) { alarms[name] = info; },
    clear(name) { delete alarms[name]; },
    onAlarm: { addListener() { /* not fired in tests */ } }
  },
  runtime: {
    onMessage: { addListener(fn) { messageListener = fn; } }
  },
  downloads: {
    download(opts, cb) { downloads.push(opts); if (cb) cb(1); }
  }
};

globalThis.URL.createObjectURL = (blob) => { blobs.push(blob); return 'blob:mock/' + blobs.length; };
globalThis.URL.revokeObjectURL = () => {};

globalThis.fetch = async (url) => {
  const html = SITES[String(url)];
  if (!html) return { ok: false, status: 404, headers: { get: () => 'text/html' }, text: async () => '' };
  return { ok: true, status: 200, headers: { get: () => 'text/html; charset=utf-8' }, text: async () => html };
};

function sendMessage(msg) {
  return new Promise((resolve) => {
    messageListener(msg, {}, resolve);
  });
}

/* ------------------------------------------------------------------ tests */

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + label); }
  else { fail++; console.log('FAIL  ' + label + (extra ? '\n        ' + extra : '')); }
}
function eq(label, actual, expected) {
  ok(label, JSON.stringify(actual) === JSON.stringify(expected),
    'expected: ' + JSON.stringify(expected) + '\n        actual:   ' + JSON.stringify(actual));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (predicate()) return true;
    await sleep(200);
  }
  console.log('        (timeout waiting for ' + label + ')');
  return false;
}

await import('../background.js');

/* ---- 1. a full run ---- */

const params = {
  maxResults: 3, maxScrolls: 5, delayMs: 1000, deepDetails: true,
  findEmail: true, deepEmail: false, minRating: 0, requirePhone: false,
  emailDepth: 'balanced', fmt: 'csv', fileName: 'test-leads'
};

const started = await sendMessage({ type: 'START', params });
ok('START is acknowledged immediately', started && started.ok === true);

const finished = await waitFor(() => store.gmRun && store.gmRun.status === 'done', 60000, 'run to finish');
ok('the run reaches the done state', finished);

const run = store.gmRun;
eq('all three places were collected', run.rows.length, 3);
eq('the detail cursor finished', run.detailIndex, 3);
eq('the email cursor finished', run.emailIndex, 3);
eq('the feed is marked done', run.feedDone, true);
eq('the final phase is done', run.phase, 'done');
eq('the detail counter matches', run.stats.details.done, 3);
eq('the email counter matches', run.stats.emails.done, 3);
eq('two emails were found', run.stats.emails.found, 2);
eq('the feed counter matches', run.stats.feed.found, 3);

ok('the first row kept its phone', run.rows[0].phone === '(512) 555-0142');
ok('the detail phase filled the full address', run.rows[0].address.includes('78701'));
ok('the category column is populated', run.rows[0].category === 'Alternative Medicine');
ok('the first row got an email', run.rows[0].email === 'kim@rossnt.com');
ok('the first row email is high confidence', run.rows[0].email_confidence === 'high');
ok('the second row got an email', run.rows[1].email === 'info@ampersand.com');
ok('the row without a website has no email', run.rows[2].email === '');
ok('the row without a website has no confidence', run.rows[2].email_confidence === '');
ok('internal flags are stripped from the final rows', !('_detailDone' in run.rows[0]) && !('email_alternates' in run.rows[0]));
ok('the log records the phases', run.log.some((l) => l.includes('Phase 1/3')) && run.log.some((l) => l.includes('DONE')));

/* ---- 2. the auto export ---- */

ok('an auto export was triggered', downloads.length >= 1);
const csvName = downloads[0] && downloads[0].filename;
eq('the auto export is a csv named after the file name', csvName, 'test-leads.csv');
const csvText = await blobs[0].text();
// Blob.text() runs the UTF-8 decode algorithm, which strips a leading BOM,
// so the BOM has to be checked on the raw bytes.
const csvBytes = new Uint8Array(await blobs[0].arrayBuffer());
ok('the csv starts with a UTF-8 BOM', csvBytes[0] === 0xEF && csvBytes[1] === 0xBB && csvBytes[2] === 0xBF,
  'first bytes: ' + Array.from(csvBytes.slice(0, 4)).map((b) => b.toString(16)).join(' '));
ok('the csv has the 14 column header', csvText.includes('name,phone,address,email,rating,reviews,category,website,hours,latitude,longitude,maps_url,email_confidence,email_source'));
ok('the csv holds every row', csvText.includes('Ross Natural Therapy') && csvText.includes('Ampersand Clinic') && csvText.includes('No Site Dental'));
ok('the csv holds the found email', csvText.includes('kim@rossnt.com'));

/* ---- 3. an explicit xlsx export ---- */

const before = downloads.length;
const exp = await sendMessage({ type: 'EXPORT', fmt: 'xlsx' });
ok('the xlsx export is acknowledged', exp && exp.ok === true);
eq('the xlsx export reports the row count', exp.count, 3);
ok('a second download was started', downloads.length === before + 1);
eq('the xlsx file is named correctly', downloads[before].filename, 'test-leads.xlsx');
const xlsxBytes = new Uint8Array(await blobs[before].arrayBuffer());
ok('the xlsx starts with the zip magic number', xlsxBytes[0] === 0x50 && xlsxBytes[1] === 0x4B);

/* ---- 4. GET_RUN ---- */

const meta = await sendMessage({ type: 'GET_RUN' });
eq('GET_RUN reports the version', meta.version, '3.0.0');
eq('GET_RUN reports the developer', meta.developer, 'Sajjad Rabby');
eq('GET_RUN reports the github link', meta.github, 'https://github.com/sajjad-rabby');

/* ---- 5. stop and resume ---- */

await sendMessage({ type: 'RESET' });
ok('RESET clears the rows', store.gmRun.rows.length === 0);
eq('RESET returns the run to idle', store.gmRun.status, 'idle');

await sendMessage({ type: 'START', params: { ...params, maxResults: 3 } });
await sleep(2500);
await sendMessage({ type: 'STOP' });
const stopped = await waitFor(() => store.gmRun.status === 'stopped', 30000, 'the run to stop');
ok('the run stops when asked', stopped);
const stoppedRun = store.gmRun;
ok('the stopped run kept its rows', stoppedRun.rows.length === 3);
ok('the stopped run kept its detail cursor', stoppedRun.detailIndex >= 1);

await sendMessage({ type: 'RESUME' });
const resumed = await waitFor(() => store.gmRun.status === 'done', 60000, 'the resumed run to finish');
ok('the resumed run finishes', resumed);
eq('the resumed run did not duplicate rows', store.gmRun.rows.length, 3);
eq('the resumed run finished the detail cursor', store.gmRun.detailIndex, 3);
eq('the resumed run finished the email cursor', store.gmRun.emailIndex, 3);
ok('the resumed run still found the emails', store.gmRun.rows[0].email === 'kim@rossnt.com');

/* ---- 6. the storage write queue ---- */

// Hammer the store with concurrent writes the way a log line and a scraped
// row would, then confirm nothing was lost.
const before2 = store.gmRun.rows.length;
await Promise.all([
  sendMessage({ type: 'EXPORT', fmt: 'csv' }),
  sendMessage({ type: 'GET_RUN' }),
  sendMessage({ type: 'GET_RUN' })
]);
eq('concurrent commands did not lose rows', store.gmRun.rows.length, before2);

/* ---- 7. an unknown message ---- */

const bad = await sendMessage({ type: 'NOPE' });
ok('an unknown message is rejected', bad && bad.ok === false);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
