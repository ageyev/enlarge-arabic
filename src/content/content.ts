/**
 * ============================================================================
 * Content Script — Orchestration Layer for [enlarge arabic]
 * ============================================================================
 *
 * PURPOSE
 * -------
 * This script runs on every web page (declared in manifest.json under
 * content_scripts, at "document_idle"). It is the orchestration layer
 * between the background service worker (user interaction: icon clicks,
 * settings) and the arabic-text-processor module (DOM surgery: wrapping
 * Arabic text in spans).
 *
 *
 * RESPONSIBILITIES
 * ----------------
 *   1. MESSAGE HANDLING: Listens for messages from the background service
 *      worker ("toggle", "update-settings", "query-state") and delegates
 *      to the processor module.
 *
 *   2. MUTATION OBSERVER: Watches for dynamically added content (AJAX,
 *      infinite scroll, SPA component rendering) and processes new Arabic
 *      text automatically. This is what makes the extension work on modern
 *      web applications, not just static pages.
 *
 *   3. SPA NAVIGATION DETECTION: Intercepts History API calls (pushState,
 *      replaceState) and popstate events to detect client-side navigation.
 *      When the URL changes without a page reload, it triggers re-processing
 *      as a safety net for content the MutationObserver might miss.
 *
 *   4. SELF-INITIALIZATION: On a script load, checks chrome.storage.local
 *      for the current domain's toggle state. If enlargement is already
 *      enabled for this domain, applies it immediately — without waiting
 *      for a message from the background service worker.
 *
 *
 * WHY THE OBSERVER LIVES HERE (NOT IN THE PROCESSOR)
 * ---------------------------------------------------
 * The arabic-text-processor module is a pure DOM manipulation library:
 * given a subtree, it finds Arabic text and wraps it. It knows nothing
 * about Chrome extension APIs, messages, storage, or page lifecycle.
 *
 * The MutationObserver, by contrast, is an orchestration concern:
 *   - Its lifecycle is tied to the extension's toggle state
 *   - It must coordinate with SPA navigation detection
 *   - It needs requestAnimationFrame for debouncing (a scheduling API)
 *   - It must handle nodes that vanish between observation and processing
 *
 * Keeping these concerns here preserves the processor's testability
 * (it can be unit-tested in any DOM environment without mocking Chrome
 * APIs or MutationObservers) and gives content.ts full control over
 * when and how processing is triggered.
 *
 *
 * REQUIRED CHANGES IN arabic-text-processor.ts
 * ---------------------------------------------
 * This content script requires the processor to export two functions
 * that are currently internal and to remove its own observer code.
 * See the companion file `processor-modifications.ts` for the exact
 * changes needed, or the PROCESSOR MODIFICATIONS section at the end
 * of this file.
 *
 *
 * @module content
 */

// ============================================================================
// IMPORTS
// ============================================================================

// https://stackoverflow.com/questions/49996456/importing-json-file-in-typescript
import manifest from "../../public/manifest.json";
import {enlargeArabicText, processAddedNode, processSubtree, restoreOriginalText,} from "./arabic-text-processor";

import {loadEffectiveSettings} from "../shared/storage";

import {DEFAULT_FONT_SIZE, DEFAULT_LINE_HEIGHT, GLOBAL_SETTINGS_KEY, type GlobalSettings,} from "../shared/constants";

console.info(manifest.name + " " + manifest.version + " content script started");

const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
    fontSize: DEFAULT_FONT_SIZE,
    lineHeight: DEFAULT_LINE_HEIGHT,
};

/**
 * Apply enlargement settings to CSS custom properties on <html>.
 * All .arabic-enlarged spans reference these properties via var(),
 * so the update propagates instantly — no DOM surgery needed.
 */
function applyEnlargementSettings(settings: GlobalSettings): void {

    document.documentElement.style.setProperty(
        "--arabic-enlarger-size",
        `${settings.fontSize}em`
    );

    document.documentElement.style.setProperty(
        "--arabic-enlarger-height",
        settings.lineHeight
    );
}

