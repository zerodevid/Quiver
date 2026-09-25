'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const EN = require('./locales/telegram.en.json');
const ID = require('./locales/telegram.id.json');
const { formatNote } = require('./message-copy.mjs');
const localeContext = new AsyncLocalStorage();
const locale = () => localeContext.getStore() || 'id';
// Bentuk jamak bahasa Inggris. Bahasa Indonesia tidak menjamakkan kata benda, jadi
// satu kunci sumber cukup; terjemahan Inggrisnya boleh menulis dua bentuk yang
// dipisah "|" — "{0} position|{0} positions" — dan diawali "#n|" kalau pencacahnya
// bukan {0}. Tanpa ini kartu menulis "1 positions", yang kecil tapi langsung terbaca
// sebagai buatan mesin.
//
// Bentuk tunggal dipakai hanya kalau nilai yang DICETAK persis "1": pencacahnya
// sering sudah diformat ("1.500"/"1,500"), dan menebak angka dari teks berformat
// lokal justru sumber salah baca.
function plural(text, values) {
  if (!text.includes('|')) return text;
  let slot = 0, body = text;
  const head = /^#(\d+)\|/.exec(body);
  if (head) { slot = Number(head[1]); body = body.slice(head[0].length); }
  const forms = body.split('|');
  if (forms.length !== 2) return body;
  return String(values[slot] ?? '').trim() === '1' ? forms[0] : forms[1];
}
function tr(key, values = []) {
  const language = locale();
  const text = (language === 'en' ? EN[key] : ID[key]) ?? key;
  return plural(text, values).replace(/\{(\d+)\}/g, (match, i) => values[i] == null ? match : String(values[i]));
}
function localizeSchema(value) {
  if (typeof value === 'string') return tr(value);
  if (Array.isArray(value)) return value.map(localizeSchema);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, localizeSchema(v)]));
  return value;
}
const note = (text) => formatNote(text, locale());
module.exports = { localeContext, locale, tr, localizeSchema, note };
