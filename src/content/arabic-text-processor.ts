/**
 * ============================================================================
 * Arabic Text Processor — Core Module of [enlarge arabic]
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Enlarges Arabic script on web pages by wrapping contiguous Arabic character
 * runs in <span> elements styled via CSS custom properties. Provides a clean
 * restore function that returns the DOM to its exact pre-enlargement state.
 *
 *
 * ARCHITECTURAL OVERVIEW
 * ----------------------
 * The module implements a two-layer approach:
 *
 *   Layer 1 (CSS): A static stylesheet (arabic-enlarge.css, declared in the
 *                   manifest) defines the rule:
 *                     .arabic-enlarged {
 *                       font-size: var(--arabic-enlarger-size, 1.35em);
 *                       line-height: var(--arabic-enlarger-height, 1.6);
 *                     }
 *                   This file is injected by Chrome automatically and removed
 *                   when the extension is disabled — no JS involvement.
 *
 *   Layer 2 (DOM): This module finds text nodes containing Arabic characters,
 *                   splits them at Arabic/non-Arabic boundaries, and wraps the
 *                   Arabic segments in <span class="arabic-enlarged"> elements.
 *                   Dynamic values (font-size, line-height) are controlled via
 *                   CSS custom properties on <html>, not via inline styles.
 *
 * This separation means:
 *   - The spans carry no inline styles and are visually inert without the CSS.
 *   - Updating font-size/line-height is O(1): one setProperty() call on <html>,
 *     the browser propagates to all spans automatically.
 *   - If the extension is disabled/uninstalled, orphaned spans cause no visual
 *     distortion — they degrade to invisible wrappers.
 *
 *
 * WHY TEXT-NODE-LEVEL SURGERY (NOT ELEMENT-LEVEL)
 * ------------------------------------------------
 * Most competing extensions (Wudooh, Huruf) work at the *element* level:
 * they find elements containing Arabic text and apply font-size to the
 * entire element. This breaks mixed-language content — a <p> containing
 * both "Hello مرحبا world" gets its English text enlarged too.
 *
 * This module works at the *text-node* level: it uses a TreeWalker to find
 * individual text nodes, then splits each node at Arabic/non-Arabic boundaries
 * and wraps ONLY the Arabic character runs. English, Chinese, Hebrew, or any
 * other script in the same element is untouched.
 *
 * Critical constraint: Arabic is a cursive script where characters join.
 * Wrapping individual *characters* in separate <span> elements would break
 * the joining (each span is a separate rendering context). Therefore, we
 * always wrap entire *contiguous Arabic runs* in a single span.
 *
 *
 * DYNAMIC CONTENT HANDLING
 * ------------------------
 * Modern web pages load content dynamically (infinite scroll, AJAX, SPAs).
 * The MutationObserver that handles dynamic content is managed by the
 * content script (content.ts), NOT by this module. This module provides
 * processSubtree() and processAddedNode() as the processing entry points
 * that the observer calls.
 *
 * This separation keeps the processor testable as a pure DOM library
 * without Chrome API dependencies, scheduling APIs (requestAnimationFrame),
 * or page lifecycle knowledge. The content script handles orchestration:
 * when to observe, when to re-process, coordination with SPA navigation,
 * message handling, and storage access.
 *
 * The observer uses a disconnect/reconnect pattern (implemented in
 * content.ts) to prevent the infinite feedback loop that plagued Wudooh
 * (GitHub Issue #23): our own DOM modifications (inserting spans) trigger
 * mutations, which would trigger processing, which would insert more
 * spans, ad infinitum. By disconnecting before modifications and
 * reconnecting after, the content script breaks this cycle.
 *
 * Additionally, our wrapper spans carry a data attribute (DATA_MARKER).
 * The TreeWalker's filter rejects these spans' subtrees via FILTER_REJECT,
 * providing a second line of defense against reprocessing.
 *
 *
 * DEEP SLEEP OPTIMIZATION
 * -----------------------
 * Inspired by Pak Urdu Nastaleeq's "Deep Sleep Mode." Before performing
 * a full DOM traversal, we sample the first N characters of body.textContent
 * (a single string operation, much cheaper than walking the tree). If no
 * Arabic characters are found, we skip processing entirely. This means
 * the extension has near-zero cost on pages with no Arabic content.
 *
 *
 * TREEWALKER FILTER DESIGN
 * ------------------------
 * We use NodeFilter.SHOW_ALL (not SHOW_TEXT) so that the filter function
 * sees *element* nodes before their children. This enables subtree pruning:
 *
 *   - FILTER_REJECT on an element = skip this element AND all descendants.
 *     Used for SKIP_TAGS (<script>, <style>, etc.), contenteditable elements,
 *     and our own wrapper spans. The walker never descends into these.
 *
 *   - FILTER_SKIP on an element = don't return this element to the caller,
 *     but DO descend into its children. Used for all normal elements.
 *
 *   - FILTER_ACCEPT on a text node = return this node to the caller.
 *     Used only for text nodes that contain Arabic characters.
 *
 * This is fundamentally more efficient than SHOW_TEXT + per-node ancestor
 * checks (closest(), parentElement.tagName). A single FILTER_REJECT on
 * a <script> element prunes its entire subtree in one decision, whereas
 * a SHOW_TEXT walker would descend into the subtree and then reject each
 * text node individually.
 *
 *
 * EXPORTED API
 * ------------
 *   enlargeArabicText()      — wraps Arabic runs (observer managed by content.ts)
 *   restoreOriginalText()    — unwraps spans, normalizes DOM (observer managed by content.ts)
 *   processSubtree(root)     — processes a subtree (used by content.ts for SPA re-scan)
 *   processAddedNode(node)   — processes a single added/changed node (used by content.ts observer)
 *   applySettings(settings)  — updates CSS custom properties (O(1))
 *   clearSettings()          — removes CSS custom properties
 *   isCurrentlyEnlarged()    — returns current state (for sync with background)
 *
 *
 * @module arabic-text-processor
 */

