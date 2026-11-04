# Arc Developer Toolbar

A Sine mod for [Zen Browser](https://zen-browser.app/) that recreates Arc’s per-tab Developer Mode.

When Developer Mode is enabled for a tab, an Arc-style toolbar appears above that tab’s web content with:

- Editable full URL
- Copy URL
- Capture (Zen/Firefox Screenshots)
- Portrait (visible-viewport composition copied to the clipboard)
- Console
- Network
- Inspect

## Install

1. Install [Sine](https://github.com/CosmicToast/Sine) for Zen.
2. Enable `sine.allow-unsafe-js` if installing from a local folder or non-store source.
3. Install this repository through Sine (local folder or GitHub URL).
4. Open a tab’s Site Data panel and turn on **Developer Mode**.

No browser restart is required for ordinary enable/disable. The mod registers an unload listener so Sine can remove it cleanly.

## How it works

- Developer Mode is stored per tab with Firefox SessionStore and survives restarts.
- Each enabled tab gets its own toolbar attached to that tab’s `.browserContainer`, so Zen split view can show independent bars.
- DevTools actions call Firefox’s `gDevTools.showToolboxForTab` with explicit tool IDs (`webconsole`, `netmonitor`, `inspector`).
- Capture opens the native Screenshots UI.
- Portrait snapshots only the owning browser’s visible viewport, composes it locally, and copies a PNG. It does **not** patch Firefox Screenshots internals.

## Compatibility notes

- Built against Zen’s Firefox 159-based chrome DOM (`#zen-site-data-settings-list`, `.browserContainer`, `.browserStack`).
- Privileged navigation schemes such as `chrome:`, `resource:`, and `javascript:` are blocked from the toolbar URL field.
- Portrait captures the visible viewport, not a scrolled full-page document.
- DOM fullscreen hides the toolbar while active.

## Files

- `theme.json` — Sine manifest
- `arc-developer-toolbar.uc.js` — window controller, Site Data toggle, toolbars, actions
- `chrome.css` — toolbar and Portrait panel styles
- `icons/` — local toolbar icons
