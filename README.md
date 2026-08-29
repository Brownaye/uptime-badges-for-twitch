# Uptime Badges for Twitch

A Chrome extension that shows how long every live Twitch streamer has been
broadcasting, right on their video thumbnails. Color-coded, customizable,
and lightweight.

## Features

- Adds an uptime badge to live channel thumbnails across twitch.tv
- Badge color, position, size, and time thresholds are all configurable
- Signs in with your Twitch account (via Twitch's own login) to fetch
  stream start times — no separate account or password needed
- No servers, no tracking, no data collection beyond what's needed to
  show the badges (see [PRIVACY.md](./PRIVACY.md))

## Install (Chrome Web Store)

This extension is published on the Chrome Web Store. For most users,
installing from there is the right way to get it — updates are handled
automatically.

## Load unpacked (for development)

If you want to run this extension from source (to test changes before
they're published):

1. Open Chrome and go to `chrome://extensions`
2. Turn on **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select this project folder (the one containing `manifest.json`)
5. The extension will appear in your extensions list and toolbar

After making changes to the code, go back to `chrome://extensions` and
click the refresh icon on the extension's card to reload it.

## Project structure

- `manifest.json` — extension manifest (Manifest V3)
- `background.js` — service worker (auth, background logic)
- `content.js` — injected into twitch.tv pages to draw badges
- `popup.html` / `popup.js` — the toolbar popup UI (settings)
- `welcome.html` / `welcome.js` — first-run/onboarding page
- `icons/` — extension icons

## Permissions

- `identity` — used for signing in with Twitch
- `storage` — used to save your settings and access token locally
- Host permissions for `api.twitch.tv`, `id.twitch.tv`, and `www.twitch.tv`
  — used to authenticate and fetch live channel data

## Privacy

See [PRIVACY.md](./PRIVACY.md) for the full privacy policy. In short: no
servers, no data collection, everything stays in your browser.