// ============================================================================
// CONSTANTS
// ============================================================================
import {devMode} from "../shared/constants";

/** Minimum target: ES2018 (guaranteed by MV3 browser requirements).
 *  Non-global — avoids lastIndex statefulness. */
const ARABIC_TEST = /\p{Script_Extensions=Arabic}/u;

/** Global — for exec() loop over all runs.
 *  MUST reset the lastIndex = 0 before each use. */
const ARABIC_RUNS = /\p{Script_Extensions=Arabic}+/gu;

/**
 * CSS class applied to wrapper spans.
 *
 * The visual effect of this class is defined in arabic-enlarge.css
 * (loaded by Chrome via the manifest). The TypeScript code never sets
 * inline styles — it only adds/removes this class.
 *
 * Consequence: if the CSS file is absent (extension disabled/uninstalled),
 * this class has no associated rules, and the spans are visually inert.
 */
const CSS_CLASS = "arabic-enlarged";

/**
 * Data attribute that marks our wrapper spans.
 *
 * Serves three purposes:
 *   1. TreeWalker subtree pruning: the filter rejects elements with this
 *      attribute, so we never descend into our own spans (prevents
 *      reprocessing without needing a WeakSet or class-based check).
 *   2. Restoration: querySelectorAll(`[${DATA_MARKER}]`) finds exactly
 *      and only our spans — no false positives possible.
 *   3. MutationObserver: when checking addedNodes, we skip nodes that
 *      carry this attribute (they are our own insertions).
 *
 * The attribute name is chosen to be unlikely to collide with any
 * website's own attributes. The "data-" prefix makes it a valid
 * HTML5 custom data attribute.
 */
const DATA_MARKER = "data-arabic-enlarger";

