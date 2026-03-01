# [Enlarge Arabic]

A Chrome extension that selectively enlarges Arabic script on web pages without affecting surrounding text in other scripts.

**Repository:** [github.com/ageyev/enlarge-arabic](https://github.com/ageyev/enlarge-arabic)

## The problem

Arabic glyphs at the same CSS `font-size` as Latin glyphs appear roughly 25–35 % smaller perceptually. Arabic typefaces allocate most of their vertical space to diacritics, ligatures, and deep descenders (letters like ع, ی, ر), leaving less room for the letter bodies themselves. On multilingual pages — Wikipedia, Facebook, news sites, academic papers — Arabic text becomes noticeably harder to read next to Latin, Hebrew, or CJK content.

Most existing extensions solve this at the *element* level: they find DOM elements containing Arabic text and apply `font-size` to the entire element. This breaks mixed-language content — a `<p>` containing `"Hello مرحبا world"` gets its English text enlarged too.


## What this extension does differently

**[Enlarge Arabic]** works at the *text-node* level. It uses a TreeWalker to locate individual text nodes, splits each node at script boundaries, and wraps only the Arabic character runs in `<span>` elements. English, Chinese, Hebrew, or any other script sharing the same paragraph is untouched.

```
Before:  TextNode("Hello مرحبا world")

After:   TextNode("Hello ") + <span class="arabic-enlarged">مرحبا</span> + TextNode(" world")
```

Arabic is a cursive script where characters must join. Wrapping individual *characters* in separate spans would break the joining, because each span constitutes a separate rendering context. The extension always wraps entire *contiguous Arabic runs* in a single span, preserving cursive joining.


## Usage

Click the extension icon (ﻉ) in the toolbar to toggle Arabic enlargement on the current domain. The icon turns teal when active and gray when inactive. The state is remembered per domain — once you enable it on `ar.wikipedia.org`, every visit to that domain will auto-enlarge Arabic text until you click the icon again to disable it.

### Configuring enlargement

The extension provides two levels of settings:

**General settings** (options page) control the global defaults — the font size and line height applied on any domain unless overridden. Open via right-click on the extension icon → "Options", or through Chrome's extension management page.

**Per-domain settings** (sidepanel) let you fine-tune enlargement for specific websites. Open the Chrome sidebar and select "[Enlarge Arabic]" from the sidepanel list. The sidepanel tracks which tab is active and displays settings for the current domain. Drag the sliders to see a live preview on the page; click "Save for this site" to persist the overrides, or "Reset to global defaults" to remove them.

The settings merge chain applies in this order (first defined value wins):

1. Domain-specific override (from sidepanel)
2. Global settings (from options page)
3. Built-in defaults (1.40 em font size, 1.60 line height)

Per-domain settings survive toggle cycles — disabling and re-enabling the extension on a domain restores the domain's saved settings.

### Dark theme

The options page and sidepanel automatically adapt to the browser's color scheme. No manual configuration is needed — the extension follows the OS-level light/dark preference.


## Architecture

The extension implements a layered approach that separates visual styling from DOM manipulation and settings management.

### Layer 1: CSS custom properties

A static stylesheet (`content.css`, declared in the manifest) defines a single rule:

```css
.arabic-enlarged {
    font-size: var(--arabic-enlarger-size, 1.4em);
    line-height: var(--arabic-enlarger-height, 1.6);
}
```

Chrome injects this stylesheet automatically into every page and removes it when the extension is disabled. The TypeScript code never sets inline styles — it only adds and removes CSS classes. The dynamic values (`font-size`, `line-height`) are controlled via CSS custom properties on `<html>`, so updating the visual appearance of every span on the page is O(1): a single `setProperty()` call on the document root, and the browser propagates the new value to all spans automatically.

If the extension is disabled or uninstalled, orphaned spans degrade to invisible wrappers — no visual distortion occurs.

### Layer 2: DOM text-node surgery

The processor module (`arabic-text-processor.ts`) is a pure DOM manipulation library with no Chrome API dependencies. It exports a clean API:

| Function | Purpose |
|----------|---------|
| `enlargeArabicText()` | Walks the DOM, wraps Arabic runs in `<span>` elements |
| `restoreOriginalText()` | Unwraps all spans, normalizes the DOM to its pre-enlargement state |
| `processSubtree(root)` | Processes a specific DOM subtree (used by the MutationObserver) |
| `processAddedNode(node)` | Processes a single added node — Element or Text (used by the observer) |
| `isCurrentlyEnlarged()` | Returns current state for synchronization with the background service worker |

The content script (`content.ts`) handles orchestration: message listening (including live preview and revert messages from the sidepanel), MutationObserver lifecycle, SPA navigation detection, settings loading via the shared storage module, `storage.onChanged` listener for live updates from the options page and sidepanel, and state management. The background service worker (`background.ts`) handles user interaction: icon clicks, per-domain state persistence (using a read-merge-write pattern to preserve domain-specific enlargement overrides across toggles), icon badge updates, and programmatic injection fallback for pre-existing tabs.

### Layer 3: Settings system

Settings are managed through a shared storage module (`src/shared/storage.ts`) that implements the three-level merge chain. The storage schema in `chrome.storage.local`:

```jsonc
{
    // Global settings (from options page)
    "__global_settings__": { "fontSize": "1.40", "lineHeight": "1.60" },

    // Domain with toggle state + custom overrides (from sidepanel)
    "ar.wikipedia.org": { "enabled": true, "fontSize": "1.60", "lineHeight": "1.80" },

    // Domain with toggle state only (no custom overrides — uses global defaults)
    "example.com": { "enabled": true }
}
```

The `loadEffectiveSettings(domain)` function reads both the global settings key and the domain key in a single storage call, then applies the merge chain. The content script calls this on activation and on revert, ensuring consistent behavior regardless of which settings surface the user interacts with.

The toggle handler in `background.ts` uses a read-merge-write pattern (`{ ...existing, enabled: newState }`) rather than overwriting the domain object. This preserves `fontSize` and `lineHeight` overrides across toggle cycles — a one-line architectural decision that prevents silent data loss.

### UI layer: React pages with shared components

The options page and sidepanel are both React applications that share:

- **`Slider.tsx`** — a labeled range slider with floating-point normalization (prevents `1.2000000000000002` from repeated 0.05 step additions)
- **`constants.ts`** — default values, slider ranges, storage keys, and the `GlobalSettings` type
- **`storage.ts`** — `loadEffectiveSettings()`, `loadGlobalSettings()`, and `removeDomainOverrides()`
- **`shared.css`** — complete visual design with CSS custom properties, dark theme via `@media (prefers-color-scheme: dark)`, and responsive layout via `@media (max-width: 420px)`

The sidepanel implements tab tracking using `chrome.tabs.onActivated` (tab switches) and `chrome.tabs.onUpdated` filtered by `changeInfo.url` (within-tab navigation, including SPA route changes). On tab or domain change, unsaved preview values are reverted and settings for the new domain are loaded. Live preview is debounced at 120 ms and sent to the content script via `chrome.tabs.sendMessage`.


## Key technical decisions

### Unicode detection: `\p{Script_Extensions=Arabic}`

The extension uses Unicode property escapes (ES2018) instead of explicit Unicode range lists:

```typescript
const ARABIC_TEST = /\p{Script_Extensions=Arabic}/u;     // existence check (non-global)
const ARABIC_RUNS = /\p{Script_Extensions=Arabic}+/gu;   // match all runs (global)
```

`Script_Extensions=Arabic` was chosen over `Script=Arabic` because the latter excludes the tatweel (kashida, U+0640, `Script=Common`), which would break cursive joining, and excludes diacritical marks (`Script=Inherited`), which would fragment fully vowelled text. `Script_Extensions` includes characters where Arabic is among the possible scripts, covering base letters, tatweel, diacritics, Arabic-Indic digits, and punctuation.

Two regex discipline points: `ARABIC_TEST` has no global flag (avoiding `lastIndex` statefulness) and no `+` quantifier (an existence check needs only one match). `ARABIC_RUNS` is global, and its `lastIndex` is explicitly reset to 0 before each use — guarding against a classic JavaScript pitfall with reused global regexes.

Browser compatibility is guaranteed: Unicode property escapes are mandatory per ES2018, and all browsers supporting Manifest V3 also support this syntax. The set of browsers supporting MV3 is a strict subset of browsers supporting `\p{Script_Extensions=Arabic}`.

### TreeWalker with `SHOW_ALL` for subtree pruning

The extension uses `NodeFilter.SHOW_ALL` (not `SHOW_TEXT`) so that the filter function sees element nodes *before* their children. This enables efficient subtree pruning:

- **`FILTER_REJECT`** on an element skips it AND all descendants. Used for `<script>`, `<style>`, `<textarea>`, `<code>`, `contenteditable` elements, and the extension's own wrapper spans (identified by `data-arabic-enlarger` attribute). One decision prunes potentially thousands of descendant nodes.
- **`FILTER_SKIP`** on a normal element descends into children without returning the element itself.
- **`FILTER_ACCEPT`** only on text nodes containing Arabic characters.

This is fundamentally more efficient than `SHOW_TEXT` with per-node ancestor checks (`closest()`, `parentElement.tagName`). A single `FILTER_REJECT` on a `<script>` element prunes its entire subtree in one decision, whereas a `SHOW_TEXT` walker would descend into the subtree and reject each text node individually.

The `contenteditable` exclusion is critical: modifying text nodes inside editable regions causes cursor positioning bugs (documented in [Wudooh Issue #15](https://github.com/nicholasbrower/Wudooh/issues/15)).

### Two-pass processing (collect then mutate)

`processSubtree()` uses a two-pass approach: first walk the tree and collect matching text nodes into an array, then wrap Arabic runs in each collected node. Mutating during traversal would invalidate the TreeWalker's internal position — the node it stands on is replaced by a `DocumentFragment` containing new text nodes and spans, causing the walker to skip siblings, revisit nodes, or throw in edge cases.

### Deep Sleep optimization

Before a full DOM traversal, the extension samples the first 10,000 characters of `document.body.textContent` — a single string operation much cheaper than walking the tree. If no Arabic characters are found, processing is skipped entirely, giving the extension near-zero cost on pages with no Arabic content. This concept is inspired by Pak Urdu Nastaleeq's "Deep Sleep Mode."

The 10,000-character threshold has an important edge case: on pages like Facebook where the first 10K characters are React metadata and UI chrome, the check can return `false` even when Arabic content is visible on screen. For this reason, user-initiated toggles bypass Deep Sleep (the user explicitly told us there is Arabic on the page), while only automated initialization paths use the heuristic.

### Dark theme via CSS custom properties

The options page and sidepanel use a single `@media (prefers-color-scheme: dark)` block in `shared.css` that overrides the CSS custom property values defined in `:root`. Because every color in the UI is referenced via `var()`, the entire theme switches with zero JavaScript — the browser handles detection, application, and live switching automatically.

The dark palette follows Google's Material Design dark theme conventions. A dedicated `--color-on-primary` variable handles text-on-accent contrast inversion: in light mode, white text on dark blue buttons; in dark mode, near-black text on light blue buttons. All color pairings are WCAG 2.1 AA compliant (minimum 4.5:1 contrast ratio for normal text). The `color-scheme: light dark` declaration on `:root` ensures native UI elements (scrollbars, form controls, text selection) also adapt.

### React Fragments and Chrome extension pages

React Fragments (`<>...</>`) must not be used at the root level of components rendered via `createRoot` in Chrome extension pages. Fragments place their children directly into the container node as siblings; when anything external modifies the container's child list (other extensions injecting content scripts, Google Translate wrapping text nodes, Chrome's own sidepanel lifecycle), React's `removeChild` calls during reconciliation fail with `NotFoundError`. A wrapper `<div>` creates an isolated boundary that shields React's DOM operations from external interference. This is a known, unresolved React issue ([#17256](https://github.com/facebook/react/issues/17256), open since 2019) that affects all React versions from 16 through 19. The sidepanel is particularly vulnerable because Chrome injects content scripts from other installed extensions into sidepanel pages.


## SPA and dynamic content support

Modern web pages load content dynamically. A `MutationObserver` watches for added DOM nodes and processes them. The architecture addresses several challenges specific to this domain.

### Infinite loop prevention (Wudooh Issue #23)

The critical problem with MutationObservers that modify the DOM is the feedback loop: the observer fires → we insert spans → our insertions are mutations → the observer fires again → infinite loop. This exact bug caused infinite reload loops in Wudooh on Google Search ([Issue #23](https://github.com/nicholasbrower/Wudooh/issues/23)).

The defense is three-layered:

1. **Disconnect before processing, reconnect after.** Mutations from span insertions are never observed.
2. **TreeWalker `FILTER_REJECT` on `data-arabic-enlarger` elements.** Even if the observer somehow fires on our own spans, the walker will not descend into them.
3. **Debounced batch processing.** Rather than processing each mutation record immediately, mutations are collected and processed after a brief delay. This means fifty tweets arriving via infinite scroll result in one processing pass instead of fifty separate disconnect/reconnect cycles. The window of disconnection is minimized to the synchronous processing loop — typically sub-millisecond.

### `characterData` observation

React and Vue often update text by mutating `textNode.nodeValue` in place rather than replacing DOM nodes. Standard `childList` observation misses these. The observer includes `characterData: true` to catch in-place text updates.

### SPA navigation detection

History API calls (`pushState`, `replaceState`) change the URL without a page reload. No native events exist for programmatic `pushState` calls (`popstate` fires only on Back/Forward). The content script wraps the History API methods to dispatch custom events, then debounces a full `processSubtree(document.body)` after a 100 ms delay to allow framework rendering to complete. The SPA monitoring is gated behind a boolean flag: when the extension is toggled off, navigation events incur zero processing cost.

### Self-initialization from storage

Content scripts declared in `manifest.json` and the background's `tabs.onUpdated` message can race: `document_idle` and `status === "complete"` both fire after the DOM is ready, but their relative ordering is not guaranteed. If the background sends a toggle message before the content script has registered its listener, the message is silently dropped.

The solution: on load, the content script proactively reads the current domain's toggle state from `chrome.storage.local` and activates if enabled — without waiting for a message from the background. This makes the background's initial message redundant (and harmless, since `enlargeArabicText()` is idempotent).

### Programmatic injection fallback

Content scripts declared in `manifest.json` are only injected into pages that load *after* the extension is installed. Tabs already open when the extension loads or is reloaded do not receive the content script. The background service worker handles this with a try/catch fallback:

```typescript
try {
    const response = await chrome.tabs.sendMessage(tab.id, message);
    if (!response?.ok) throw new Error("No valid response");
} catch (error) {
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    await chrome.tabs.sendMessage(tab.id, message);
}
```

The `response?.ok` check is important: during development, reloading the extension leaves orphaned content scripts in existing tabs. These orphaned scripts still receive messages (so `sendMessage` does not throw), but they can no longer access `chrome.runtime` or `chrome.storage`. Without the explicit response validation, the background would believe the message was handled when the orphaned script silently failed.

The CSS must be injected separately via `insertCSS` because `executeScript` only injects JavaScript.


## Project structure

```
src/
├── content/
│   ├── arabic-text-processor.ts   # Pure DOM library — no Chrome APIs
│   └── content.ts                 # Orchestration: messages, observer, SPA, settings
├── background/
│   └── background.ts              # Service worker: toggle, state, icon management
├── shared/
│   ├── constants.ts               # Defaults, slider ranges, storage keys, types
│   ├── Slider.tsx                 # Reusable labeled range slider component
│   └── storage.ts                 # Storage read/write: merge chain, domain overrides
├── options/
│   └── options.tsx                # Options page — global enlargement settings
├── sidepanel/
│   └── sidepanel.tsx              # Sidepanel — per-domain settings with live preview
├── messages/
│   └── messageType.ts             # Shared message type definitions
├── assets/                        # SVG icon sources (Inkscape and raw)
public/
├── manifest.json                  # MV3 manifest
├── content.css                    # Injected stylesheet with CSS custom property references
├── shared.css                     # Options/sidepanel styles (light + dark, responsive)
├── options.html                   # Options page mount point
├── sidepanel.html                 # Sidepanel mount point
├── images/                        # Rasterized icons (16/32/48/128 px)
webpack/
└── webpack.config.cjs             # Webpack build configuration
```

The separation between `arabic-text-processor.ts` (pure DOM) and `content.ts` (Chrome API orchestration) is deliberate: the processor is testable in any DOM environment without mocking Chrome APIs. Similarly, the `src/shared/` modules contain no UI — they are consumed by both the options page and the sidepanel, enforcing consistent behavior across settings surfaces.


## Manifest permissions

| Permission | Reason |
|------------|--------|
| `scripting` | Programmatic injection of content script and CSS into pre-existing tabs |
| `tabs` | Access to `tab.url` for per-domain state lookup, icon management, and sidepanel tab tracking |
| `activeTab` | Grants temporary host permission for `scripting.executeScript` / `insertCSS` on the active tab when the user clicks the icon |
| `storage` | Per-domain toggle state and enlargement settings persistence via `chrome.storage.local` |
| `sidePanel` | Registers the sidepanel for per-domain settings with live preview |


## Competitive landscape

Research into 15+ existing extensions revealed a consistent pattern of limitations:

| Extension | Approach | Key limitation |
|-----------|----------|----------------|
| Wudooh | Element-level CSS | Infinite reload loops ([#23](https://github.com/nicholasbrower/Wudooh/issues/23)), breaks mixed-language text |
| Huruf | Element-level CSS | No dynamic content support |
| FontARA | Font substitution | Overrides page fonts entirely |
| Pak Urdu Nastaleeq | Text-node wrapping | Nastaliq-specific; has the Deep Sleep concept we adopted |
| Fontiran | Font injection | Persian-specific |

No existing extension combines text-node-level precision with robust MutationObserver handling, per-domain configurable settings, and MV3 compliance.


## Building and development

```bash
npm install
npm run build
```

Load the `dist/` directory as an unpacked extension in `chrome://extensions` with Developer Mode enabled. The `webpack.config.cjs` must include `devtool: false` (or `'source-map'`) — webpack's default `eval` strategy in development mode violates Chrome extensions' Content Security Policy.

During development, after reloading the extension, you must also reload any open tabs where you want to test — otherwise orphaned content scripts from the previous load will intercept messages without functioning correctly. The programmatic injection fallback (described above) mitigates this for fresh clicks, but already-active enlargement on open tabs will stop working until the tab is reloaded.


## Browser compatibility

The extension targets Chrome (Manifest V3) as the primary platform. The core DOM manipulation code uses only standard Web APIs and ES2018 features, making it portable to Firefox and Safari with minimal manifest adaptation:

| Feature | Chrome | Firefox | Safari | Edge |
|---------|--------|---------|--------|------|
| `\p{Script_Extensions=Arabic}` | 64+ | 78+ | 11.1+ | 79+ |
| Manifest V3 | 88+ | 109+ | 15.4+ | 88+ |
| TreeWalker | All | All | All | All |
| CSS custom properties | 49+ | 31+ | 9.1+ | 15+ |
| MutationObserver | 26+ | 14+ | 7+ | 12+ |
| `prefers-color-scheme` | 76+ | 67+ | 12.1+ | 79+ |
| Side Panel API | 114+ | — | — | 114+ |


## License

[MIT](LICENSE.md) — Copyright (c) 2026 [Viktor Ageyev](https://github.com/ageyev) 
