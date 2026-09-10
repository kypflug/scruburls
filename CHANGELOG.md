# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [2.0.0] - 2026-09-10

Manifest V3 port of ClearURLs 1.27.3.

### Changed
- Manifest V3: module service worker instead of a persistent background page.
- Network level cleaning is performed by `declarativeNetRequest` dynamic rules compiled from the
  ClearURLs rule set (`core/dnr_compiler.js`).
- Redirect trackers, fragments and everything DNR cannot express are handled by the original
  cleaning engine in the service worker for top level navigations.
- Google/Yandex search fixes use `"world": "MAIN"` content scripts instead of inline script injection.
- Rules are bundled (`data/`) and refreshed via `chrome.alarms`.
- The message API of the background script uses an explicit allow list of functions.
- Extension pages no longer bundle jQuery, Bootstrap, DataTables, Pickr or Font Awesome.
- The `downloads` and `webRequestBlocking` permissions were dropped; `scripting`, `alarms` and
  `declarativeNetRequest` were added.

### Fixed
- Statistics and badge counters no longer depend on logging being enabled.

### Compatibility note
- Requires Chrome >= 121.