// ============================================================================
// MUTATION OBSERVER
// ============================================================================
//
// PROBLEM
// -------
// Modern web pages load content dynamically: AJAX responses are injected
// into the DOM, React/Vue components render asynchronously, infinite scroll
// appends items, live feeds update in real time. Without a MutationObserver,
// the extension would only process the content present at the moment the
// user clicks the icon. Everything loaded afterward would remain small.
//
//
// WHAT WE OBSERVE
// ---------------
// Two types of mutations, each catching a different class of dynamic update:
//
//   childList (subtree: true):
//     Fires when elements or text nodes are added to or removed from the
//     DOM. This catches the overwhelming majority of dynamic content: AJAX
//     responses being injected, React components mounting, infinite scroll
//     loading new items, chat messages appearing, etc.
//
//   characterData (subtree: true):
//     Fires when the textContent / nodeValue of an EXISTING text node is
//     modified in place. This is the mutation type that the original
//     processor's observer was missing. Some frameworks — notably React's
//     reconciler and Vue's reactivity system — update displayed text by
//     mutating existing text nodes rather than replacing them:
//
//       // React updates a <span>{message}</span>:
//       // It doesn't replace the <span> — it finds the text node inside
//       // and sets textNode.nodeValue = newArabicMessage
//
//     Without characterData observation, if the new text contains Arabic
//     where the old text did not, we would never process it — because no
//     new nodes were added to the DOM.
//
//
// WHAT WE DO NOT OBSERVE (AND WHY)
// ---------------------------------
//   attributes:
//     Some SPAs show/hide pre-rendered content by changing CSS classes or
//     inline styles (display:none → display:block). Observing attribute
//     mutations would catch this, but it is prohibitively expensive: on
//     a complex page, every class toggle, every style update, every data
//     attribute change on every element in the entire body would trigger
//     our callback — thousands of irrelevant invocations per second.
//     The cost-benefit ratio is terrible.
//
//     We accept this gap and rely on SPA navigation detection (below)
//     as a safety net for show/hide patterns. When we detect a pushState
//     or popstate, we re-scan the entire page — which catches content
//     that was made visible via CSS rather than via DOM insertion.
//
//
// THE FEEDBACK LOOP (Wudooh Issue #23)
// ------------------------------------
// When our observer fires and we process the new content (inserting
// <span> elements), those insertions are themselves DOM mutations. If the
// observer is still connected, it fires again for our own changes, we
// process them, they trigger more mutations — infinite loop. This was the
// exact bug in Wudooh (GitHub Issue #23), which caused Google Search to
// freeze in an infinite reload cycle.
//
// The original processor solved this with a simple disconnect/reconnect
// pattern: disconnect before processing, reconnect after. This works but
// has a critical flaw: between disconnect and reconnect, ANY mutations
// from the page (not just ours) are lost. If AJAX delivers new content
// during our processing, we will never see it.
//
//
// OUR SOLUTION: COLLECT → SCHEDULE → FLUSH
// -----------------------------------------
// Instead of processing synchronously in the observer callback (which
// requires disconnecting), we split the work into two phases:
//
//   Phase 1 — COLLECT (in handleMutations, runs synchronously):
//     The observer callback only collects references to added/changed
//     nodes into a pending queue. No DOM modifications happen here.
//     The observer stays CONNECTED throughout — no mutations are lost.
//     If a processing pass is not already scheduled, we schedule one
//     via requestAnimationFrame.
//
//   Phase 2 — FLUSH (in flushPendingNodes, runs in the next rAF):
//     a. Call observer.takeRecords() to drain any mutations that were
//        queued between the last handleMutations call and now.
//     b. Snapshot the pending queue and clear it.
//     c. DISCONNECT the observer.
//     d. Process all collected nodes (our DOM modifications happen here,
//        but the observer is disconnected, so no feedback loop).
//     e. RECONNECT the observer.
//
// This design has three advantages over the original approach:
//
//   1. BATCHING: When Twitter loads 50 tweets via infinite scroll, the
//      observer fires multiple times. Each callback just pushes nodes
//      into the queue. A single rAF processes them all. The original
//      approach would disconnect/process/reconnect for each batch —
//      50 disconnect/reconnect cycles instead of 1.
//
//   2. NO MUTATION LOSS: The observer stays connected during the
//      collection phase. We only disconnect during the actual processing
//      (which happens in a single rAF). The window of disconnection is
//      minimized, and takeRecords() captures anything queued just before.
//
//   3. FRAME-ALIGNED: Processing happens in requestAnimationFrame,
//      which the browser runs right before repaint. This means our
//      span insertions are batched with the browser's own layout/paint
//      cycle, reducing visual jank.
//
//
// DEFENSE IN DEPTH
// ----------------
// Even though the disconnect/reconnect pattern prevents the feedback
// loop, we maintain a second defense layer:
//   - The TreeWalker in processSubtree() rejects elements carrying
//     DATA_MARKER (our wrapper spans), so even if the observer
//     somehow fires on our own nodes, the processor won't descend
//     into them.
//   - processAddedNode() checks DATA_MARKER on elements and parent
//     elements before processing, skipping our own insertions.
// This belt-and-suspenders approach is justified by the severity of the
// failure mode (infinite loop → page freeze).
//
// ============================================================================

