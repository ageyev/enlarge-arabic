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

No popup, no settings page (yet) — a single click toggles the extension.

## Architecture

The extension implements a two-layer approach that separates visual styling from DOM manipulation.

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
| `applySettings(settings)` | Updates CSS custom properties — O(1) regardless of span count |
| `clearSettings()` | Removes CSS custom properties |
| `isCurrentlyEnlarged()` | Returns current state for synchronization with the background service worker |

The content script (`content.ts`) handles orchestration: message listening, MutationObserver lifecycle, SPA navigation detection, self-initialization from storage, and state management. The background service worker (`background.ts`) handles user interaction: icon clicks, per-domain state persistence, icon badge updates, and programmatic injection fallback for pre-existing tabs.


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


## SPA and dynamic content support

Modern web pages load content dynamically. A `MutationObserver` watches for added DOM nodes and processes them. The architecture addresses several challenges specific to this domain.

### Infinite loop prevention (Wudooh Issue #23)

The critical problem with MutationObservers that modify the DOM is the feedback loop: the observer fires → we insert spans → our insertions are mutations → the observer fires again → infinite loop. This exact bug caused infinite reload loops in Wudooh on Google Search ([Issue #23](https://github.com/nicholasbrower/Wudooh/issues/23)).

The defense is three-layered:

1. **Disconnect before processing, reconnect after.** Mutations from span insertions are never observed.
2. **TreeWalker `FILTER_REJECT` on `data-arabic-enlarger` elements.** Even if the observer somehow fires on our own spans, the walker will not descend into them.
3. **`processAddedNode()` checks the marker attribute before processing.** Explicit guard at the entry point.

### Debounced batch processing (Collect → Schedule → Flush)

Rather than processing mutations synchronously in the observer callback (which requires disconnecting and losing concurrent page mutations), the extension splits the work into two phases:

**Phase 1 — Collect** (synchronous, in the observer callback): references to added/changed nodes are pushed into a pending queue. No DOM modifications occur. The observer stays connected — no mutations are lost. A single `requestAnimationFrame` is scheduled if one isn't already pending.

**Phase 2 — Flush** (in the next animation frame): `observer.takeRecords()` drains any mutations queued between the last delivery and now. The pending queue is snapshotted and cleared. The observer is disconnected, all collected nodes are processed, and the observer is reconnected.

This means fifty tweets arriving via infinite scroll result in one processing pass instead of fifty separate disconnect/reconnect cycles. The window of disconnection is minimized to the synchronous processing loop — typically sub-millisecond.

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
│   └── content.ts                 # Orchestration: messages, observer, SPA detection
├── background/
│   └── background.ts              # Service worker: toggle logic, state persistence
├── messages/
│   └── messageType.ts             # Shared message type definition
├── constants.ts                   # Shared constants (icons, dev mode flag)
├── options/
│   └── options.tsx                # Options page (placeholder)
├── sidepanel/
│   └── sidepanel.tsx              # Side panel (placeholder)
├── assets/                        # SVG icon sources (Inkscape and raw)
public/
├── manifest.json                  # MV3 manifest
├── content.css                    # CSS with custom property references
├── options.html                   # Options page shell
├── sidepanel.html                 # Side panel shell
├── images/                        # Rasterized icons (16/32/48/128 px)
webpack/
└── webpack.config.cjs             # Webpack build configuration
```

The separation between `arabic-text-processor.ts` (pure DOM) and `content.ts` (Chrome API orchestration) is deliberate: the processor is testable in any DOM environment without mocking Chrome APIs.


## Manifest permissions

| Permission | Reason |
|------------|--------|
| `scripting` | Programmatic injection of content script and CSS into pre-existing tabs |
| `tabs` | Access to `tab.url` in the `tabs.onUpdated` listener for per-domain state lookup and icon management |
| `activeTab` | Grants temporary host permission for `scripting.executeScript` / `insertCSS` on the active tab when the user clicks the icon |
| `storage` | Per-domain toggle state persistence via `chrome.storage.local` |


## Competitive landscape

Research into 15+ existing extensions revealed a consistent pattern of limitations:

| Extension | Approach | Key limitation |
|-----------|----------|----------------|
| Wudooh | Element-level CSS | Infinite reload loops ([#23](https://github.com/nicholasbrower/Wudooh/issues/23)), breaks mixed-language text |
| Huruf | Element-level CSS | No dynamic content support |
| FontARA | Font substitution | Overrides page fonts entirely |
| Pak Urdu Nastaleeq | Text-node wrapping | Nastaliq-specific; has the Deep Sleep concept we adopted |
| Fontiran | Font injection | Persian-specific |

No existing extension combines text-node-level precision with robust MutationObserver handling and MV3 compliance.


## Building and development

```bash
npm install
npm run build
```

Load the `dist/` directory as an unpacked extension in `chrome://extensions` with Developer Mode enabled.

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


## License

[MIT](LICENSE.md) — Copyright (c) 2026 [Viktor Ageyev](https://github.com/ageyev)