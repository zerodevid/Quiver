'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const EN = require('./locales/telegram.en.json');
const ID = require('./locales/telegram.id.json');
const { formatNote } = require('./message-copy.mjs');
const localeContext = new AsyncLocalStorage();
const locale = () => localeContext.getStore() || 'id';
// English plural forms. Indonesian does not pluralize nouns, so one source key is
// enough; its English translation may write two forms separated by "|"
// ("{0} position|{0} positions"), prefixed with "#n|" when the counter is not {0}.
// Without this a card prints "1 positions", which is small but reads at once as
// machine-made.
//
// The singular form is used only when the PRINTED value is exactly "1": the counter
// is often already formatted ("1.500"/"1,500"), and guessing a number from
// locale-formatted text is a source of misreads.
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