/**
 * Observer configuration object.
 *
 * Defined as a named constant rather than an inline object literal
 * because we use it in two places: startArabicObserver() and
 * flushPendingNodes() (when reconnecting). A single source of truth
 * prevents configuration drift between the two call sites.
 */
const OBSERVER_CONFIG: MutationObserverInit = {
    childList: true,
    subtree: true,
    characterData: true,
};

// ── Observer state ──────────────────────────────────────────────────

/**
 * The MutationObserver instance, or null when not observing.
 *
 * Lifecycle:
 *   null (extension off)
 *   → created + connected in startArabicObserver()
 *   → temporarily disconnected/reconnected during flushPendingNodes()
 *   → disconnected + nulled in stopArabicObserver()
 */
let observer: MutationObserver | null = null;

/**
 * Queue of DOM nodes awaiting processing.
 *
 * handleMutations() pushes nodes here; flushPendingNodes() drains it.
 *
 * WHY AN ARRAY, NOT A SET:
 * A Set would deduplicate nodes that appear in multiple MutationRecords
 * (e.g., a node removed then re-added in the same microtask). But
 * deduplication is unnecessary: processAddedNode() and processSubtree()
 * are idempotent — the TreeWalker's DATA_MARKER check ensures
 * already-wrapped text is skipped. Processing a node twice finds
 * nothing new to wrap. An array is cheaper to push into and iterate
 * over than a Set, and maintaining insertion order (though not required
 * for correctness) aids debuggability.
 */
let pendingNodes: Node[] = [];

/**
 * ID of the scheduled requestAnimationFrame callback, or null if no
 * processing is currently scheduled.
 *
 * Used as a "one-shot guard": handleMutations() only calls
 * requestAnimationFrame() when this is null. Multiple observer
 * callbacks within the same frame all contribute to the same
 * pendingNodes queue, and a single rAF processes them all.
 * Without this guard, each observer callback would schedule its
 * own rAF, causing the same batch to be processed multiple times.
 */
let scheduledFrameId: number | null = null;


// ── Observer callback ───────────────────────────────────────────────

/**
 * Callback invoked by the MutationObserver whenever DOM changes occur.
 *
 * This function deliberately performs ZERO DOM modifications. It:
 *   1. Collects references to added/changed nodes into pendingNodes
 *   2. Schedules flushPendingNodes() for the next animation frame
 *      (if not already scheduled)
 *
 * WHY NO DOM WORK HERE:
 * If we processed nodes here (as the original handleMutations did),
 * we would need to disconnect the observer first — creating a window
 * where page mutations are lost. By deferring processing to rAF,
 * the observer stays connected during collection, and we disconnect
 * only for the brief duration of actual DOM modification.
 *
 * MUTATION TYPES HANDLED:
 *
 *   "childList" — mutation.addedNodes contains the new Element or Text
 *   nodes inserted into the DOM. We collect each addedNode. We ignore
 *   removedNodes entirely — we only care about content appearing, not
 *   disappearing.
 *
 *   "characterData" — mutation.target is the Text node whose nodeValue
 *   changed. We collect the target node so flushPendingNodes() can
 *   check whether the new text contains Arabic.
 *
 *   Note: we do NOT observe "attributes" (see WHY NOT section above),
 *   so that mutation type never reaches this callback.
 */
