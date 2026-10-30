// Unit tests for the email extraction and ranking logic.
import {
  extractEmails, pickBestEmail, findContactUrls, commonContactPaths,
  isValidEmail, scoreEmail, tierOf, visibleText, decodeCfEmail
} from '../lib/email.js';

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('PASS  ' + label); }
  else { fail++; console.log('FAIL  ' + label + '\n        expected: ' + JSON.stringify(expected) + '\n        actual:   ' + JSON.stringify(actual)); }
}

function ok(label, cond) {
  if (cond) { pass++; console.log('PASS  ' + label); }
  else { fail++; console.log('FAIL  ' + label); }
}

/* ------------------------------------------------------- validity */

check('rejects a vendor address', isValidEmail('hello@wixpress.com'), false);
check('rejects a placeholder address', isValidEmail('you@example.com'), false);
check('rejects a noreply address', isValidEmail('noreply@acme.com'), false);
check('rejects an image path', isValidEmail('logo@2x.png'), false);
check('accepts a normal address', isValidEmail('Kim@RossNT.com'), true);
check('accepts a plus-addressed mailbox', isValidEmail('kim+leads@rossnt.com'), true);

/* --------------------------------------------------- cf decoding */

check('decodes a cloudflare address', decodeCfEmail('7a121f1616153a09130e1f54191517'), 'hello@site.com');

/* -------------------------------------------------- visible text */

ok('visibleText drops script contents', !visibleText('<script>var a="x@y.com"</script><p>Hi</p>').includes('x@y.com'));
ok('visibleText keeps body addresses', visibleText('<p>Call us at hi@site.com</p>').includes('hi@site.com'));

/* --------------------------------------------------- extraction */

const html = `
<html><head>
  <meta name="email" content="meta@site.com">
  <script type="application/ld+json">{"@type":"Organization","email":"json@site.com"}</script>
</head><body>
  <a href="mailto:Info@Site.com">mail us</a>
  <p>Questions? reach us at visible@site.com</p>
  <span data-cfemail="7a121f1616153a09130e1f54191517"></span>
  <div style="display:none">hidden@site.com</div>
  <script>var tracking="tracking@site.com";</script>
</body></html>`;

const found = extractEmails(html);
const byEmail = Object.fromEntries(found.map((f) => [f.email, f.tier]));

ok('finds the mailto address', 'info@site.com' in byEmail);
ok('finds the visible address', 'visible@site.com' in byEmail);
ok('finds the meta address', 'meta@site.com' in byEmail);
ok('finds the json-ld address', 'json@site.com' in byEmail);
ok('finds the cloudflare address', 'hello@site.com' in byEmail);
ok('finds the hidden markup address', 'hidden@site.com' in byEmail);
ok('mailto outranks visible text', byEmail['info@site.com'] < byEmail['visible@site.com']);
ok('visible text outranks raw markup', byEmail['visible@site.com'] < byEmail['hidden@site.com']);
ok('json-ld is a middle tier', byEmail['json@site.com'] > byEmail['visible@site.com'] && byEmail['json@site.com'] < byEmail['hidden@site.com']);

/* ------------------------------------------------------- ranking */

const mixed = [
  { email: 'theme@themevendor.com', tier: 1 },
  { email: 'info@rossnt.com', tier: 2 },
  { email: 'kim@rossnt.com', tier: 4 }
];
const best = pickBestEmail(mixed, 'Kim Ross, DCN', 'https://www.rossnt.com');
check('picks the address on the business domain', best.email, 'kim@rossnt.com');
ok('keeps alternates', best.alternates.length >= 1);

const roleOnly = pickBestEmail([{ email: 'info@acme.com', tier: 2 }], 'Acme Clinic', 'https://acme.com');
check('a role mailbox beats nothing', roleOnly.email, 'info@acme.com');

const freeMail = pickBestEmail([
  { email: 'randomperson@gmail.com', tier: 1 },
  { email: 'info@acme.com', tier: 4 }
], 'Acme Clinic', 'https://acme.com');
check('a free-mail address loses to the business domain', freeMail.email, 'info@acme.com');

ok('tierOf maps page to 1', tierOf('page') === 1);
ok('tierOf maps markup to 4', tierOf('markup') === 4);

/* ------------------------------------------------- contact links */

const siteHtml = `
<a href="/contact-us">Contact</a>
<a href="/about">About</a>
<a href="/blog/2024/post">Blog post</a>
<a href="/privacy-policy">Privacy</a>
<a href="https://facebook.com/acme">Facebook</a>
<a href="/products/widget">Product</a>
<a href="mailto:hi@acme.com">Mail</a>
<a href="/team">Team</a>`;

const links = findContactUrls(siteHtml, 'https://acme.com/', true);
const urls = links.map((l) => l.url);
ok('finds the contact page', urls.some((u) => u.includes('/contact-us')));
ok('finds the about page', urls.some((u) => u.includes('/about')));
ok('skips the blog post', !urls.some((u) => u.includes('/blog')));
ok('skips the privacy page', !urls.some((u) => u.includes('/privacy')));
ok('skips social links', !urls.some((u) => u.includes('facebook')));
ok('skips product pages', !urls.some((u) => u.includes('/products')));
ok('skips mailto links', !urls.some((u) => u.startsWith('mailto')));
ok('ranks contact above about', urls[0].includes('/contact-us'));

const offSite = findContactUrls('<a href="https://other.com/contact">x</a>', 'https://acme.com/', true);
check('same-host filter drops other domains', offSite.length, 0);

const paths = commonContactPaths('https://acme.com/');
ok('common paths include /contact', paths.some((p) => p.endsWith('/contact')));
ok('common paths include /impressum', paths.some((p) => p.endsWith('/impressum')));

/* ------------------------------------------------------- summary */

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

