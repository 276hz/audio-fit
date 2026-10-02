# Add a language
Copy `src/i18n/en.json` to `src/i18n/<code>.json`, translate every value (keep `{placeholders}`), add an `<option>` to `#lang` in `web/index.html`. `npm test` fails if a key is missing or a placeholder differs.
