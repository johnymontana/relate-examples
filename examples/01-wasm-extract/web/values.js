// @ts-check
/**
 * values.js: a property value read from text, typed by the property's declared type (D27). Pure, for
 * the engine worker (pipeline.js stores each candidate's parse) and the Node harness (the gold's lint).
 * The model's text is never trusted as a value: it is parsed here, and a value that does not parse,
 * or breaks the property's `one_of` or `pattern`, is kept in the trace as invalid and never published.
 *
 *   parseValue('£28,449', {type: 'INTEGER'})          -> {ok: true, value: 28449}
 *   parseValue('9 January 2024', {type: 'DATE'})       -> {ok: true, value: '2024-01-09'}
 *   parseValue('4.5%', {type: 'FLOAT'})                -> {ok: true, value: 0.045}
 *   parseValue('Discretionary', {type: 'STRING', one_of: ['discretionary', 'advisory']}) -> {ok: true, value: 'discretionary'}
 *
 * What each type takes:
 *   INTEGER  digits with thousands separators (`,`, a thin or plain space, `'`), a sign, a currency symbol
 *            or code before or after (£ $ € ¥ GBP USD EUR ...), a whole number of minor units (28,449.00);
 *            thousand, million, billion (bn, mn) after a number multiply it, and so do k and m after an
 *            amount of money (£1.2m -> 1200000; 12 m is twelve of a unit); a unit after a number that is
 *            not money is dropped (150 kW -> 150, 77.0 kWh -> 77)
 *   FLOAT    the same with a decimal point
 *   form     a percentage (12.7%) is read only where the property declares one: 'percent' (relate-examples
 *            parse: PERCENT) needs it and stores the fraction (0.127); 'money' (parse: MONEY) is an amount
 *   DATE     ISO 2024-01-09; 9 January 2024, 9 Jan 2024, 9th January 2024; January 9, 2024 and Jan 9 2024; not
 *            01/09/2024 (day and month order cannot be told) and not a date without a year
 *   BOOLEAN  yes, no, true, false
 *   STRING   trimmed of surrounding punctuation; with one_of, one of its values compared case-insensitively
 *            (the value is the vocabulary's); with pattern, the whole text matches it
 */

/** The types a property may be extracted as. */
export const EXTRACTABLE_TYPES = Object.freeze(['STRING', 'INTEGER', 'FLOAT', 'DATE', 'BOOLEAN']);

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const CURRENCY = /^(?:[£$€¥₹₩₣]|(?:GBP|USD|EUR|JPY|CHF|CAD|AUD|INR|CNY|SEK|NOK|DKK)\s*)|(?:\s*(?:GBP|USD|EUR|JPY|CHF|CAD|AUD|INR|CNY|SEK|NOK|DKK)|[£$€¥])$/giu;

