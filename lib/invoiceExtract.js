// Best-effort invoice reader: pulls raw text out of an uploaded PDF or image,
// then runs a handful of regex heuristics over it to guess the vendor name,
// service, amount, invoice date, due date, and bank details. This is NOT a
// real OCR/NLP pipeline - it's meant to save typing on clean, typical
// invoices and get most fields right most of the time. Every guess is
// returned alongside the raw text so the caller (the vendor form) can show
// it as a pre-fill that a human still reviews before saving, never as a
// silent auto-commit.

const pdfParse = require('pdf-parse');
const Tesseract = require('tesseract.js');
const { execFile } = require('child_process');

// pdf-parse's bundled PDF.js is strict about a PDF's cross-reference table,
// and throws (e.g. "bad XRef entry") on some structurally-valid-but-edge-case
// files - ReportLab-generated PDFs are a known example. Poppler's pdftotext
// is far more forgiving of exactly this kind of thing, so if it's installed
// on this machine, it's used as an automatic second attempt before giving up.
// This never touches disk - the PDF bytes go in over stdin and the extracted
// text comes back over stdout.
function extractTextViaPoppler(buffer) {
  return new Promise((resolve, reject) => {
    const child = execFile('pdftotext', ['-', '-'], { maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout);
    });
    child.stdin.on('error', () => {}); // e.g. EPIPE if the binary isn't found - the execFile callback above still reports the real error
    child.stdin.write(buffer);
    child.stdin.end();
  });
}

async function extractText(buffer, mimetype) {
  if (mimetype === 'application/pdf') {
    let primaryError = null;
    try {
      const data = await pdfParse(buffer);
      if (data.text && data.text.trim()) return data.text;
      primaryError = new Error('No text found in PDF');
    } catch (err) {
      primaryError = err;
    }
    try {
      const text = await extractTextViaPoppler(buffer);
      if (text && text.trim()) return text;
    } catch {
      // poppler isn't installed on this machine, or it also failed - fall
      // through and surface the original (more informative) pdf-parse error.
    }
    throw primaryError;
  }
  if (mimetype.startsWith('image/')) {
    // Tesseract needs its English trained-data file, which it fetches from
    // a CDN on first use and then caches locally - this step needs internet
    // access the first time it runs on a given machine.
    const { data } = await Tesseract.recognize(buffer, 'eng');
    return data.text || '';
  }
  throw new Error('Unsupported file type for text extraction');
}

// The gap between a label and its number tolerates up to a few non-digit
// characters (whitespace, a currency symbol, punctuation) - deliberately not
// restricted to a specific currency symbol, because some PDFs don't map
// their ₹/currency glyph to a real Unicode character at all: text extraction
// then yields a garbled placeholder character (commonly U+25A0 "■") instead
// of "₹". Requiring a literal ₹ would silently fail on exactly those files.
const AMOUNT_LABEL_RE = /\b(grand\s*total|amount\s*due|balance\s*due|total\s*due|total\s*payable|amount\s*payable|net\s*payable|payable\s*amount|net\s*amount|bill\s*amount|invoice\s*total|invoice\s*amount|total\s*amount|total)\b\s*[:\-]?\s*[^\d\n]{0,3}([\d.,]+)/i;
const ANY_CURRENCY_RE = /(?:rs\.?|inr|usd|eur|gbp|\$|₹|€|£|¥|■|□|▪|●|�)\s*([\d.,]+)/gi;

// Normalizes a matched number string regardless of which thousands/decimal
// convention it used - "1,47,500" (Indian), "125,000.50" (US), and
// "125.000,50" (European) should all come out as a correct plain number.
function parseAmountString(raw) {
  const s = raw.trim();
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
  let normalized = s;
  if (hasComma && hasDot) {
    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');
    normalized = lastComma > lastDot
      ? s.replace(/\./g, '').replace(',', '.') // European: comma is the decimal point
      : s.replace(/,/g, ''); // US: dot is the decimal point, commas just group thousands
  } else if (hasComma) {
    // Only commas, no decimal point at all - always thousands grouping,
    // Indian lakh/crore style ("1,47,500") or plain Western ("147,500").
    normalized = s.replace(/,/g, '');
  }
  const n = Number(normalized);
  return Number.isNaN(n) ? null : n;
}

function guessAmount(text) {
  const labelMatch = text.match(AMOUNT_LABEL_RE);
  if (labelMatch) {
    const n = parseAmountString(labelMatch[2]);
    if (n !== null && n > 0) return n;
  }
  // Fallback: take the largest currency-looking figure on the page - on most
  // invoices the grand total is the biggest number, bigger than any line item.
  let max = null;
  let m;
  while ((m = ANY_CURRENCY_RE.exec(text)) !== null) {
    const n = parseAmountString(m[1]);
    if (n !== null && (max === null || n > max)) max = n;
  }
  return max;
}