function handleMutations(mutations: MutationRecord[]): void {
    collectNodesFromMutations(mutations);

    // Schedule a processing pass for the next animation frame, but
    // only if one isn't already scheduled. This is the core of the
    // debouncing strategy: many observer callbacks within the same
    // frame all contribute to the same queue, and one rAF drains it.
    if (scheduledFrameId === null) {
        scheduledFrameId = requestAnimationFrame(flushPendingNodes);
    }
}

/**
 * Extracts added/changed nodes from MutationRecords into pendingNodes.
 *
 * Factored out because the same logic is needed in two places:
 *   1. handleMutations() — processes records delivered by the observer
 *   2. flushPendingNodes() — processes records from takeRecords()
 *
 * We could have inlined this, but duplicating the mutation.type
 * dispatch logic in two places invites subtle divergence (e.g.,
 * adding a new mutation type in one place but forgetting the other).
 * The DRY principle applies here despite the small function size.
 */
function collectNodesFromMutations(mutations: MutationRecord[]): void {
    for (const mutation of mutations) {
        if (mutation.type === "childList") {
            for (const addedNode of mutation.addedNodes) {
                pendingNodes.push(addedNode);
            }
        }
        if (mutation.type === "characterData") {
            pendingNodes.push(mutation.target);
        }
    }
}


// ── Flush (the actual work) ─────────────────────────────────────────

/**
 * Processes all collected nodes in a single batch.
 *
 * Invoked by requestAnimationFrame — runs once right before the
 * browser's next repaint. This is the optimal timing for DOM
 * modifications: late enough to batch rapid mutations, early enough
 * that the user never sees un-enlarged Arabic text flash on screen.
 *
 * The six-step flow is documented inline. The key invariant is:
 * DOM modifications (step 5) happen ONLY while the observer is
 * disconnected (steps 4–6), preventing the feedback loop.
 */
function flushPendingNodes(): void {

    // ── Step 1: Clear the scheduling flag ──
    // Setting this to null allows handleMutations() to schedule a
    // new rAF for mutations that arrive AFTER this flush begins.
    // (They would go into a fresh pendingNodes array — see step 3.)
    scheduledFrameId = null;

    // ── Step 2: Drain the observer's internal queue ──
    // Between the last handleMutations() delivery and this rAF, the
    // observer may have accumulated additional MutationRecords that
    // haven't been delivered yet. takeRecords() retrieves them and
    // clears the internal queue. Without this, those records would
    // be lost when we disconnect in step 4.
    //
    // WHY CAN THERE BE UNDELIVERED RECORDS?
    // MutationObserver delivers records asynchronously via microtasks.
    // If the page makes DOM changes between our last microtask delivery
    // and this rAF macrotask, those changes are queued internally but
    // not yet delivered. takeRecords() is the only way to capture them.
    if (observer) {
        const remainingMutations = observer.takeRecords();
        collectNodesFromMutations(remainingMutations);
    }

    // ── Step 3: Snapshot and clear the queue ──
    // We swap pendingNodes with a fresh empty array rather than
    // calling .length = 0 on the existing one. This way, if anything
    // (defense in depth) pushes to pendingNodes during processing,
    // it writes to the new array rather than corrupting our iteration.
    const nodesToProcess = pendingNodes;
    pendingNodes = [];

    // ── Step 4: Disconnect the observer ──
    // From here until step 6, our DOM modifications (inserting <span>
    // elements inside processAddedNode) do NOT trigger observer
    // callbacks. This is the primary defense against the feedback loop.
    //
    // MUTATION LOSS DURING THIS WINDOW:
    // Yes, page-initiated mutations during steps 4–6 are lost. But
    // this window is very short (one synchronous loop over collected
    // nodes), and any such mutations would arrive in the NEXT observer
    // delivery after we reconnect in step 6. In practice, this window
    // is sub-millisecond for typical mutation batches.
    if (observer) {
        observer.disconnect();
    }

    // ── Step 5: Process all collected nodes ──
    for (const node of nodesToProcess) {
        // Skip nodes that have been removed from the DOM between
        // collection and processing. This is common in SPAs where
        // components are rapidly mounted and unmounted — e.g., a
        // loading spinner replaced by actual content within the
        // same frame, or a virtual list recycling DOM nodes.
        if (!node.isConnected) continue;

        // processAddedNode handles both Element and Text nodes,
        // with all necessary skip checks (SKIP_TAGS, contenteditable,
        // DATA_MARKER). See arabic-text-processor.ts for details.
        processAddedNode(node);
    }

    // ── Step 6: Reconnect the observer ──
    // From this point, new mutations are observed normally.
    // Mutations caused by our processing in step 5 happened while
    // disconnected and will never be delivered — exactly as intended.
    if (observer) {
        observer.observe(document.body, OBSERVER_CONFIG);
    }
}


