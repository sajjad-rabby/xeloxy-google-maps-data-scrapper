// Email discovery helpers.
//
// The goal is to return the address a business would actually want contacted,
// not the first address that happens to appear in the markup. Addresses are
// therefore collected in confidence tiers and then ranked against the business
// name and the website domain.

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// Platform, theme and placeholder addresses that are never the business.
const VENDOR = /(sentry\.io|wixpress\.com|wix\.com|wixsite\.com|example\.com|example\.org|facebook\.com|fb\.com|localhost|typemade\.mx|squarespace\.com|shopify\.com|godaddy\.com|weebly\.com|wordpress\.com|blogger\.com|google\.com|googlemail\.com|domain\.com|yourdomain|email\.com|test\.com|mail\.com|cloudflare|cdn-cgi|schema\.org|gravatar|yelp\.com|tripadvisor|booking\.com|hotels\.com|indeed\.com|glassdoor\.com|amazon\.com|wikipedia\.org|github\.com|wordpress\.org)/i;

// Generic mailbox names - useful, but a personal address is better.
const ROLE_LOCAL = /^(info|contact|hello|hi|office|admin|administrator|support|sales|team|enquiries|enquiry|reception|mail|email|service|customercare|customer|help|ask|book|booking|appointments|front desk|frontdesk|welcome|general|connect|inquiries|clients?|patients?|customers?)$/i;

// Addresses that are never worth calling.
const JUNK_LOCAL = /^(noreply|no-reply|donotreply|do-not-reply|postmaster|webmaster|abuse|privacy|legal|compliance|security|hostmaster|spam|phish|phishing|abuse|dmca|anonymous|privacy-request|privacyrequest)/i;

export function isValidEmail(e) {
  if (!e || typeof e !== 'string') return false;
  const v = e.trim().toLowerCase();
  if (!v || v.length > 80) return false;
  if (!v.includes('@')) return false;
  if (/\.(png|jpg|jpeg|gif|webp|svg|css|js|ico|woff2?|pdf|zip)$/i.test(v)) return false;
  if (VENDOR.test(v)) return false;
  if (JUNK_LOCAL.test(v.split('@')[0])) return false;
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(v);
}

export function cleanEmail(e) {
  if (!e) return '';
  return String(e).trim().toLowerCase().replace(/^mailto:/i, '').split('?')[0].trim();
}

export function decodeCfEmail(hex) {
  if (!hex || hex.length < 4 || !/^[0-9a-f]+$/i.test(hex)) return '';
  try {
    const key = parseInt(hex.slice(0, 2), 16);
    let out = '';
    for (let i = 2; i + 1 < hex.length; i += 2) {
      out += String.fromCharCode(parseInt(hex.substr(i, 2), 16) ^ key);
    }
    return out;
  } catch (e) {
    return '';
  }
}

// HTML entities are built by concatenation so that no editor or transport
// step can decode them into literal characters.
const E_NBSP = '&' + 'nbsp;';
const E_AMP = '&' + 'amp;';
const E_QUOT = '&' + 'quot;';

