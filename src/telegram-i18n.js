'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const EN = require('./locales/telegram.en.json');
const ID = require('./locales/telegram.id.json');
const { formatNote } = require('./message-copy.mjs');
const localeContext = new AsyncLocalStorage();
const locale = () => localeContext.getStore() || 'id';
function tr(key, values = []) {
  const language = locale();
  const text = (language === 'en' ? EN[key] : ID[key]) ?? key;
  return text.replace(/\{(\d+)\}/g, (match, i) => values[i] == null ? match : String(values[i]));
}
function localizeSchema(value) {
  if (typeof value === 'string') return tr(value);
  if (Array.isArray(value)) return value.map(localizeSchema);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, localizeSchema(v)]));
  return value;
}
const note = (text) => formatNote(text, locale());
module.exports = { localeContext, locale, tr, localizeSchema, note };