// ── Observer lifecycle ──────────────────────────────────────────────

/**
 * Creates (if needed) and connects the MutationObserver.
 *
 * Called when enlargement is activated. After this call, any dynamic
 * content additions or text mutations on the page will be automatically
 * processed for Arabic text.
 *
 * WHY document.body, NOT document.documentElement:
 * <head> mutations (stylesheet loads, meta tags, title changes) are
 * irrelevant and would waste CPU in the observer callback. All visible
 * content lives under document.body.
 *
 * IDEMPOTENT: safe to call when already observing. We disconnect
 * first, clear pending state, then reconnect — no zombie observers.
 */
function startArabicObserver(): void {
    // Reset any pending state from a previous cycle
    if (observer) {
        observer.disconnect();
    }
    if (scheduledFrameId !== null) {
        cancelAnimationFrame(scheduledFrameId);
        scheduledFrameId = null;
    }
    pendingNodes = [];

    if (!observer) {
        observer = new MutationObserver(handleMutations);
    }

    observer.observe(document.body, OBSERVER_CONFIG);
}

/**
 * Disconnects the observer and clears all pending state.
 *
 * Called when enlargement is deactivated. After this call, no dynamic
 * content will be processed until startArabicObserver() runs again.
 *
 * MUST be called BEFORE restoreOriginalText(). Reason:
 * restoreOriginalText() removes <span> elements and calls normalize(),
 * both of which are DOM mutations. If the observer is still connected,
 * it would collect these cleanup mutations, schedule a rAF, and then
 * attempt to process text nodes in a DOM that has already been restored
 * — wasteful at best, a source of race conditions at worst.
 */
function stopArabicObserver(): void {
    if (scheduledFrameId !== null) {
        cancelAnimationFrame(scheduledFrameId);
        scheduledFrameId = null;
    }
    pendingNodes = [];

    if (observer) {
        observer.disconnect();
        observer = null;
    }
}


// ============================================================================
// SPA NAVIGATION DETECTION
// ============================================================================
//
// PROBLEM
// -------
// Single Page Applications (React, Vue, Angular, Next.js, etc.) navigate
// between "pages" without full page reloads. They call history.pushState()
// to change the URL, then update the DOM.
//
// In most cases, the MutationObserver catches the DOM updates that follow
// a navigation. But there are edge cases where it does not:
//
//   1. SHOW/HIDE PATTERNS: some SPAs pre-render multiple "pages" and
//      toggle between them via CSS (display:none → display:block).
//      No nodes are added or removed — only attributes change. Our
//      observer (childList + characterData, not attributes) misses this.
//
//   2. CACHED COMPONENTS: a SPA may cache rendered components and
//      re-display them without re-creating DOM nodes.
//
//   3. RECONCILIATION TIMING: React batches DOM updates. The observer
//      might fire mid-reconciliation, before the final content is in
//      the DOM.
//
// SOLUTION
// --------
// We intercept History API calls (pushState, replaceState) and listen
// for popstate events. On detection, we schedule a re-processing of
// document.body after a short delay. This is safe because processSubtree
// is idempotent — already-wrapped text is skipped.
//
//
// WHY WE WRAP pushState/replaceState
// -----------------------------------
// There is NO native "pushstate" event. The browser fires "popstate"
// only on Back/Forward navigation (or history.back()/forward()), NOT
// on programmatic pushState()/replaceState() calls. To detect all
// navigation types, we must intercept these methods by replacing them
// with wrappers that dispatch custom events.
//
// This is a well-established pattern used by Google Analytics, Segment,
// and other tools that track SPA navigation.
//
// ============================================================================