/** Strips scripts/styles/tags so we only look at what a visitor can see. */
export function visibleText(html) {
  if (!html) return '';
  let s = String(html);
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  // Elements a visitor cannot see are not "visible" - drop them so a hidden
  // tracking address does not outrank the real one.
  s = s.replace(/<[^>]*\bdisplay\s*:\s*none[^>]*>[\s\S]*?<\/[a-z][^>]*>/gi, ' ');
  s = s.replace(/<[^>]*\bvisibility\s*:\s*hidden[^>]*>[\s\S]*?<\/[a-z][^>]*>/gi, ' ');
  s = s.replace(/<[^>]*\bhidden\b[^>]*>[\s\S]*?<\/[a-z][^>]*>/gi, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  // Decode the entities that matter for finding an address.
  s = s.replace(new RegExp(E_NBSP, 'gi'), ' ')
    .replace(new RegExp(E_AMP, 'gi'), '&')
    .replace(/&#0*64;/g, '@')
    .replace(/&#x0*40;/gi, '@')
    .replace(new RegExp(E_QUOT, 'gi'), '"')
    .replace(/&#0*39;/g, "'");
  return s.replace(/\s+/g, ' ');
}

/**
 * Pulls every address out of a raw HTML document, tagged with how it was
 * found. Higher tiers are more likely to be the business's own address.
 */
export function extractEmails(html) {
  const found = new Map(); // email -> best tier
  const add = (raw, tier) => {
    const e = cleanEmail(raw);
    if (!isValidEmail(e)) return;
    const prev = found.get(e);
    if (prev === undefined || tier < prev) found.set(e, tier);
  };

  if (!html) return [];

  // Tier 1 - mailto links.
  for (const m of String(html).matchAll(/mailto:([^"'\s?>]+)/gi)) add(m[1], 1);

  // Tier 2 - visible text.
  const text = visibleText(html);
  for (const m of text.match(EMAIL_RE) || []) add(m, 2);

  // Tier 3 - structured data, meta tags, form values.
  for (const m of String(html).matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const e of m[1].match(EMAIL_RE) || []) add(e, 3);
  }
  for (const m of String(html).matchAll(/<meta[^>]+content=["']([^"']*@[^"']*)["'][^>]*>/gi)) add(m[1], 3);
  for (const m of String(html).matchAll(/data-email=["']([^"']+@[^"']+)["']/gi)) add(m[1], 3);
  for (const m of String(html).matchAll(/data-cfemail=["']([0-9a-f]+)["']/gi)) add(decodeCfEmail(m[1]), 3);

  // Tier 4 - anywhere in the markup (often the theme vendor's address).
  for (const m of String(html).match(EMAIL_RE) || []) add(m, 4);

  return [...found.entries()].map(([email, tier]) => ({ email, tier }));
}

/** The registrable-ish domain of a URL, used to prefer matching addresses. */
export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch (e) {
    return '';
  }
}

/**
 * Scores an address against the business name and website so the best one
 * ends up first. Higher is better.
 */
export function scoreEmail(email, tier, businessName, website) {
  let score = 0;

  // Tier bonus: 1 = mailto, 2 = visible, 3 = structured, 4 = raw markup.
  score += [12, 9, 6, 3][tier - 1] || 0;

  const at = email.lastIndexOf('@');
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);

  const siteHost = hostOf(website || '');
  if (siteHost && (domain === siteHost || domain.endsWith('.' + siteHost))) score += 8;

  if (ROLE_LOCAL.test(local)) score += 3;

  // A personal address that carries the business name is usually the best
  // one, so it is worth more than a generic role mailbox.
  const nameTokens = String(businessName || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !/^(the|and|inc|llc|ltd|pllc|dmd|md|do|phd|np|pa|dc|rd|ms|bsn)/.test(t));
  if (nameTokens.length) {
    const localFlat = local.replace(/[^a-z0-9]/g, '');
    for (const t of nameTokens) {
      if (localFlat.includes(t)) { score += 14; break; }
    }
  }

  // A free-mail address is less likely to be the practice's own.
  if (/(gmail|yahoo|hotmail|outlook|aol|icloud|proton(mail)?|gmx|zoho|mail\.ru|yandex)\./i.test(domain)) score -= 3;

  // Very long or cryptic locals are usually tracking pixels or hashes.
  if (local.length > 30) score -= 4;
  if (/[0-9a-f]{16,}/i.test(local)) score -= 6;

  return score;
}

/** Maps a harvest source name onto a confidence tier. */
export function tierOf(source) {
  switch (source) {
    case 'page': return 1;      // mailto link
    case 'visible': return 2;   // text a visitor can see
    case 'structured': return 3;
    case 'markup': return 4;    // raw markup only
    default: return 4;
  }
}

/**
 * Picks the best address from a candidate list.
 * Returns { email, tier, score, alternates[] } or null.
 */
export function pickBestEmail(candidates, businessName, website) {
  const list = (candidates || [])
    .filter((c) => c && c.email && isValidEmail(c.email))
    .map((c) => {
      const tier = c.tier !== undefined && c.tier !== null ? c.tier : tierOf(c.source);
      const email = cleanEmail(c.email);
      return { email, tier, score: scoreEmail(email, tier, businessName, website) };
    });

  if (!list.length) return null;

  list.sort((a, b) => b.score - a.score || a.tier - b.tier || a.email.localeCompare(b.email));

  const best = list[0];
  const alternates = list
    .slice(1)
    .filter((c) => c.email !== best.email)
    .slice(0, 2)
    .map((c) => c.email);

  return { email: best.email, tier: best.tier, score: best.score, alternates };
}

/* ------------------------------------------------------- contact URL hunt */

const CONTACT_STRONG = /(contact|contact-us|contactus|get-in-touch|getintouch|reach-us|reachus|enquir|enquir|reach-out|reachout|talk-to-us|talktous|message-us|messageus)/i;
const CONTACT_WEAK = /(about|support|help|faq|office|location|clinic|team|our-team|impressum|imprint|kontakt|legal-notice)/i;
const CONTACT_PENALTY = /(blog|news|article|post|privacy|terms|cookie|consent|cart|checkout|shop|store|product|service[s]?\/|category|tag|author|press|media|newsletter|subscribe|career|jobs|login|signin|register|account|search|sitemap|rss|feed|wp-content|\.pdf|\.jpg|\.jpeg|\.png|\.gif|\.zip|\.doc|\.xls|\.mp4|\.webp|facebook|instagram|twitter|linkedin|youtube|tiktok|pinterest|mailto:|tel:|#)/i;

/**
 * Scores candidate links for how likely they are to hold a contact address.
 * Higher is better; negative means "do not visit".
 */
export function scoreContactUrl(href, base) {
  let url;
  try {
    url = new URL(href, base);
  } catch (e) {
    return -100;
  }
  if (!/^https?:$/.test(url.protocol)) return -100;

  const path = decodeURIComponent(url.pathname + url.search).toLowerCase();
  const host = url.hostname.replace(/^www\./i, '');

  let score = 0;
  if (CONTACT_STRONG.test(path)) score += 10;
  if (CONTACT_WEAK.test(path)) score += 5;
  if (CONTACT_PENALTY.test(path)) score -= 12;

  // Shorter paths are usually the main contact page.
  score -= Math.min(4, url.pathname.split('/').filter(Boolean).length);

  // A trailing slash or index file is noise.
  if (/\/(index|default)\.(html?|php)$/i.test(url.pathname)) score -= 3;

  return score;
}

/**
 * Finds the most promising contact pages on a site.
 * `sameHost` keeps the hunt on the business's own domain.
 */
export function findContactUrls(html, baseUrl, sameHost) {
  const out = [];
  const seen = new Set();
  const baseHost = hostOf(baseUrl);

  const hrefs = [];
  for (const m of String(html || '').matchAll(/href\s*=\s*["']([^"']+)["']/gi)) hrefs.push(m[1]);
  // Unquoted href values. A value that starts with a quote was already
  // captured above - keeping it here would resolve the quotes as part of the
  // path and turn an off-site link into a same-host one.
  for (const m of String(html || '').matchAll(/href\s*=\s*([^\s>]+)/gi)) {
    const v = m[1];
    if (!v || v[0] === '"' || v[0] === "'") continue;
    hrefs.push(v);
  }

  for (const href of hrefs) {
    let abs;
    try {
      abs = new URL(href, baseUrl).href;
    } catch (e) {
      continue;
    }
    if (sameHost) {
      const h = hostOf(abs);
      if (h !== baseHost && !h.endsWith('.' + baseHost)) continue;
    }
    const key = abs.split('#')[0].replace(/\/$/, '').toLowerCase();
    if (seen.has(key)) continue;
    const score = scoreContactUrl(abs, baseUrl);
    if (score <= 0) continue;
    seen.add(key);
    out.push({ url: abs, score });
  }

  out.sort((a, b) => b.score - a.score);
  return out;
}

/** Common contact paths to try when the site has no obvious contact link. */
export function commonContactPaths(baseUrl) {
  const paths = [
    '/contact', '/contact-us', '/contactus', '/contact/', '/get-in-touch',
    '/enquiries', '/enquiry', '/reach-us', '/about', '/about-us', '/about/contact',
    '/support', '/impressum', '/kontakt'
  ];
  return paths.map((p) => {
    try {
      return new URL(p, baseUrl).href;
    } catch (e) {
      return '';
    }
  }).filter(Boolean);
}
