# [Enlarge Arabic]

A Chrome extension that selectively enlarges Arabic script on web pages without affecting surrounding text in other scripts.

## The problem

Arabic glyphs at the same CSS `font-size` as Latin glyphs appear roughly 25–35% smaller perceptually. Arabic typefaces allocate vertical space to diacritics, ligatures, and deep descenders (letters like ع, ی, ر), leaving less room for the letter bodies themselves. On multilingual pages — Wikipedia, Facebook, news sites — Arabic text becomes hard to read next to Latin, Hebrew, or CJK content.

Most existing extensions (Wudooh, Huruf, FontARA) solve this at the *element* level: they find elements containing Arabic text and apply `font-size` to the entire element. This breaks mixed-language content — a `<p>` containing both `"Hello مرحبا world"` gets its English text enlarged too.

## What this extension does differently

**[enlarge arabic]** works at the *text-node* level. It uses a TreeWalker to find individual text nodes, splits each node at script boundaries, and wraps only the Arabic character runs in `<span>` elements. English, Chinese, Hebrew, or any other script sharing the same paragraph is untouched.

```
Before:  TextNode("Hello مرحبا world")

After:   TextNode("Hello ") + <span class="arabic-enlarged">مرحبا</span> + TextNode(" world")
```

Arabic is a cursive script where characters join. Wrapping individual *characters* in separate spans would break the joining (each span is a separate rendering context). The extension always wraps entire *contiguous Arabic runs* in a single span, preserving cursive joining.


## Architecture

The extension implements a two-layer approach that separates concerns between CSS and DOM manipulation.

### Layer 1: CSS custom properties

A static stylesheet (`arabic-enlarge.css`, declared in the manifest) defines a single rule:

```css
.arabic-enlarged {
    font-size: var(--arabic-enlarger-size, 1.35em);
    line-height: var(--arabic-enlarger-height, 1.6);
}
```

Chrome injects this stylesheet automatically and removes it when the extension is disabled. The TypeScript code never sets inline styles — it only adds and removes CSS classes. The dynamic values (`font-size`, `line-height`) are controlled via CSS custom properties on `<html>`, so updating the visual appearance of every span on the page is O(1): a single `setProperty()` call on the document root, and the browser propagates to all spans automatically.

If the extension is disabled or uninstalled, orphaned spans degrade to invisible wrappers — no visual distortion.

### Layer 2: DOM text-node surgery

The processor module (`arabic-text-processor.ts`) is a pure DOM manipulation library with no Chrome APIs and no awareness of the extension lifecycle. It exports a clean API:

- **`enlargeArabicText()`** — walks the DOM, wraps Arabic runs in `<span>` elements
- **`restoreOriginalText()`** — unwraps all spans, normalizes the DOM back to its pre-enlargement state
- **`processSubtree(root)`** — processes a specific DOM subtree (used by the MutationObserver)
- **`processAddedNode(node)`** — processes a single added node (Element or Text)
- **`applySettings(settings)`** — updates CSS custom properties (O(1), regardless of span count)
- **`clearSettings()`** — removes CSS custom properties
- **`isCurrentlyEnlarged()`** — returns current state for synchronization with the background service worker

The content script (`content.ts`) handles orchestration: message listening, MutationObserver lifecycle, SPA navigation detection, and state management.

## Key technical decisions

### Unicode detection: `\p{Script_Extensions=Arabic}`

The extension uses Unicode property escapes (ES2018) instead of explicit Unicode range lists:

```typescript
const ARABIC_TEST = /\p{Script_Extensions=Arabic}/u;     // existence check (non-global)
const ARABIC_RUNS = /\p{Script_Extensions=Arabic}+/gu;   // match all runs (global)
```

We chose `Script_Extensions=Arabic` over `Script=Arabic` because the latter excludes the tatweel (kashida, U+0640, `Script=Common`) which breaks cursive joining, and excludes diacritical marks (`Script=Inherited`) which would fragment fully vowelled text. `Script_Extensions` includes characters where Arabic is among the possible scripts, covering base letters, tatweel, diacritics, Arabic-Indic digits, and punctuation.

Two important regex discipline points: `ARABIC_TEST` has no global flag (avoiding `lastIndex` statefulness) and no `+` quantifier (an existence check needs only one match). `ARABIC_RUNS` is global, and its `lastIndex` is explicitly reset to 0 before each use — a classic JavaScript pitfall with reused global regexes.

Browser compatibility is guaranteed: Unicode property escapes are mandatory per the ES2018 specification, and all browsers that support Manifest V3 also support this syntax (Chrome 64+, Firefox 78+, Safari 11.1+, Edge 79+). The set of browsers supporting MV3 is a strict subset of browsers supporting `\p{Script_Extensions=Arabic}`.

### TreeWalker with `SHOW_ALL` for subtree pruning

The extension uses `NodeFilter.SHOW_ALL` (not `SHOW_TEXT`) so that the filter function sees element nodes before their children. This enables efficient subtree pruning:

- **`FILTER_REJECT`** on an element skips it AND all descendants. Used for `<script>`, `<style>`, `<textarea>`, `<code>`, `contenteditable` elements, and the extension's own wrapper spans. One decision prunes potentially thousands of descendant nodes.
- **`FILTER_SKIP`** on a normal element descends into children without returning the element itself.
- **`FILTER_ACCEPT`** only on text nodes containing Arabic characters.

This is fundamentally more efficient than `SHOW_TEXT` with per-node ancestor checks (`closest()`, `parentElement.tagName`). A single `FILTER_REJECT` on a `<script>` element prunes its entire subtree in one decision, whereas a `SHOW_TEXT` walker would descend into the subtree and reject each text node individually.

