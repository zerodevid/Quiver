# Conventions

## Language: English in code
- All **code comments**, **identifiers** (variables, functions, classes, constants), **test names / test descriptions / test file names**, **commit messages** and docs for developers are written in **English**.
- This applies to every new change and to every line you touch. When you edit a function that still has Indonesian comments or names, translate them as part of the change.
- **User-facing text stays localized** (Indonesian UI strings in `web/src/i18n.jsx`, `src/locales/*.json`, Telegram messages). Do not translate those here.
- **Never rename persisted or external names** just for language: DB tables/columns, `config.json` keys, API JSON fields, `localStorage` keys, pm2 names. They are live data contracts; change them only with a migration.
