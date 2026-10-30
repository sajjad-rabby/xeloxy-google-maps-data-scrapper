// Builds a workbook and writes it to disk so Python/openpyxl can read it back.
import { buildXlsx } from '../lib/xlsx.js';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const headers = ['name', 'phone', 'address', 'email', 'rating', 'reviews', 'category', 'website', 'hours', 'latitude', 'longitude', 'maps_url', 'email_confidence', 'email_source'];

const rows = [
  ['Kim Ross, DCN', '(512) 555-0142', '123 Main St, Austin, TX 78701', 'kim@rossnt.com', 4.8, 127, 'Dentist', 'https://www.rossnt.com', 'Mon-Fri 8am-5pm', 30.2672, -97.7431, 'https://maps.google.com/?cid=1', 'high', 'mailto'],
  ['Ampersand & Co <Clinic>', '(512) 555-0199', '456 Oak Ave, Austin, TX 78702', 'info@ampersand.com', 4.5, 42, 'Clinic & Spa', 'https://ampersand.com', 'Mon-Sat 9am-6pm', 30.2501, -97.7201, 'https://maps.google.com/?cid=2', 'medium', 'visible'],
  ['Quote "Test" Dental', '', '789 Pine Rd', '', 0, 0, '', '', '', '', '', '', '', ''],
  ['Ünïcode Dental', '(512) 555-0177', '10 Elm St', 'info@unicode.com', 4.9, 300, 'Dental', 'https://unicode.com', '24/7', 30.1, -97.7, 'https://maps.google.com/?cid=4', 'low', 'markup']
];

const widths = [30, 18, 34, 30, 8, 10, 20, 34, 34, 12, 12, 40, 16, 14];

const bytes = buildXlsx(headers, rows, { sheetName: 'Leads', widths });
const outPath = join(tmpdir(), 'xeloxy-maps-test-out.xlsx');
writeFileSync(outPath, Buffer.from(bytes));
console.log('wrote', outPath, bytes.length, 'bytes');
