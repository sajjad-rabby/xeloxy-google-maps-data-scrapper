// A tiny, dependency-free XLSX writer.
//
// An .xlsx file is a ZIP archive of XML parts. We only ever need one sheet
// with plain text/number cells, so we write the archive with STORE (no
// compression) and inline strings. That keeps the whole thing under 150
// lines and avoids shipping a 900 KB spreadsheet library.

/* --------------------------------------------------------------- crc32 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ----------------------------------------------------------------- zip */

function utf8(str) {
  return new TextEncoder().encode(str);
}

/**
 * Builds a ZIP archive from [{ name, data }] entries, stored uncompressed.
 * Returns a Uint8Array.
 */
export function zipStore(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  // A fixed DOS timestamp keeps the output byte-for-byte reproducible.
  const dosTime = 0;
  const dosDate = 33; // 1980-01-01

  for (const file of files) {
    const nameBytes = utf8(file.name);
    const data = file.data instanceof Uint8Array ? file.data : utf8(String(file.data));
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);   // local file header signature
    lv.setUint16(4, 20, true);           // version needed
    lv.setUint16(6, 0x0800, true);       // flags: UTF-8 filename
    lv.setUint16(8, 0, true);            // method: store
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true); // compressed size
    lv.setUint32(22, data.length, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);           // extra length
    local.set(nameBytes, 30);

    chunks.push(local, data);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);   // central directory signature
    cv.setUint16(4, 20, true);           // version made by
    cv.setUint16(6, 20, true);           // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);           // extra
    cv.setUint16(32, 0, true);           // comment
    cv.setUint16(34, 0, true);           // disk number
    cv.setUint16(36, 0, true);           // internal attrs
    cv.setUint32(38, 0, true);           // external attrs
    cv.setUint32(42, offset, true);      // local header offset
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + data.length;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);     // end of central directory
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const total = offset + centralSize + eocd.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  for (const c of central) { out.set(c, p); p += c.length; }
  out.set(eocd, p);
  return out;
}

/* --------------------------------------------------------------- xlsx */

// Built by concatenation so the entity text can never be mangled by an
// editor or transport that decodes HTML entities.
const XML_AMP = '&' + 'amp;';
const XML_LT = '&' + 'lt;';
const XML_GT = '&' + 'gt;';
const XML_QUOT = '&' + 'quot;';
const XML_APOS = '&' + 'apos;';

function xmlEscape(v) {
  return String(v)
    .replace(/&/g, XML_AMP)
    .replace(/</g, XML_LT)
    .replace(/>/g, XML_GT)
    .replace(/"/g, XML_QUOT)
    .replace(/'/g, XML_APOS)
    // Strip control characters that are illegal in XML 1.0.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

function colName(index) {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function isNumeric(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Builds a single-sheet .xlsx workbook.
 *
 * @param {string[]} headers  Column titles.
 * @param {Array<Array<any>>} rows  Row values, aligned to headers.
 * @param {object} opts  { sheetName, widths }
 * @returns {Uint8Array}
 */
export function buildXlsx(headers, rows, opts) {
  const o = opts || {};
  const sheetName = (o.sheetName || 'Leads').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Leads';
  const widths = o.widths || [];

  const cell = (ref, value) => {
    if (value === null || value === undefined || value === '') {
      return `<c r="${ref}"/>`;
    }
    if (isNumeric(value)) {
      return `<c r="${ref}"><v>${value}</v></c>`;
    }
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
  };

  let sheetData = '<sheetData>';
  sheetData += `<row r="1">${headers.map((h, i) => cell(`${colName(i)}1`, h)).join('')}</row>`;
  rows.forEach((row, r) => {
    const rn = r + 2;
    sheetData += `<row r="${rn}">${row.map((v, i) => cell(`${colName(i)}${rn}`, v)).join('')}</row>`;
  });
  sheetData += '</sheetData>';

  let cols = '';
  if (widths.length) {
    cols = '<cols>' + widths.map((w, i) =>
      `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`
    ).join('') + '</cols>';
  }

  const sheetXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    cols + sheetData + '</worksheet>';

  const workbookXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets><sheet name="${xmlEscape(sheetName)}" sheetId="1" r:id="rId1"/></sheets>` +
    '</workbook>';

  const workbookRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '</Relationships>';

  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '</Types>';

  return zipStore([
    { name: '[Content_Types].xml', data: utf8(contentTypes) },
    { name: '_rels/.rels', data: utf8(rootRels) },
    { name: 'xl/workbook.xml', data: utf8(workbookXml) },
    { name: 'xl/_rels/workbook.xml.rels', data: utf8(workbookRels) },
    { name: 'xl/worksheets/sheet1.xml', data: utf8(sheetXml) }
  ]);
}
