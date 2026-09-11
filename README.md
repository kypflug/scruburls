# <sub><img src="img/scruburls.svg" width="48" height="48"></sub> ScrubURLs

An **unofficial Manifest V3 port** of the [ClearURLs](https://github.com/ClearURLs/Addon) browser
extension (based on ClearURLs 1.27.3). ScrubURLs is not affiliated with or endorsed by the ClearURLs
project; the name and icon are different on purpose so nobody mistakes it for the original.

ScrubURLs removes tracking elements from URLs (`utm_*`, `fbclid`, `gclid`, Amazon's `ref=…` and
`pd_rd_*`, …), unwraps redirect trackers (Google, Facebook, Reddit, …) and blocks a handful of
advertising domains. It uses the community maintained rule set from
[gitlab.com/ClearURLs/rules](https://gitlab.com/ClearURLs/rules) and keeps it up to date automatically.

The original add-on relies on the blocking `webRequest` API, which Manifest V3 no longer offers to
regular extensions. This port keeps the original cleaning engine, settings, pages and translations,
but moves the network level cleaning to `declarativeNetRequest` (DNR) and uses the engine in the
service worker for everything DNR cannot express.

## Features

* Removes tracking parameters from URLs in the background (query string **and** fragment)
* Follows redirect trackers directly to the destination (top level navigations)
* Blocks some common ad domains (optional)
* Blocks hyperlink auditing (`<a ping>`)
* Filters `ETag` response headers (optional)
* Cleans URLs injected via the History API (`history.replaceState`)
* Prevents Google and Yandex from rewriting search result links
* Context menu entry to copy a cleaned link
* Built in tool to clean multiple URLs at once
* Statistics, per tab badge counter and a log of every cleaning action
* Settings import/export compatible with the original `ClearURLs.conf` files
* Rules are bundled for offline use and refreshed from `rules2.clearurls.xyz` (SHA-256 verified)

## Installation

The extension is not in the Chrome Web Store (yet), so load it unpacked.

### From a clone

```sh
git clone https://github.com/kypflug/scruburls.git
```

1. Open `chrome://extensions` (in Edge: `edge://extensions`).
2. Enable **Developer mode** (top right in Chrome, left sidebar in Edge).
3. Click **Load unpacked** and select the cloned `scruburls` folder (the one containing
   `manifest.json`).
4. Pin the ScrubURLs icon to the toolbar if you like; the popup shows the statistics and switches,
   the gear icon opens the settings page.

To update, `git pull` and click the reload button on the extension's card in `chrome://extensions`.

### From the packaged zip

1. Download `scruburls.zip` from the latest [CI run](../../actions) (artifact) or build it
   yourself with `npm run package`.
2. Unzip it and load the resulting folder with **Load unpacked** as described above.

### Requirements

Chrome/Chromium 121 or newer. Other Chromium based browsers with Manifest V3 support (Edge,
Brave, Vivaldi, Opera) should work too. Firefox is not supported by this port (Firefox still
supports blocking `webRequest`, so use the [original ClearURLs](https://addons.mozilla.org/firefox/addon/clearurls/) there).

### Verifying that it works

Open [https://test.clearurls.xyz/](https://test.clearurls.xyz/) or navigate to a URL such as
`https://example.com/?utm_source=test&utm_medium=email` and check that the address bar ends up
at `https://example.com/`. The popup lists how many network rules are active.

## How the Manifest V3 port works

```
                 ┌──────────────────────────────────────────────────────┐
  rules data ───►│ core/dnr_compiler.js                                 │
  + settings     │  providers ──► declarativeNetRequest dynamic rules   │──► Chrome applies them
                 └──────────────────────────────────────────────────────┘    to every request
                 ┌──────────────────────────────────────────────────────┐
  webRequest ───►│ background.js + core/engine.js (original algorithm)  │──► statistics, log, badge
  (observe only) │  top level navigations the DNR rules cannot handle   │──► tabs.update() fix
                 └──────────────────────────────────────────────────────┘
```

### What is compiled into DNR rules

| ClearURLs concept | DNR rule |
| --- | --- |
| parameter rules that are plain names (or regexes with a small finite language, e.g. `colii?d`) | `redirect` + `queryTransform.removeParams`, guarded by a regex that only matches when one of the parameters is present |
| unbounded parameter regexes (e.g. `utm_[a-z_]*`) | `redirect` + `regexSubstitution` (one parameter per redirect hop); well known names are additionally added as literal `removeParams` so the common case takes one hop |
| `rawRules` (e.g. Amazon `/ref=…`) | `redirect` + `regexSubstitution` |
| `completeProvider` (domain blocking) | `block` for sub resources, `redirect` to the blocked page for top level navigations |
| `exceptions` | `allow` rules |
| hyperlink auditing | `block` for the `ping` resource type |
| ETag filtering | `modifyHeaders` removing the `ETag` response header |
| `methods` | `requestMethods` condition |

Every regex is validated with `chrome.declarativeNetRequest.isRegexSupported()`; alternations that
exceed the RE2 memory limit are split automatically, unsupported providers fall back to the
service worker. The rules are rebuilt whenever the rule set or a relevant setting changes and stay
within Chrome's limits (1000 regex rules, 5000 "unsafe" dynamic rules).

Priorities: DNR `allow` rules suppress every block/redirect rule of lower or equal priority. The
global provider therefore gets the lowest priority, providers with exceptions get their own
priorities above it, providers without exceptions share the highest one. Every generated rule
carries a guard that guarantees it changes the URL, so a "no-op redirect" can never shadow another
provider's rule.

### What the service worker still does

* **Redirect trackers** (`redirections`): the target is percent-encoded inside the tracking URL and
  DNR cannot decode it. The service worker observes the request and navigates the tab to the
  decoded destination. This only works for top level navigations (sub resources are not redirected).
* **Fragments** (`#utm_source=…`) never reach the network; they are removed with
  `history.replaceState` after the navigation committed.
* **Safety net**: after every top level navigation the final URL is re-checked with the original
  engine. If something is left over (a provider whose regex RE2 cannot compile, a parameter written
  in a different case, collateral of an `allow` rule) the tab is navigated to the clean URL.
* **Statistics, log and badge** are computed by running the original engine on every observed
  request (non blocking), exactly like the original add-on did. Requests that are part of a DNR
  redirect chain are only counted once.
* History API cleaning, context menu, rule updates (via `chrome.alarms`) and the watchdog.

### Known differences to the MV2 add-on

* Sub resource requests that match a `redirections` rule are not redirected (the request goes to the
  tracker, which then redirects itself).
* For top level navigations that DNR cannot clean completely, the original request is sent before
  the tab is navigated to the clean URL.
* `removeParams` matches parameter names case sensitively (the engine is case insensitive); such
  leftovers are fixed by the safety net.
* An `allow` rule generated from a provider exception also suppresses lower priority providers
  (most notably the global rules) for that URL. The safety net fixes this for top level navigations.
* The badge counter is reset when the tab navigates (Chrome clears per tab badges on navigation).
* The `downloads` permission is no longer needed; exports use regular download links.
* The third party libraries (jQuery, Bootstrap, DataTables, Pickr, Font Awesome, ip-range-check)
  were replaced by small vanilla implementations.

Because the service worker observes every request for the statistics/log/badge features, it is
kept busy while you browse. Switching statistics, logging and the badge off in the popup reduces
that to top level navigations only; the DNR rules keep working regardless.

## Permissions

| Permission | Why |
| --- | --- |
| `declarativeNetRequest` + `<all_urls>` | apply the compiled cleaning rules to requests |
| `webRequest` (non blocking) | statistics, log, badge, redirect tracker fallback |
| `webNavigation` | History API cleaning, navigation safety net |
| `tabs`, `scripting` | navigate tabs to cleaned URLs, `history.replaceState`, copy to clipboard |
| `storage`, `unlimitedStorage` | settings, rules, log |
| `contextMenus` | "Copy clean link" entry |
| `alarms` | periodic rule updates and watchdog |

## Development

```sh
npm test                 # unit tests (engine, compiler, storage, manifest) – no browser needed
npm run update-rules     # refresh data/data.minify.json + rules.minify.hash from rules2.clearurls.xyz
npm run package          # build dist/scruburls.zip
```

Layout:

```
manifest.json          Manifest V3
background.js          service worker
core/engine.js         cleaning engine (port of clearurls.js / pureCleaning.js)
core/provider.js       rule provider
core/dnr_compiler.js   providers -> declarativeNetRequest rules
core/regex_expand.js   finite expansion of small regexes
core/storage.js        settings store (export format compatible with the original)
core/log.js            log + statistics helpers
core/tools.js          URL helpers
content/               Google / Yandex search result fixes (isolated + MAIN world scripts)
html/, js/, css/       popup, settings, log, cleaning tool, blocked page
data/                  bundled rules
_locales/              translations (from the original add-on)
scripts/               update-rules.sh (refresh bundled rules), package.sh (build the zip)
tests/                 node:test suites
tests/e2e/             Playwright end-to-end check (see below)
```

The `tests/helpers.js` module contains a small simulator of Chrome's rule evaluation which the
compiler tests use to check that the generated rules produce the same result as the engine.

### End-to-end check

`tests/e2e/extension.e2e.mjs` loads the unpacked extension into Chromium with
[Playwright](https://playwright.dev/), waits for the DNR rules to compile and verifies the
cleaning against a local HTTP server: tracking parameters, the Amazon example, the Google
redirect tracker, domain blocking, fragments, the History API and sub resources.

```sh
npm install --no-save playwright   # not a dependency of the extension itself
npx playwright install chromium    # or set CHROME_PATH to an existing Chromium binary
sudo node tests/e2e/extension.e2e.mjs
```

It binds port 80 so that the real provider patterns match (`www.amazon.com/...` rather than
`www.amazon.com:8080/...`); without root it falls back to a random port and the Google redirect
case cannot match. It is not part of `npm test`.


## License

LGPL-3.0-or-later, like the original. ClearURLs is Copyright (c) 2017-2025 Kevin Röbert. The
ClearURLs name and logo belong to the ClearURLs project and are not used by ScrubURLs. The rule
set is maintained by the ClearURLs project at [gitlab.com/ClearURLs/rules](https://gitlab.com/ClearURLs/rules).