/**
 * HTML elements whose text content must never be modified.
 *
 * Rationale for each group:
 *
 *   Code/data elements (SCRIPT, STYLE, NOSCRIPT, TEMPLATE):
 *     Modifying text inside <script> or <style> would corrupt executable
 *     code or CSS rules. <template> content is inert and should stay so.
 *
 *   User input elements (TEXTAREA, INPUT, SELECT):
 *     Wrapping text nodes inside form controls would break form submission
 *     and user input. (INPUT doesn't contain text nodes in practice, but
 *     we include it defensively.)
 *
 *   Preformatted / code display (CODE, PRE, KBD, SAMP, VAR):
 *     These elements display text with deliberate formatting. Wrapping
 *     parts of code listings in spans would break copy-paste and
 *     potentially confuse syntax highlighters.
 *
 *   Non-text media (SVG, MATH, CANVAS, VIDEO, AUDIO):
 *     SVG and MathML have their own text rendering systems that should
 *     not be interfered with. CANVAS, VIDEO, AUDIO contain no visible
 *     text nodes (any text inside them is fallback content).
 *
 *   Isolation (IFRAME):
 *     Iframe content is in a separate document. If "all_frames": true is
 *     set in the manifest, Chrome injects the content script into each
 *     iframe independently — we should not reach into iframes from the
 *     parent frame's walker.
 */
const SKIP_TAGS: ReadonlySet<string> = new Set([
    // Code and data
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE",
    // User input
    "TEXTAREA", "INPUT", "SELECT",
    // Preformatted / code display
    "CODE", "PRE", "KBD", "SAMP", "VAR",
    // Non-text media
    "SVG", "MATH", "CANVAS", "VIDEO", "AUDIO",
    // Isolation
    "IFRAME",
]);

/**
 * Number of characters to sample from body.textContent for the Deep Sleep
 * check. 10,000 characters is enough to detect Arabic on any realistic page
 * (even pages where Arabic appears below the fold) while remaining cheap —
 * textContent is a single concatenation, and slice + regex test on 10K chars
 * is sub-millisecond.
 *
 * If a page has Arabic content only in lazily-loaded sections beyond this
 * sample, the MutationObserver will catch it when that content loads.
 * But the initial Deep Sleep check avoids the full DOM walk on pages
 * like github.com where there is certainly no Arabic.
 */
const DEEP_SLEEP_SAMPLE_SIZE = 10_000;

// ============================================================================
// CSS CUSTOM PROPERTIES — dynamic styling interface
// ============================================================================

/**
 * Settings that control the visual appearance of enlarged Arabic text.
 *
 * Values are CSS strings passed directly to setProperty(), so any valid
 * CSS value works: "1.35em", "150%", "24px", "calc(1em + 4px)", etc.
 *
 * These settings can vary per domain. The content script reads the
 * appropriate settings from chrome.storage.local and calls applySettings()
 * with the resolved values.
 */
export interface ArabicEnlargerSettings {
    fontSize: string;
    lineHeight: string;
}

/**
 * Sensible defaults based on empirical testing.
 *
 * Arabic glyphs at the same CSS font-size as Latin glyphs appear ~25-35%
 * smaller perceptually, because Arabic typefaces allocate vertical space
 * to diacritics, ligatures, and the deep descenders of letters like
 * ع ,ی ,ر — leaving less space for the letter bodies. A multiplier of
 * 1.35em compensates for this disparity on most typefaces.
 *
 * Line-height 1.6 provides enough room for diacritical marks (tashkeel)
 * above and below the baseline without clipping, even with the enlarged
 * font-size. Standard web line-height (1.2-1.4) clips Arabic diacritics
 * at the enlarged size.
 */
const DEFAULT_SETTINGS: Readonly<ArabicEnlargerSettings> = {
    fontSize: "1.35em",
    lineHeight: "1.6",
};

/**
 * Sets CSS custom properties on <html> to control the appearance of all
 * .arabic-enlarged spans on the page.
 *
 * This is O(1) regardless of how many spans exist — the browser's CSS
 * engine propagates the new values to all elements referencing the
 * variables. Compare with the alternative (iterating over every span
 * to update inline styles), which is O(n) and causes visible lag on
 * Arabic-heavy pages with thousands of spans.
 *
 * Partial settings are accepted: omitted fields retain their current
 * values (or fall back to defaults if never set).
 */