/**
 * Delay (ms) between detecting a SPA navigation and re-processing.
 *
 * SPAs typically call pushState first, then render the new content
 * asynchronously (React's reconciliation, Vue's nextTick, Angular's
 * change detection). We wait for the render cycle to complete before
 * scanning the DOM.
 *
 * 100ms is a practical compromise:
 *   - Long enough for React/Vue to complete a typical render
 *   - Short enough that un-enlarged Arabic text is barely noticeable
 *   - If rendering takes longer, the MutationObserver catches the rest
 */
const SPA_REPROCESS_DELAY_MS = 100;

/** Timer ID for debouncing rapid SPA navigations. */
let spaReprocessTimerId: ReturnType<typeof setTimeout> | null = null;

/**
 * Whether SPA monitoring is active (enlargement is enabled).
 *
 * The History API wrappers are installed permanently (see below), but
 * the navigation handler checks this flag before doing any work.
 * When the extension is toggled off, this is false, and navigation
 * events result in zero processing overhead.
 */
let spaMonitoringActive = false;

/**
 * Wraps a History API method to dispatch a custom event on each call.
 *
 * We replace history[methodName] with a function that:
 *   1. Calls the original method (the URL actually changes)
 *   2. Dispatches a custom event on window (our listener reacts)
 *
 * The SPA never knows its History API calls are being intercepted —
 * the wrapper preserves the original method's behavior exactly.
 *
 * WHY A CUSTOM EVENT RATHER THAN A DIRECT FUNCTION CALL:
 * Events decouple interception from handling. The wrapper needs no
 * knowledge of our extension internals. Other code (analytics, other
 * extensions) can listen for the same events. This is the standard
 * pattern used across the industry.
 *
 * @param methodName — "pushState" or "replaceState"
 * @param eventName  — custom event name to dispatch
 */
function wrapHistoryMethod(
    methodName: "pushState" | "replaceState",
    eventName: string,
): void {
    const original = history[methodName].bind(history);

    history[methodName] = function (
        data: unknown,
        unused: string,
        url?: string | URL | null,
    ): void {
        // Call the original first — the URL changes
        original(data, unused, url);
        // Fire our custom event so the navigation handler reacts
        window.dispatchEvent(new Event(eventName));
    };
}

/**
 * Reacts to a detected SPA navigation.
 *
 * Debounces rapid navigations: if the user clicks through multiple
 * SPA pages quickly, only the last navigation's re-processing runs.
 * Previous pending re-processes are cancelled.
 *
 * The re-processing calls processSubtree(document.body), which is
 * idempotent: the TreeWalker's DATA_MARKER check skips already-
 * wrapped text. Only newly-appeared (unwrapped) Arabic text is
 * processed.
 */
function handleSpaNavigation(): void {
    if (!spaMonitoringActive) return;

    // Cancel any pending re-processing from a prior navigation
    if (spaReprocessTimerId !== null) {
        clearTimeout(spaReprocessTimerId);
    }

    spaReprocessTimerId = setTimeout(() => {
        spaReprocessTimerId = null;

        // Disconnect/reconnect around re-processing to prevent
        // our span insertions from triggering the observer.
        // Same pattern as flushPendingNodes, same reason.
        if (observer) {
            observer.disconnect();
        }

        processSubtree(document.body);

        if (observer) {
            observer.observe(document.body, OBSERVER_CONFIG);
        }
    }, SPA_REPROCESS_DELAY_MS);
}

/**
 * Installs SPA navigation detection. Called once at script load.
 *
 * The History API wrapping is permanent — it cannot be cleanly undone
 * because other code may have wrapped the methods after us. But the
 * navigation handler checks spaMonitoringActive before doing work,
 * so the overhead when the extension is off is one boolean check per
 * navigation event (effectively zero).
 *
 * WHY WE DON'T UNWRAP ON TOGGLE-OFF:
 * If we wrap pushState, then a SPA wraps pushState on top of us,
 * then we unwrap — the SPA's wrapper now calls the raw pushState
 * instead of our wrapper, and our listener never fires. Worse, the
 * SPA's wrapper may hold a stale reference. The safe practice is:
 * wrap once, gate on a flag, never unwrap.
 */