/** A number written in text, or null. @param {string} raw @param {boolean} integer @param {string|null} [form] */
function parseNumber(raw, integer, form = null) {
  let s = raw.trim().replace(/[−‒–]/gu, '-');
  const written = s;
  s = s.replace(CURRENCY, '').trim();
  const money = s !== written || form === 'money';
  let scale = 1;
  const pct = /%$/.test(s);
  if (pct) s = s.slice(0, -1).trim();
  const mult = /^(.*?\d)\s*(thousand|mn|million|bn|billion)$/iu.exec(s) ?? (money ? /^(.*?\d)\s*(k|m)$/iu.exec(s) : null);
  if (mult) {
    s = mult[1];
    scale = /^k|thousand/i.test(mult[2]) ? 1e3 : /^(?:m|mn|million)$/i.test(mult[2]) ? 1e6 : 1e9;
  } else if (!money && !pct) {
    // a unit after a quantity: letters, and the signs units are written with (kW, kWh, km/h, °C, m², bbl/d)
    const unit = /^(.*?\d)\s*([\p{L}°µ²³][\p{L}°µ²³]*(?:\/[\p{L}²³]+)?)$/u.exec(s);
    if (unit) s = unit[1];
  }
  s = s.replace(/^[-+]?/, (x) => x).replace(/(?<=\d)[,  ' ](?=\d{3}\b)/gu, '');
  if (!/^[-+]?\d+(?:\.\d+)?$/u.test(s)) return null;
  let n = Number(s) * scale;
  if (pct) n /= 100;
  if (!Number.isFinite(n)) return null;
  if (integer) {
    if (!Number.isInteger(n)) return null;
    if (!Number.isSafeInteger(n)) return null;
  } else n = Math.round(n * 1e9) / 1e9;
  return n;
}

/** A date written in text as YYYY-MM-DD, or null. @param {string} raw */
function parseDate(raw) {
  const s = raw.trim().replace(/[,.]/g, ' ').replace(/\s+/g, ' ').trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  let y; let m; let d;
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else {
    const month = (w) => {
      const i = MONTHS.findIndex((x) => x === w.toLowerCase() || (w.length >= 3 && x.startsWith(w.toLowerCase())));
      return i < 0 ? null : i + 1;
    };
    const dmy = /^(\d{1,2})(?:st|nd|rd|th)? (?:of )?([A-Za-z]+) (\d{4})$/.exec(s);
    const mdy = /^([A-Za-z]+) (\d{1,2})(?:st|nd|rd|th)? (\d{4})$/.exec(s);
    if (dmy && month(dmy[2])) [d, m, y] = [Number(dmy[1]), month(dmy[2]), Number(dmy[3])];
    else if (mdy && month(mdy[1])) [m, d, y] = [month(mdy[1]), Number(mdy[2]), Number(mdy[3])];
    else return null;
  }
  if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31) || !(y >= 1000 && y <= 9999)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * A property value read from text (see the header).
 * @param {string} text
 * @param {{type: string, one_of?: any[], pattern?: string, form?: 'money'|'percent'|null}} prop  the property as the document declares it
 * @returns {{ok: true, value: string|number|boolean} | {ok: false, why: string}}
 */
export function parseValue(text, prop) {
  const raw = String(text ?? '').trim().replace(/^[\s"'“”‘’(]+|[\s"'“”‘’).;:]+$/gu, '');
  if (raw === '') return { ok: false, why: 'empty' };
  let value;
  switch (prop.type) {
    case 'INTEGER':
    case 'FLOAT': {
      const pct = /%\s*$/u.test(raw);
      if (prop.form === 'money' && pct) return { ok: false, why: 'a percentage, not an amount' };
      if (prop.form === 'percent' && !pct) return { ok: false, why: 'not a percentage' };
      if (prop.form !== 'percent' && pct) return { ok: false, why: 'a percentage, and the property is not one (parse: PERCENT)' };
      const n = parseNumber(raw, prop.type === 'INTEGER', prop.form ?? null);
      if (n === null) return { ok: false, why: `not ${prop.type === 'INTEGER' ? 'a whole number' : 'a number'}` };
      value = n;
      break;
    }
    case 'DATE': {
      const d = parseDate(raw);
      if (d === null) return { ok: false, why: 'not a date with day, month and year' };
      value = d;
      break;
    }
    case 'BOOLEAN': {
      const b = { yes: true, true: true, no: false, false: false }[raw.toLowerCase()];
      if (b === undefined) return { ok: false, why: 'not yes or no' };
      value = b;
      break;
    }
    case 'STRING':
      value = raw;
      break;
    case 'STRING-AS-DATE': {
      // a STRING property that holds ISO dates (relate-examples parse: DATE): read as a date, written as its ISO text
      const d = parseDate(raw);
      if (d === null) return { ok: false, why: 'not a date with day, month and year' };
      value = d;
      break;
    }
    default:
      return { ok: false, why: `the page does not extract ${prop.type} values` };
  }
  if (Array.isArray(prop.one_of) && prop.one_of.length) {
    const hit = prop.one_of.find((x) => String(x).toLowerCase() === String(value).toLowerCase());
    if (hit === undefined) return { ok: false, why: `not one of ${prop.one_of.join(', ')}` };
    value = hit;
  }
  if (typeof prop.pattern === 'string' && typeof value === 'string') {
    let re;
    try {
      re = new RegExp(prop.pattern, 'u');
    } catch {
      return { ok: false, why: 'the property\'s pattern does not compile' };
    }
    const m = re.exec(value);
    if (!m || m.index !== 0 || m[0].length !== value.length) return { ok: false, why: `does not match ${prop.pattern}` };
  }
  return { ok: true, value };
}