// ---- not implemented yet TODO: add support for changing CSS values
export function applySettings(settings: Partial<ArabicEnlargerSettings>): void {
    const resolved: ArabicEnlargerSettings = { ...DEFAULT_SETTINGS, ...settings };
    const root = document.documentElement;

    root.style.setProperty("--arabic-enlarger-size", resolved.fontSize);
    root.style.setProperty("--arabic-enlarger-height", resolved.lineHeight);
}

/**
 * Removes the CSS custom properties from <html>.
 *
 * After this call, the var() references in arabic-enlarge.css fall back
 * to their default values (the second argument of var()). If the CSS
 * file itself has been removed (extension disabled), the spans have
 * no styling at all.
 *
 * Called during restoreOriginalText() to leave no trace on the page.
 */
export function clearSettings(): void {
    const root = document.documentElement;

    root.style.removeProperty("--arabic-enlarger-size");
    root.style.removeProperty("--arabic-enlarger-height");
}

// ============================================================================
// MODULE STATE
// ============================================================================

/**
 * Whether the Arabic text is currently enlarged.
 *
 * Guards against double-enlargement (calling enlargeArabicText() twice
 * would wrap already-wrapped text in additional spans) and against
 * restoring when nothing was enlarged.
 */
let isEnlarged = false;

// ============================================================================
// TREEWALKER — finding Arabic text nodes
// ============================================================================

/**
 * Creates a TreeWalker that yields exactly those text nodes within `root`
 * that contain Arabic characters and are safe to modify.
 *
 * DESIGN: uses SHOW_ALL (not SHOW_TEXT) to enable subtree pruning.
 *
 * When the walker encounters an *element* node:
 *   - If the element is in SKIP_TAGS, is contenteditable, or is one of
 *     our own wrapper spans → FILTER_REJECT: the walker skips the element
 *     AND its entire subtree. One decision prunes potentially thousands
 *     of descendant nodes.
 *   - Otherwise → FILTER_SKIP: the walker does NOT return the element
 *     to the caller (we only want text nodes), but DOES descend into
 *     its children.
 *
 * When the walker encounters a *text* node:
 *   - If it contains Arabic characters → FILTER_ACCEPT: returned to caller.
 *   - Otherwise → FILTER_REJECT: not returned.
 *
 * The caller thus receives a stream of exclusively text nodes containing
 * Arabic characters, all safe to modify, with zero wasted ancestor checks.
 *
 * @param root - The DOM subtree to search. Typically document.body for
 *               initial processing, or a specific added node for
 *               MutationObserver callbacks.
 */
function createArabicTextWalker(root: Node): TreeWalker {
    return document.createTreeWalker(root, NodeFilter.SHOW_ALL, {
        acceptNode(node: Node): number {

            // ---- Element nodes: decide whether to descend into subtree ----
            if (node instanceof Element) {

                // Prune entire subtrees of forbidden elements.
                // FILTER_REJECT on an element means "skip this element AND
                // all of its descendants" — the walker will not descend.
                if (SKIP_TAGS.has(node.tagName)) {
                    return NodeFilter.FILTER_REJECT;
                }

                // Contenteditable elements: modifying their text nodes causes
                // cursor position bugs (documented in Wudooh Issue #15).
                // We check the attribute directly rather than using closest()
                // because FILTER_REJECT already prevents descent — any nested
                // contenteditable children are pruned by their ancestor.
                if (node.getAttribute("contenteditable") === "true") {
                    return NodeFilter.FILTER_REJECT;
                }

                // Our own wrapper spans: reject to prevent reprocessing.
                // The DATA_MARKER attribute is unique to our spans, so this
                // check has zero false positives.
                if (node.hasAttribute(DATA_MARKER)) {
                    return NodeFilter.FILTER_REJECT;
                }

                // Normal elements: descend into children but don't return
                // the element itself (we only want text nodes).
                return NodeFilter.FILTER_SKIP;
            }

            // ---- Text nodes: accept only those containing Arabic ----
            if (node instanceof Text) {
                // nodeValue is preferred over textContent for text nodes:
                // semantically more precise (textContent is defined for all
                // node types; nodeValue is specific to text/comment nodes).
                if (!node.nodeValue) {
                    return NodeFilter.FILTER_REJECT;
                }

                // Quick regex pre-screen. ARABIC_TEST is non-global, so
                // no lastIndex state to worry about.
                if (!ARABIC_TEST.test(node.nodeValue)) {
                    return NodeFilter.FILTER_REJECT;
                }

                return NodeFilter.FILTER_ACCEPT;
            }

            // ---- All other node types (comments, PIs, etc.) ----
            return NodeFilter.FILTER_REJECT;
        },
    });
}