function installSpaNavigationDetection(): void {
    wrapHistoryMethod("pushState", "ext:pushstate");
    wrapHistoryMethod("replaceState", "ext:replacestate");

    window.addEventListener("ext:pushstate", handleSpaNavigation);
    window.addEventListener("ext:replacestate", handleSpaNavigation);

    // popstate fires natively on Back/Forward navigation.
    // This is the ONE case where the browser fires an event for
    // a History API action. We listen for it alongside our custom
    // events for complete coverage.
    window.addEventListener("popstate", handleSpaNavigation);
}

// ============================================================================
// ACTIVATION / DEACTIVATION — centralized toggle logic
// ============================================================================

/**
 * Activates Arabic text enlargement: processes the page, starts the
 * observer, enables SPA monitoring.
 *
 * This is the SINGLE ENTRY POINT for turning the extension ON.
 * Called from both the message handler and self-initialization.
 *
 * ORDER OF OPERATIONS MATTERS:
 *
 *   1. enlargeArabicText()         — process existing content
 *   2. startArabicObserver()       — watch for new content
 *   3. spaMonitoringActive = true  — react to SPA navigation
 *
 * Step 1 must precede step 2. If we started observing first, our own
 * DOM modifications from step 1 would trigger the observer. The
 * observer's debouncing would handle this correctly (the disconnect
 * in flushPendingNodes prevents the feedback loop), but triggering
 * a collect → rAF → flush cycle for our own initial processing is
 * wasteful. Processing first, observing second, is cleaner.
 *
 * Why this function is thin: all the heavy lifting (DOM walking,
 * Deep Sleep check, span wrapping) is inside enlargeArabicText().
 * This function's role is orchestration — ensuring the three systems
 * (processor, observer, SPA monitor) are activated in the right order.
 */
let isCurrentlyEnabled = false;
async function activateEnlargement(): Promise<void> {

    // Load user's global settings (or fall back to built-in defaults).
    // const globalSettings = await loadGlobalSettings();
    // applyGlobalSettings(globalSettings);
    //
    // enlargeArabicText(true);  // user explicitly requested — skip Deep Sleep
    // isCurrentlyEnabled = true;

    // Load effective settings: domain overrides → global → built-in defaults
    const hostname = window.location.hostname;

    const settings = await loadEffectiveSettings(hostname);

    applyEnlargementSettings(settings);

    enlargeArabicText(true);
    isCurrentlyEnabled = true;

    startArabicObserver();
    spaMonitoringActive = true;
}

/**
 * Deactivates Arabic text enlargement: stops the observer, restores
 * the page, disables SPA monitoring.
 *
 * This is the SINGLE ENTRY POINT for turning the extension OFF.
 *
 * ORDER OF OPERATIONS MATTERS:
 *
 *   1. spaMonitoringActive = false — stop reacting to navigation
 *   2. stopArabicObserver()        — stop watching for mutations
 *   3. restoreOriginalText()       — undo all DOM modifications
 *
 * Steps 1–2 must precede step 3. restoreOriginalText() modifies the
 * DOM (removes spans, calls normalize()). If the observer were still
 * connected, it would collect these cleanup mutations, schedule
 * processing, and then attempt to wrap text in a DOM that has already
 * been restored — at minimum wasteful, at worst a race condition
 * where half-restored nodes are re-processed.
 *
 * Similarly, if an SPA navigation fired during restoration, the
 * handleSpaNavigation callback might try to processSubtree while
 * restoreOriginalText is mid-execution. Disabling the flag first
 * prevents this.
 */
function deactivateEnlargement(): void {
    spaMonitoringActive = false;
    stopArabicObserver();
    restoreOriginalText();
    isCurrentlyEnabled = false;
}

// ============================================================================
// MESSAGE HANDLER — communication with background service worker
// ============================================================================
chrome.runtime.onMessage.addListener((
    message,
    sender: chrome.runtime.MessageSender,
    sendResponse,
) => {
    // Existing toggle handler
    if (message.action === "toggle") {
        if (message.enabled) {
            activateEnlargement();
        } else {
            deactivateEnlargement();
        }
        sendResponse({ ok: true });
        return true;
    }

    // ── Sidepanel: live preview ────────────────────────────────
    // Applies temporary CSS values without touching storage.
    // Only effective when the extension is active on this page
    // (no .arabic-enlarged spans exist otherwise).
    if (message.action === "preview" && isCurrentlyEnabled) {
        applyEnlargementSettings({
            fontSize: message.fontSize,
            lineHeight: message.lineHeight,
        });
        sendResponse({ ok: true });
        return true;
    }

    // ── Sidepanel: revert preview ──────────────────────────────
    // Re-reads effective settings from storage and applies them,
    // discarding any unsaved preview values.
    if (message.action === "revertPreview" && isCurrentlyEnabled) {
        const hostname = window.location.hostname;
        loadEffectiveSettings(hostname).then((settings) => {
            applyEnlargementSettings(settings);
            sendResponse({ ok: true });
        });
        return true; // keeps message channel open for async sendResponse
    }
});

