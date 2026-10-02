# Add a platform profile
Edit `src/presets/platforms.json`. Required: `id`, `name`, `allowedFormats`, `minSampleRate`, `minBitDepth`, `maxBytes`, `allowLossy`, `source` (URL of the platform's own documentation), `verified` (date or `not-verified-against-official-docs`), `note`. Do not add a platform you cannot source. Sizes are decimal bytes (50 MB = 50 000 000).