The `contenteditable` exclusion is critical: modifying text nodes inside editable regions causes cursor positioning bugs (documented in Wudooh Issue [#15](https://github.com/nicholasbrower/Wudooh/issues/15)).

### Two-pass processing (collect then mutate)

`processSubtree()` uses a two-pass approach: first walk the tree and collect matching text nodes, then wrap Arabic runs in each collected node. Mutating during traversal would invalidate the TreeWalker's internal position — the node it stands on is replaced by a `DocumentFragment` containing new text nodes and spans. The walker may skip siblings, revisit nodes, or throw in edge cases.

### Deep Sleep optimization

Before a full DOM traversal, the extension samples the first 10,000 characters of `document.body.textContent` — a single string operation much cheaper than walking the tree. If no Arabic characters are found, processing is skipped entirely, giving the extension near-zero cost on pages with no Arabic content. This is inspired by Pak Urdu Nastaleeq's "Deep Sleep Mode."

The 10,000 character threshold has an important edge case: on pages like Facebook where the first 10K characters are React metadata and UI chrome, the check can return `false` even when Arabic content is visible on screen. For this reason, user-initiated toggles bypass Deep Sleep (the user explicitly told us there is Arabic on the page), while automated initialization paths use it as intended.

### Toggle mechanism

The extension uses `chrome.action.onClicked` (no popup) — a single click toggles enlargement on or off for the current domain. State is persisted per-domain in `chrome.storage.local` with keys like `domain_ar.wikipedia.org` and `domain_aljazeera.net`. Hostnames are normalized (stripping `www.`).

### Programmatic injection fallback

Content scripts declared in `manifest.json` are only injected into pages that load after the extension is installed. Tabs already open when the extension loads do not receive the content script. The background script handles this with a fallback pattern:

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

The `response?.ok` check is important: during development, reloading the extension leaves orphaned content scripts in existing tabs. These orphaned scripts still receive messages (so `sendMessage` does not throw), but they can no longer access `chrome.runtime` or `chrome.storage`. Without the explicit response check, the background would believe the message was handled when in fact the orphaned script silently failed.

The CSS must be injected separately via `insertCSS` because `executeScript` only injects JavaScript — without the CSS, the spans are created but invisible.


## SPA and dynamic content support

Modern web pages load content dynamically. A `MutationObserver` watches for added DOM nodes and processes them. The architecture handles several challenges:

### Infinite loop prevention (Wudooh Issue #23)

The critical problem with MutationObservers that modify the DOM is the feedback loop: the observer fires → we insert spans → our insertions are mutations → the observer fires again → infinite loop. This exact bug caused infinite reload loops in Wudooh on Google Search ([Issue #23](https://github.com/nicholasbrower/Wudooh/issues/23)).

The defense is three-layered:

1. **Disconnect before processing, reconnect after.** Mutations from span insertions are never observed.
2. **TreeWalker `FILTER_REJECT` on `DATA_MARKER` elements.** Even if the observer somehow fires on our own spans, the walker won't descend into them.
3. **`processAddedNode()` checks `DATA_MARKER` before processing.** Explicit guard at the entry point.

### Debounced batch processing

Rapid mutations (infinite scroll, live feeds) are collected into a pending queue and processed once per animation frame via `requestAnimationFrame`. Fifty tweets arriving in rapid succession result in one processing pass instead of fifty separate disconnect/reconnect cycles.

### `characterData` observation

React and Vue often update text by mutating `textNode.nodeValue` in place rather than replacing DOM nodes. Standard `childList` observation misses these. The observer includes `characterData: true` to catch in-place text updates.

### SPA navigation detection

History API calls (`pushState`, `replaceState`) change the URL without a page reload. No native events exist for these. The content script wraps these History API methods to dispatch custom events, then debounces a full `processSubtree(document.body)` after a short delay to allow framework rendering to complete.

### Facebook-specific challenges

Facebook's DOM presents a worst-case scenario for the Deep Sleep optimization. The concatenated `body.textContent` starts with tens of thousands of characters of React data attributes, UI framework strings, and hidden metadata before any user-generated content appears. The first 10,000 characters can easily contain zero Arabic even when Arabic posts are clearly visible on screen.

Additionally, Facebook uses virtual scrolling — posts are removed from the DOM as you scroll past them and new ones are added. Without the MutationObserver, only the posts present at the moment of activation would be enlarged.


## Competitive landscape

Research into 15+ existing extensions revealed a consistent pattern of limitations:

| Extension | Approach | Key limitation |
|-----------|----------|----------------|
| Wudooh | Element-level CSS | Infinite reload loops ([#23](https://github.com/nicholasbrower/Wudooh/issues/23)), breaks mixed-language text |
| Huruf | Element-level CSS | No dynamic content support |
| FontARA | Font substitution | Overrides page fonts entirely |
| Pak Urdu Nastaleeq | Text-node wrapping | Nastaliq-specific, has Deep Sleep concept |
| Fontiran | Font injection | Persian-specific |

No existing extension combines text-node-level precision with robust MutationObserver handling and MV3 compliance.

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
public/
├── manifest.json                  # MV3 manifest
└── content.css                    # CSS with custom property references
```

The separation between `arabic-text-processor.ts` (pure DOM) and `content.ts` (Chrome API orchestration) is deliberate: the processor is testable in any DOM environment without mocking Chrome APIs.

## Building and development

```bash
npm install
npm run build
```

Load the `dist/` directory as an unpacked extension in `chrome://extensions` with Developer Mode enabled.

During development, after reloading the extension, you must also reload any tabs where you want to test — otherwise orphaned content scripts from the previous load will intercept messages without functioning correctly.

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

MIT