// ============================================================================
// CORE: text-node surgery
// ============================================================================

/**
 * Splits a single text node at Arabic/non-Arabic boundaries and wraps
 * each Arabic run in a <span>.
 *
 * EXAMPLE
 * -------
 * Input text node: "Hello مرحبا world عالم end"
 *
 * After processing, the text node is replaced with:
 *   TextNode("Hello ")
 *   <span class="arabic-enlarged" data-arabic-enlarger>مرحبا</span>
 *   TextNode(" world ")
 *   <span class="arabic-enlarged" data-arabic-enlarger>عالم</span>
 *   TextNode(" end")
 *
 * The non-Arabic segments remain as plain text nodes. Only the Arabic
 * runs are wrapped — this is the "surgical" precision that distinguishes
 * this approach from element-level enlargement.
 *
 * CRITICAL INVARIANT
 * ------------------
 * Each contiguous Arabic run is wrapped in exactly ONE span. We never
 * split a span boundary within an Arabic sequence. If we did, the
 * rendering engine would treat each span as a separate text run,
 * breaking the cursive joining that Arabic script depends on.
 *
 * IMPLEMENTATION NOTES
 * --------------------
 * We use a DocumentFragment to batch all new nodes, then replace the
 * original text node with the fragment in a single DOM operation.
 * This minimizes reflows: the browser sees one replaceChild() instead
 * of multiple insertBefore() calls.
 *
 * The global regex ARABIC_RUNS.lastIndex is reset to 0 before each use.
 * Without this reset, the regex would resume from where the previous
 * text node's last match ended — a classic and subtle JavaScript bug
 * when reusing global regexes.
 *
 * @param textNode - A Text node known to contain Arabic characters.
 *                   (The caller guarantees this via the TreeWalker filter.)
 */
function wrapArabicRuns(textNode: Text): void {
    const text = textNode.nodeValue;
    if (!text) return;

    const parent = textNode.parentNode;
    if (!parent) return;

    const fragment = document.createDocumentFragment();

    // Track position in the original string as we consume it
    let cursor = 0;

    // Reset global regex state before use (see ARABIC_RUNS doc comment)
    ARABIC_RUNS.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = ARABIC_RUNS.exec(text)) !== null) {
        // Non-Arabic text between cursor and the start of this Arabic run.
        // This may be empty (cursor === match.index) if the string starts
        // with Arabic or two Arabic runs are adjacent — which is fine,
        // we simply skip creating an empty text node.
        if (match.index > cursor) {
            fragment.appendChild(
                document.createTextNode(text.slice(cursor, match.index))
            );
        }

        // The Arabic run itself — wrap in a marked, classed span.
        // The span carries:
        //   - CSS_CLASS: targets the var()-based styling rule in the CSS file
        //   - DATA_MARKER: identifies the span for TreeWalker pruning,
        //     restoration, and observer skip logic
        const span = document.createElement("span");
        span.className = CSS_CLASS;
        span.setAttribute(DATA_MARKER, "");
        span.textContent = match[0];
        fragment.appendChild(span);

        // Advance cursor past this match
        cursor = ARABIC_RUNS.lastIndex;
    }

    // Trailing non-Arabic text after the last match.
    // Again, may be empty if the string ends with Arabic.
    if (cursor < text.length) {
        fragment.appendChild(
            document.createTextNode(text.slice(cursor))
        );
    }

    // Single DOM operation: replace the original text node with all
    // the new nodes at once. The fragment itself is not inserted —
    // only its children are moved into the DOM.
    parent.replaceChild(fragment, textNode);
}