// ============================================================================
// SELF-INITIALIZATION — solving the message race condition
// ============================================================================
//
// THE RACE
// --------
// When the user navigates to a page where enlargement is already enabled:
//
//   1. Chrome loads the page
//   2. Chrome injects this content script at "document_idle"
//   3. The background service worker's tabs.onUpdated fires at
//      status === "complete" and sends a "toggle" message
//
// Steps 2 and 3 can race. "document_idle" and "complete" both fire
// after the DOM is ready, but their relative ordering is not guaranteed.
// If the background sends the message BEFORE this script has registered
// its chrome.runtime.onMessage listener, the message is silently dropped.
// Result: the page loads with un-enlarged Arabic text, and the user must
// click the icon again — a confusing experience.
//
// SOLUTION
// --------
// Don't rely on messages for the initial activation. On load, this
// script proactively reads the domain's toggle state from
// chrome.storage.local and activates if enabled.
//
// This makes the background's initial toggle message redundant (it may
// still arrive, but enlargeArabicText() is idempotent — calling it
// twice is harmless). The background message remains necessary only
// for real-time toggling (the user clicks the icon while on the page).
//
// ============================================================================

/**
 * Reads the current domain's toggle state from storage and activates
 * enlargement if enabled.
 *
 * Called once at script load. This function is async, but we do NOT
 * await it at the top level — the message listener above is registered
 * synchronously before this function runs, so messages from the
 * background are never missed even if this initialization takes time.
 *
 * The storage key convention ("domain_{hostname}") must match exactly
 * what the background service worker writes when the user toggles
 * the extension. Hostname is normalized (www. stripped) to unify
 * www.example.com and example.com.
 */
async function selfInitialize(): Promise<void> {
    // Strip "www." to unify www.example.com and example.com.
    // This normalization must match the background service worker's
    // key generation logic exactly.
    const hostname = window.location.hostname.replace(/^www\./, "");
    const domainKey = `domain_${hostname}`;

    try {
        // Provide a default of false — if the key doesn't exist in
        // storage (domain was never toggled), treat it as disabled.
        const stored = await chrome.storage.local.get({ [domainKey]: false });
        const isEnabledForThisDomain = stored[domainKey];

        if (isEnabledForThisDomain) {
            activateEnlargement();
        }
    } catch (error) {
        // chrome.storage.local.get fails if the extension context is
        // invalidated — e.g., the extension was updated while this
        // page was open. In that case, chrome.runtime is stale and
        // storage calls throw "Extension context invalidated."
        // This is not fatal: the user can still toggle via the icon
        // (which injects a fresh content script on the next click).
        console.warn("[enlarge arabic] self-initialization failed:", error);
    }
}

// TODO: consider removing this listener, so user will have to reload
// the page to apply changes (less code executed on every active page).
chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (!isCurrentlyEnabled) return;

    const hostname = window.location.hostname;

    // React to changes in global settings OR this domain's settings
    if (changes[GLOBAL_SETTINGS_KEY] || changes[hostname]) {
        loadEffectiveSettings(hostname).then((settings) => {
            applyEnlargementSettings(settings);
        });
    }
});

// ============================================================================
// SCRIPT ENTRY POINT
// ============================================================================

// 1. Install SPA navigation detection. This wraps pushState/replaceState
//    and registers event listeners. It is permanent and one-time — the
//    wrappers check spaMonitoringActive before doing any work.
installSpaNavigationDetection();

// 2. Self-initialize from storage. This is async — it reads from
//    chrome.storage.local and calls activateEnlargement() if the domain
//    is enabled. The message listener was registered synchronously above,
//    so incoming toggle messages from the background are never missed.
selfInitialize().catch(console.error);

