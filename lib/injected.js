// Functions injected into pages with chrome.scripting.executeScript({ func }).
//
// IMPORTANT: Chrome serialises `func` by source, so every function here must
// be completely self-contained - it cannot close over anything in this module
// or any other scope. Keep them that way or the injection will throw.

/* ------------------------------------------------------------------ feed */

/**
 * Scrolls the Google Maps results feed and harvests the place cards.
 * Returns { rows, reason }.
 */
export async function collectMapsFeed(maxResults, maxScrolls, delayMs) {
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  const feed = document.querySelector('div[role="feed"]');
  if (!feed) return { rows: [], reason: 'no-feed' };

  const seen = new Map();
  let still = 0;
  let lastCount = -1;

  function cardOf(a) {
    return a.closest('[role="article"]') || a.closest('div[data-ved]') || a.parentElement;
  }

  function nameOf(a, card) {
    const aria = (a.getAttribute('aria-label') || '').trim();
    if (aria) return aria;
    if (card) {
      const h = card.querySelector('[role="heading"]');
      if (h) {
        const t = (h.innerText || '').trim();
        if (t) return t;
      }
      const legacy = card.querySelector('.qBF1Pd');
      if (legacy) {
        const t = (legacy.innerText || '').trim();
        if (t) return t;
      }
    }
    const first = (a.innerText || '').split('\n')[0].trim();
    return first || '';
  }

  function harvest() {
    const links = feed.querySelectorAll('a[href*="/maps/place/"]');
    for (const a of links) {
      if (seen.size >= maxResults) break;
      const href = (a.href || '').split('?')[0];
      if (!href.includes('/maps/place/') || seen.has(href)) continue;

      const card = cardOf(a);
      const name = nameOf(a, card);
      if (!name) continue;

      let rating = '';
      let reviews = '';
      let category = '';

      if (card) {
        const rEl = card.querySelector('span[aria-label*="star"], span[aria-label*="Star"]');
        if (rEl) {
          const m = (rEl.getAttribute('aria-label') || '').match(/([\d.]+)/);
          if (m) rating = m[1];
        }
        const rv = (card.innerText || '').match(/\(([\d,.]+[kK]?)\)/);
        if (rv) reviews = rv[1];

        // The category is the first short line that is not the name, a
        // rating/review line, a price, or an open/closed marker.
        const lines = (card.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
        for (const line of lines.slice(1)) {
          if (/^\(?[\d.]+\)?\s*(?:\(\d|stars?)/i.test(line)) continue;
          if (/^\(?[\d,.]+[kK]?\)?$/.test(line)) continue;
          if (/^(open|closed|·|\$)/i.test(line)) continue;
          if (line.length > 40) continue;
          category = line;
          break;
        }
      }

      seen.set(href, {
        name,
        rating,
        reviews,
        category,
        maps_url: href,
        phone: '',
        address: '',
        email: '',
        website: '',
        hours: '',
        latitude: '',
        longitude: ''
      });
    }
  }

  // Google Maps virtualises the feed, so a plain scrollTop assignment is not
  // always enough to trigger the next page of results. Try several ways.
  function scrollFeed() {
    feed.scrollTop = feed.scrollHeight;
    const last = feed.lastElementChild;
    if (last && last.scrollIntoView) {
      try { last.scrollIntoView({ block: 'end' }); } catch (e) { /* ignore */ }
    }
    // Some layouts put the scrollable element above the feed.
    let p = feed.parentElement;
    for (let i = 0; i < 4 && p; i++) {
      if (p.scrollHeight > p.clientHeight + 40) {
        p.scrollTop = p.scrollHeight;
        break;
      }
      p = p.parentElement;
    }
  }

  for (let s = 0; s < maxScrolls; s++) {
    if (window.__xeloxyMapsStop) return { rows: [...seen.values()], reason: 'stopped' };
    harvest();
    if (seen.size >= maxResults) {
      return { rows: [...seen.values()].slice(0, maxResults), reason: 'limit' };
    }

    const txt = (feed.innerText || '').toLowerCase();
    if (txt.includes("you've reached the end") || txt.includes('end of the list')) {
      harvest();
      return { rows: [...seen.values()].slice(0, maxResults), reason: 'end' };
    }

    if (seen.size === lastCount) still++;
    else { still = 0; lastCount = seen.size; }
    if (still >= 3 && seen.size > 0) {
      return { rows: [...seen.values()].slice(0, maxResults), reason: 'exhausted' };
    }

    scrollFeed();
    await delay(delayMs + Math.random() * 600);
  }

  harvest();
  return { rows: [...seen.values()].slice(0, maxResults), reason: 'scrolls-done' };
}

/* ---------------------------------------------------------------- detail */

/**
 * Reads the place detail panel of a Google Maps place page.
 * Returns a flat object; `empty: true` when the page has not rendered yet.
 */
export function extractPlaceDetail() {
  const out = {
    name: '', phone: '', address: '', website: '', rating: '', reviews: '',
    hours: '', category: '', latitude: '', longitude: ''
  };

  try { out.name = (document.querySelector('h1')?.innerText || '').trim(); } catch (e) { /* ignore */ }
  if (!out.name) return { ...out, empty: true };

  // --- phone ---
  try {
    const p = document.querySelector('button[data-item-id^="phone:tel:"], span[data-item-id^="phone:tel:"]');
    if (p) out.phone = ((p.getAttribute('aria-label') || p.innerText || '').replace(/^Phone:\s*/i, '')).trim();
    if (!out.phone) {
      const t = document.querySelector('a[href^="tel:"]');
      if (t) out.phone = (t.getAttribute('href') || '').replace(/^tel:/, '').trim();
    }
  } catch (e) { /* ignore */ }

  // --- address ---
  try {
    const a = document.querySelector('button[data-item-id="address"], span[data-item-id="address"], [data-item-id="address"]');
    if (a) {
      out.address = ((a.getAttribute('aria-label') || a.innerText || '').replace(/^Address:\s*/i, ''))
        .replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
    }
  } catch (e) { /* ignore */ }

  // --- website ---
  try {
    const w = document.querySelector(
      'a[data-item-id="authority"], button[data-item-id="authority"], [data-item-id="authority"] a, [data-item-id="authority"]'
    );
    let href = '';
    if (w) {
      href = w.getAttribute('href') || w.getAttribute('data-url') || '';
      if (!href) {
        const inner = w.querySelector('a[href]');
        if (inner) href = inner.getAttribute('href') || '';
      }
    }
    if (!href) {
      const fallback = Array.from(document.querySelectorAll('a[href^="/url?q="]'))
        .find((a) => /website|site/i.test(a.getAttribute('aria-label') || ''));
      if (fallback) href = fallback.getAttribute('href') || '';
    }
    if (href.includes('/url?q=')) {
      try { href = new URL(href, location.origin).searchParams.get('q') || href; } catch (e) { /* ignore */ }
    }
    if (href && !/^https?:\/\//i.test(href)) href = '';
    out.website = href;
  } catch (e) { /* ignore */ }

  // --- rating / reviews ---
  try {
    const r = document.querySelector('[aria-label*="stars"], [aria-label*="star rating"], [aria-label*="Rated"]');
    if (r) {
      const m = (r.getAttribute('aria-label') || '').match(/([\d.]+)/);
      if (m) out.rating = m[1];
    }
    const rv = document.querySelector('[aria-label*="reviews"], [aria-label*="Reviews"]');
    if (rv) {
      const m = (rv.getAttribute('aria-label') || '').match(/([\d,.]+[kK]?)/);
      if (m) out.reviews = m[1];
    }
  } catch (e) { /* ignore */ }

  // --- category ---
  try {
    const c = document.querySelector(
      'button[aria-label*="Category"], button[jsaction*="categoryButton"], [aria-label^="Category:"]'
    );
    if (c) {
      out.category = ((c.getAttribute('aria-label') || c.innerText || '').replace(/^Category:\s*/i, ''))
        .replace(/\n/g, ' ').trim().slice(0, 80);
    }
    if (!out.category) {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => {
        const t = (b.innerText || '').trim();
        return t && t.length < 40 && !/directions|save|close|share|photos|reviews|menu|website|phone/i.test(t);
      });
      if (btn) out.category = (btn.innerText || '').trim().slice(0, 80);
    }
  } catch (e) { /* ignore */ }

  // --- hours ---
  try {
    const h = document.querySelector('button[aria-label*="Hours"], div[aria-label*="Hours"], [aria-label*="Open hours"]');
    if (h) {
      out.hours = (h.getAttribute('aria-label') || h.innerText || '').replace(/\n/g, ' | ').slice(0, 400).trim();
    }
    if (!out.hours) {
      const rows = Array.from(document.querySelectorAll('div[role="table"] tr, table tr'))
        .map((tr) => (tr.innerText || '').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim())
        .filter((t) => /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/i.test(t));
      if (rows.length) out.hours = rows.join(' | ').slice(0, 400);
    }
  } catch (e) { /* ignore */ }

  // --- coordinates ---
  try {
    const href = location.href;
    let m = href.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (m) {
      out.latitude = m[1];
      out.longitude = m[2];
    } else {
      // Newer place URLs encode the centre as !3d<lat>!4d<lng>
      const d3 = href.match(/!3d(-?\d+\.\d+)/);
      const d4 = href.match(/!4d(-?\d+\.\d+)/);
      if (d3) out.latitude = d3[1];
      if (d4) out.longitude = d4[1];
    }
  } catch (e) { /* ignore */ }

  return out;
}

/* --------------------------------------------------------- deep harvesting */

/**
 * Reads a rendered business website for email addresses and contact links.
 * Used as the fallback for sites whose addresses are only injected by
 * JavaScript (Squarespace, Wix, GoDaddy, Shopify, ...).
 */
export function harvestPageEmails() {
  const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const VENDOR = /(sentry\.io|wixpress\.com|wix\.com|wixsite\.com|example\.com|example\.org|facebook\.com|fb\.com|localhost|typemade\.mx|squarespace\.com|shopify\.com|godaddy\.com|weebly\.com|wordpress\.com|blogger\.com|google\.com|domain\.com|yourdomain|email\.com|test\.com|mail\.com|cloudflare|cdn-cgi|schema\.org|gravatar|yelp\.com|tripadvisor|booking\.com|hotels\.com)/i;

  function valid(e) {
    if (!e || e.length > 80) return false;
    if (/\.(png|jpg|jpeg|gif|webp|svg|css|js|ico|woff2?)$/i.test(e)) return false;
    if (VENDOR.test(e)) return false;
    if (/^(noreply|no-reply|donotreply)@/i.test(e)) return false;
    return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(e);
  }

  function clean(e) {
    return (e || '').trim().toLowerCase().replace(/^mailto:/i, '').split('?')[0];
  }

  const high = new Set();
  const medium = new Set();
  const low = new Set();

  // mailto links
  for (const a of document.querySelectorAll('a[href^="mailto:"], a[href^="MAILTO:"]')) {
    const e = clean(a.getAttribute('href'));
    if (valid(e)) high.add(e);
  }

  // visible text (scripts and styles stripped)
  let visible = '';
  try {
    const clone = document.body ? document.body.cloneNode(true) : null;
    if (clone) {
      clone.querySelectorAll('script, style, noscript, template').forEach((n) => n.remove());
      visible = clone.innerText || clone.textContent || '';
    }
  } catch (e) { /* ignore */ }
  for (const m of visible.match(EMAIL_RE) || []) {
    const e = clean(m);
    if (valid(e)) high.add(e);
  }

  // structured data / meta / form hints
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    for (const m of (s.textContent || '').match(EMAIL_RE) || []) {
      const e = clean(m);
      if (valid(e)) medium.add(e);
    }
  }
  for (const m of document.querySelectorAll('meta[name*="mail" i], meta[property*="mail" i], meta[itemprop*="email" i]')) {
    for (const e of (m.getAttribute('content') || '').match(EMAIL_RE) || []) {
      const v = clean(e);
      if (valid(v)) medium.add(v);
    }
  }
  for (const i of document.querySelectorAll('input[type="email"], input[name*="email" i]')) {
    const v = clean(i.getAttribute('value') || i.getAttribute('placeholder') || '');
    if (valid(v)) medium.add(v);
  }

  // Cloudflare-obfuscated addresses
  for (const el of document.querySelectorAll('[data-cfemail]')) {
    const hex = el.getAttribute('data-cfemail') || '';
    try {
      const key = parseInt(hex.substr(0, 2), 16);
      let out = '';
      for (let i = 2; i + 1 < hex.length; i += 2) {
        out += String.fromCharCode(parseInt(hex.substr(i, 2), 16) ^ key);
      }
      const e = clean(out);
      if (valid(e)) medium.add(e);
    } catch (err) { /* ignore */ }
  }

  // same-origin iframes
  for (const f of document.querySelectorAll('iframe')) {
    try {
      if (!f.contentDocument) continue;
      const ft = f.contentDocument.body ? f.contentDocument.body.innerText : '';
      for (const m of ft.match(EMAIL_RE) || []) {
        const e = clean(m);
        if (valid(e)) high.add(e);
      }
    } catch (err) { /* cross-origin iframe */ }
  }

  // raw markup - lowest confidence, often the theme vendor's address
  let html = '';
  try { html = document.documentElement.outerHTML || ''; } catch (e) { /* ignore */ }
  for (const m of html.match(EMAIL_RE) || []) {
    const e = clean(m);
    if (valid(e)) low.add(e);
  }

  const emails = [];
  const seen = new Set();
  const push = (set, source) => {
    for (const e of set) {
      if (seen.has(e)) continue;
      seen.add(e);
      emails.push({ email: e, source });
    }
  };
  push(high, 'page');
  push(medium, 'structured');
  push(low, 'markup');

  // contact links worth trying next
  const origin = location.origin;
  const here = location.href.split('#')[0].replace(/\/$/, '').toLowerCase();
  const contactUrls = [];
  const cseen = new Set();
  for (const a of document.querySelectorAll('a[href]')) {
    let href;
    try { href = new URL(a.getAttribute('href'), location.href).href; } catch (e) { continue; }
    if (!href.startsWith(origin)) continue;
    if (!/contact|about|impressum|kontakt|enquir|reach-us|get-in-touch|support/i.test(href)) continue;
    const key = href.split('#')[0].replace(/\/$/, '').toLowerCase();
    if (cseen.has(key) || key === here) continue;
    cseen.add(key);
    contactUrls.push(href);
    if (contactUrls.length >= 4) break;
  }

  return { emails, contactUrls, origin, url: location.href };
}