/**
 * Finds all Arabic-containing text nodes in a subtree and wraps their
 * Arabic runs in spans.
 *
 * TWO-PASS DESIGN
 * ----------------
 * Pass 1 (collect): walk the tree and collect matching text nodes.
 * Pass 2 (mutate): wrap Arabic runs in each collected node.
 *
 * Why not mutate during traversal? Because wrapArabicRuns() replaces
 * the text node with new nodes (text nodes + spans). This invalidates
 * the TreeWalker's internal position — the node it was standing on
 * no longer exists in the DOM. The walker may skip siblings, revisit
 * nodes, or throw in edge cases. Collecting first, mutating second,
 * avoids this entirely.
 *
 * @param root - The subtree to process. Typically document.body for
 *               initial processing, or a specific Element for
 *               MutationObserver callbacks.
 */
export function processSubtree(root: Node): void {

    const walker = createArabicTextWalker(root);

    // Pass 1: collect all Arabic text nodes
    const arabicTextNodes: Text[] = [];
    while (walker.nextNode()) {
        arabicTextNodes.push(walker.currentNode as Text);
    }

    if (devMode){
        console.log("[enlarge arabic] text nodes found:", arabicTextNodes.length);
    }

    // Pass 2: wrap Arabic runs in each collected node
    for (const textNode of arabicTextNodes) {
        wrapArabicRuns(textNode);
    }
}

// ============================================================================
// OBSERVER ENTRY POINT — processing a single added/changed node
// ============================================================================

/**
 * Processes a single node observed by the MutationObserver in content.ts.
 *
 * Handles both Element and Text nodes with appropriate skip checks.
 * This function encapsulates all the DOM-level knowledge that the observer
 * callback needs, keeping Chrome-extension-level orchestration in content.ts
 * and DOM-level logic here in the processor.
 *
 * WHY NOT JUST EXPORT wrapArabicRuns AND LET content.ts CALL IT DIRECTLY?
 * Because content.ts would then need to import and check SKIP_TAGS,
 * DATA_MARKER, ARABIC_TEST, and the contenteditable logic — duplicating
 * domain knowledge that belongs in the processor. processAddedNode is the
 * clean boundary: the observer hands us a node, we decide what to do.
 *
 * FOR ELEMENT NODES:
 * Delegates to processSubtree() for a full subtree walk. The TreeWalker
 * inside processSubtree handles all skip logic (SKIP_TAGS, contenteditable,
 * DATA_MARKER). We only check DATA_MARKER here as an early bailout — if
 * the added element IS one of our own spans, there is no point creating
 * a walker just to have it immediately return FILTER_REJECT.
 *
 * FOR TEXT NODES:
 * Performs the essential safety checks inline rather than creating a
 * TreeWalker. A TreeWalker for a single text node would:
 *   1. Create the walker object (allocation)
 *   2. Call the filter function on the text node (one decision)
 *   3. Return the node or not
 *   4. Be garbage collected
 * This is wasteful when we can make the same decision with four
 * if-statements. The checks replicate the TreeWalker filter's logic
 * for the parent-element level (SKIP_TAGS, contenteditable, DATA_MARKER)
 * and the text-node level (ARABIC_TEST).
 *
 * FOR characterData MUTATIONS:
 * When a framework like React changes textNode.nodeValue in place, the
 * observer in content.ts collects that text node and passes it here.
 * It hits the Text branch. If the NEW text contains Arabic (and the
 * parent isn't forbidden), we wrap it. If the text node was ALREADY
 * wrapped in one of our spans (parent has DATA_MARKER), we skip it —
 * the Arabic text is already enlarged.
 *
 * EDGE CASE — characterData ON A WRAPPED TEXT NODE:
 * If a framework mutates the nodeValue of a text node INSIDE one of
 * our <span data-arabic-enlarger> elements, we skip it (parent has
 * DATA_MARKER). This is correct: the text is already inside a styled
 * span. If the framework changed it to non-Arabic text, the span
 * still applies our CSS class, but this is an extremely rare edge case
 * (a framework reaching inside our span to change its text), and the
 * visual impact is negligible (non-Arabic text with a slightly larger
 * font-size). A full solution would require detecting this case and
 * unwrapping the span, but the complexity isn't justified by the
 * vanishingly small probability.
 *
 * @param node - A Node added to or changed in the DOM. May be an
 *               Element (childList mutation), a Text node (childList
 *               or characterData mutation), or any other node type
 *               (ignored).
 */