const DATE_PATTERNS = [
  // 2026-07-10 / 2026/07/10 / 2026.07.10
  { re: /\b(20\d{2})[-\/.](0?[1-9]|1[0-2])[-\/.](0?[1-9]|[12]\d|3[01])\b/, order: 'ymd' },
  // 10-07-2026 / 10/07/2026 / 10.07.2026
  { re: /\b(0?[1-9]|[12]\d|3[01])[-\/.](0?[1-9]|1[0-2])[-\/.](20\d{2})\b/, order: 'dmy' },
  // 10-07-26 / 10/07/26 (2-digit year - assumed 20XX)
  { re: /\b(0?[1-9]|[12]\d|3[01])[-\/.](0?[1-9]|1[0-2])[-\/.](\d{2})\b/, order: 'dmy2' },
  // 10 Jul 2026 / 10-Jul-2026 / 10th July 2026
  { re: /\b(0?[1-9]|[12]\d|3[01])(?:st|nd|rd|th)?[\s\-]+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\s\-]+(20\d{2})\b/i, order: 'dMonY' },
  // July 10, 2026 / Jul-10-2026 / July 10th 2026
  { re: /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\s\-]+(0?[1-9]|[12]\d|3[01])(?:st|nd|rd|th)?,?[\s\-]+(20\d{2})\b/i, order: 'Mondy' },
];

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

function toIsoDate(y, m, d) {
  const dt = new Date(Date.UTC(y, m, d));
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString().slice(0, 10);
}

function firstDateIn(searchText) {
  for (const { re, order } of DATE_PATTERNS) {
    const m = re.exec(searchText);
    if (!m) continue;
    if (order === 'ymd') return toIsoDate(+m[1], +m[2] - 1, +m[3]);
    if (order === 'dmy') return toIsoDate(+m[3], +m[2] - 1, +m[1]);
    if (order === 'dmy2') return toIsoDate(2000 + (+m[3]), +m[2] - 1, +m[1]);
    if (order === 'dMonY') return toIsoDate(+m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1]);
    if (order === 'Mondy') return toIsoDate(+m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]);
  }
  return null;
}

// Looks for a date near a specific label (e.g. "Invoice Date" vs "Due Date")
// first, narrowing the search so we don't accidentally grab an unrelated
// date elsewhere on the page; falls back to scanning the whole document.
function guessDateNear(text, labelRe, options = {}) {
  const labelMatch = labelRe.exec(text);
  if (labelMatch) {
    const near = firstDateIn(labelMatch[1]);
    if (near) return near;
  }
  return options.fallbackToWholeDoc ? firstDateIn(text) : null;
}

function guessInvoiceDate(text) {
  return guessDateNear(text, /invoice\s*date\s*[:\-]?\s*([^\n]{6,25})/i, { fallbackToWholeDoc: true });
}

function guessDueDate(text) {
  // "Due date" doesn't fall back to scanning the whole document - unlike the
  // invoice date, guessing wrong here would misrepresent when payment is
  // actually owed, so we'd rather leave it blank than guess badly.
  return guessDateNear(text, /(?:due\s*date|payment\s*due|deadline)\s*[:\-]?\s*([^\n]{6,25})/i);
}

function guessVendorName(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;

  // Look for an explicit "From:" / "Bill From:" / "Vendor:" label first -
  // either with the value on the same line ("From: Acme Inc") or, just as
  // commonly, with the label alone on its own line and the value directly
  // below it (a "From:" heading followed by the company name on the next
  // line, which is how most letterhead-style invoices lay it out).
  const labelRe = /^(from|bill\s*from|vendor|company|billed\s*by|supplier|seller|payee)\s*[:\-]\s*(.+)$/i;
  const labelOnlyRe = /^(from|bill\s*from|vendor|company|billed\s*by|supplier|seller|payee)\s*[:\-]?\s*$/i;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = labelRe.exec(line);
    if (m && m[2].trim().length > 1) return m[2].trim();
    if (labelOnlyRe.test(line) && lines[i + 1] && !/[:\-]\s*$/.test(lines[i + 1])) {
      return lines[i + 1];
    }
  }

  // Otherwise fall back to the first substantial line that isn't just a
  // document heading, a labeled field (date/number/reference/etc), or an
  // address-only fragment.
  const skip = /^(invoice|receipt|bill\s*to|bill|tax\s*invoice|original|copy|due\s*date|invoice\s*date|invoice\s*no|order\s*no|po\s*number|reference|date)\b/i;
  for (const line of lines.slice(0, 8)) {
    if (skip.test(line)) continue;
    if (/^\d+$/.test(line)) continue;
    if (line.length < 2 || line.length > 60) continue;
    return line;
  }
  return null;
}

function guessService(text) {
  // Look for an explicit label first - "Service:", "Description:", "For:".
  const labelRe = /^(service|description|for|item|particulars|work\s*performed|details)\s*[:\-]\s*(.+)$/im;
  const m = labelRe.exec(text);
  if (m && m[2].trim().length > 1 && m[2].trim().length < 120) return m[2].trim();
  return null;
}

const BANK_LINE_RE = /^(.*(?:bank\s*name|account\s*(?:no\.?|number)|a\/?c\s*(?:no\.?|number)|ifsc|swift|routing\s*number|iban|sort\s*code|bsb|upi\s*id|beneficiary).*)$/gim;

function guessBankDetails(text) {
  const lines = [];
  let m;
  while ((m = BANK_LINE_RE.exec(text)) !== null) {
    const line = m[1].trim();
    if (line && !lines.includes(line)) lines.push(line);
  }
  return lines.length ? lines.join('\n') : null;
}

async function extractInvoiceDetails(buffer, mimetype) {
  const text = await extractText(buffer, mimetype);
  return {
    text,
    guessed: {
      vendorName: guessVendorName(text),
      service: guessService(text),
      amount: guessAmount(text),
      invoiceDate: guessInvoiceDate(text),
      dueDate: guessDueDate(text),
      bankDetails: guessBankDetails(text),
    },
  };
}

module.exports = { extractInvoiceDetails };