export function processAddedNode(node: Node): void {
    if (node instanceof Element) {
        // Early bailout: skip our own wrapper spans
        if (node.hasAttribute(DATA_MARKER)) return;

        // Full subtree walk — the TreeWalker handles all skip logic
        processSubtree(node);

    } else if (node instanceof Text) {
        // For a single text node, replicate the TreeWalker's parent
        // checks inline rather than creating a walker
        const parent = node.parentElement;
        if (!parent) return;

        if (SKIP_TAGS.has(parent.tagName)) return;
        if (parent.getAttribute("contenteditable") === "true") return;
        if (parent.hasAttribute(DATA_MARKER)) return;

        // Only wrap if the text actually contains Arabic
        if (node.nodeValue && ARABIC_TEST.test(node.nodeValue)) {
            wrapArabicRuns(node);
        }
    }
}


// ============================================================================
// DEEP SLEEP — lightweight pre-scan
// ============================================================================

/**
 * Checks whether the page contains any Arabic characters at all, using
 * a cheap heuristic rather than a full DOM traversal.
 *
 * body.textContent concatenates all text content in the body into a single
 * string. We sample the first DEEP_SLEEP_SAMPLE_SIZE characters and test
 * for Arabic. On a page like github.com (zero Arabic), this returns false
 * in microseconds, avoiding a DOM walk that would find nothing.
 *
 * FALSE NEGATIVES
 * ---------------
 * If Arabic content exists only beyond the sample window (e.g., at the
 * bottom of a very long page), this check returns false and the initial
 * processSubtree() call is skipped. This is acceptable because:
 *   1. The MutationObserver (started by content.ts) will catch
 *      Arabic content when it enters the viewport / is lazily loaded.
 *   2. Pages where Arabic appears only after 10K characters of non-Arabic
 *      content are extremely rare in practice.
 *
 * FALSE POSITIVES
 * ---------------
 * None. If the regex matches, there IS Arabic text on the page.
 *
 * @returns true if the page likely contains Arabic text, false otherwise.
 */
function pageContainsArabic(): boolean {
    const sample = document.body?.textContent?.slice(0, DEEP_SLEEP_SAMPLE_SIZE) ?? "";
    return ARABIC_TEST.test(sample);
}


// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Enlarges all Arabic text on the page.
 *
 * OPERATION
 * ---------
 * 1. Idempotency guard: if already enlarged, returns immediately.
 * 2. Deep Sleep check: samples body text for Arabic characters.
 *    If none found, sets state flag and returns (near-zero cost).
 * 3. Processes the entire document body, wrapping Arabic text nodes.
 *
 * IDEMPOTENCY
 * -----------
 * Safe to call multiple times. The isEnlarged flag prevents double
 * processing. This matters because the background service worker may
 * re-send the "toggle" message on tab navigation (tabs.onUpdated),
 * and without the guard, Arabic text would be wrapped in nested spans.
 *
 * OBSERVER COORDINATION
 * ---------------------
 * This function does NOT start the MutationObserver. The content script
 * (content.ts) calls this function first, then starts the observer
 * separately in activateEnlargement(). This ordering is intentional:
 * if the observer were started before or during processing, our own
 * span insertions would trigger it — wasted work at best, a feedback
 * loop risk at worst.
 *
 * Even when the Deep Sleep check finds no Arabic, the content script
 * still starts the observer afterwards. The page may later load Arabic
 * content dynamically (AJAX, infinite scroll).
 */
export function enlargeArabicText(skipDeepSleep = false): void {
    if (isEnlarged) return;

    if (skipDeepSleep || pageContainsArabic()) {
        processSubtree(document.body);
    }

    isEnlarged = true;
}

/**
 * Restores the page to its exact pre-enlargement DOM state.
 *
 * OPERATION
 * ---------
 * 1. Idempotency guard: if not enlarged, returns immediately.
 * 2. Finds all wrapper spans via DATA_MARKER attribute.
 * 3. Replaces each span with a plain text node containing its text.
 * 4. Calls document.body.normalize() to merge adjacent text nodes.
 * 5. Clears CSS custom properties.
 *
 * OBSERVER COORDINATION
 * ---------------------
 * This function does NOT stop the MutationObserver. The content script
 * (content.ts) stops the observer BEFORE calling this function in
 * deactivateEnlargement(). This ordering is critical: if the observer
 * were still connected, it would fire on our unwrapping mutations
 * (removing spans, normalize() merging text nodes) and potentially
 * attempt to re-process the restored text — wasteful at best, a race
 * condition at worst.
 *
 * WHY normalize() MATTERS
 * -----------------------
 * After unwrapping, the DOM contains split text nodes where the
 * original single text node was. For example, the original:
 *
 *   TextNode("Hello مرحبا world")
 *
 * was split by enlargeArabicText() into:
 *
 *   TextNode("Hello ") + <span>مرحبا</span> + TextNode(" world")
 *
 * After removing the span:
 *
 *   TextNode("Hello ") + TextNode("مرحبا") + TextNode(" world")
 *
 * These three adjacent text nodes are functionally equivalent to one,
 * but they are NOT the same DOM structure as the original. Some web
 * frameworks (React, Angular) hold references to specific text nodes
 * and may behave unexpectedly if the node count changes.
 *
 * normalize() merges adjacent text nodes into single nodes:
 *
 *   TextNode("Hello مرحبا world")
 *
 * This restores the DOM to a state structurally identical to the
 * original — not just visually identical, but node-for-node identical.
 *
 * LIMITATION: if a framework held a direct reference to the original
 * text node (before our wrapping), that reference is already broken
 * by the initial wrapping step. normalize() creates a *new* merged
 * text node, it does not resurrect the original. In practice, this
 * is rarely a problem because frameworks that hold text node references
 * (React) re-render and create new nodes anyway.
 */
export function restoreOriginalText(): void {

    if (!isEnlarged) return;

    // Observer is stopped by content.ts in deactivateEnlargement()
    // BEFORE this function is called — no observer management here.

    // Find all our wrapper spans. The DATA_MARKER attribute is our sole
    // identifier — guaranteed unique, no false positives.
    const wrappedSpans = document.querySelectorAll<HTMLSpanElement>(
        `[${DATA_MARKER}]`
    );

    for (const span of wrappedSpans) {
        const parent = span.parentNode;
        if (!parent) continue;

        // Replace the <span> with a plain text node.
        // We use span.textContent (not span.innerText) because:
        //   - textContent returns raw text, no layout computation
        //   - innerText triggers a reflow to compute visibility
        //   - our spans contain only text (no nested elements),
        //     so both would return the same string, but textContent
        //     is cheaper
        const textNode = document.createTextNode(span.textContent ?? "");
        parent.replaceChild(textNode, span);
    }

    // Merge adjacent text nodes created by the unwrapping above.
    // See the docstring above for why this matters.
    document.body.normalize();

    // Remove CSS custom properties — leave no trace
    clearSettings();

    isEnlarged = false;
}

/**
 * Returns whether the Arabic text is currently enlarged.
 *
 * Used by the content script's "query-state" message handler to report
 * the actual DOM state back to the background service worker. This is
 * the resynchronization mechanism that handles service worker restarts:
 * after Chrome kills and restarts the service worker, it can ask each
 * tab's content script for the true visual state rather than relying
 * on potentially stale storage data.
 */
export function isCurrentlyEnlarged(): boolean {
    return isEnlarged;
}
