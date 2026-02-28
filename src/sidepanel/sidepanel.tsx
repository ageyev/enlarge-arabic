/**
 * [Enlarge Arabic] — Sidepanel (per-domain settings)
 *
 * Allows the user to configure font size and line height for the
 * current domain, with live preview on the actual page content.
 *
 * Tab tracking:
 *   - Queries active tab on mount
 *   - Listens for chrome.tabs.onActivated (tab switch)
 *   - Listens for chrome.tabs.onUpdated filtered by URL (navigation)
 *   - On tab/domain change: reverts preview on old tab, loads settings for new domain
 *
 * Preview model:
 *   - Slider drag → debounced sendMessage({ action: "preview" }) → content script
 *     applies CSS custom properties immediately
 *   - Preview is ephemeral: only Save persists to storage
 *   - Unsaved preview is reverted on tab switch, domain change, or sidepanel close
 *
 * Persistence:
 *   Save → merges { fontSize, lineHeight } into domain's storage object
 *   Reset → removes fontSize/lineHeight from domain's storage object
 *          (falls back to global defaults)
 */

import React, {useCallback, useEffect, useRef, useState} from "react";
import {createRoot} from "react-dom/client";

import Slider from "../shared/Slider";
import {loadEffectiveSettings, removeDomainOverrides} from "../shared/storage";
import {
    DEFAULT_FONT_SIZE,
    DEFAULT_LINE_HEIGHT,
    FONT_SIZE_MAX,
    FONT_SIZE_MIN,
    type GlobalSettings,
    LINE_HEIGHT_MAX,
    LINE_HEIGHT_MIN,
    SLIDER_STEP,
} from "../shared/constants";

// ── Constants ──────────────────────────────────────────────────────────────────

/** Debounce delay for preview messages (ms). */
const PREVIEW_DEBOUNCE_MS = 120;

/** Duration for "Saved ✓" / "Reset ✓" button feedback (ms). */
const FEEDBACK_DURATION_MS = 2000;

// ── Types ──────────────────────────────────────────────────────────────────────

interface TabInfo {
    tabId: number;
    domain: string;
}

type ButtonFeedback = "idle" | "in-progress" | "done";

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Extract the hostname from a URL. Returns null for non-web protocols
 * (chrome://, about:, file://, chrome-extension://) since these have
 * no meaningful domain for our purposes.
 */
function extractDomain(url: string): string | null {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return null;
        }
        return parsed.hostname || null;
    } catch {
        return null;
    }
}

/** Query the active tab in the current window. */
async function queryActiveTab(): Promise<TabInfo | null> {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) return null;

    const domain = extractDomain(tab.url);
    if (!domain) return null;

    return { tabId: tab.id, domain };
}

/**
 * Send a preview message to the content script.
 * Silently catches errors (content script may not be loaded
 * if the extension is not active on the page).
 */
function sendPreviewMessage(tabId: number, settings: GlobalSettings): void {
    chrome.tabs.sendMessage(tabId, {
        action: "preview",
        fontSize: settings.fontSize,
        lineHeight: settings.lineHeight,
    }).catch(() => {
        // Content script not available — preview silently skipped.
    });
}

/**
 * Tell the content script to discard the preview and re-read
 * saved settings from storage.
 */
function sendRevertMessage(tabId: number): void {
    chrome.tabs.sendMessage(tabId, {
        action: "revertPreview",
    }).catch(() => {
        // Content script not available — revert silently skipped.
    });
}

// ── Main Component ─────────────────────────────────────────────────────────────

function SidepanelPage() {
    // ── State ──────────────────────────────────────────────────

    const [tabInfo, setTabInfo] = useState<TabInfo | null>(null);
    const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE);
    const [lineHeight, setLineHeight] = useState(DEFAULT_LINE_HEIGHT);
    const [saveFeedback, setSaveFeedback] = useState<ButtonFeedback>("idle");
    const [resetFeedback, setResetFeedback] = useState<ButtonFeedback>("idle");

    // ── Refs (mutable state that doesn't trigger re-render) ───

    /** Last-saved effective settings for the current domain. */
    const savedSettingsRef = useRef<GlobalSettings>({
        fontSize: DEFAULT_FONT_SIZE,
        lineHeight: DEFAULT_LINE_HEIGHT,
    });

    /** Whether we've sent unsaved preview values to the content script. */
    const hasUnsavedPreviewRef = useRef(false);

    /** Debounce timer ID for preview messages. */
    const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    /**
     * Current tabInfo for use inside event listeners.
     * Avoids stale closures — event listeners registered in useEffect
     * would otherwise capture the tabInfo from the render when they
     * were created, not the current value.
     */
    const tabInfoRef = useRef<TabInfo | null>(null);

    // ── Core operations ────────────────────────────────────────

    /** Load effective settings for a domain and update all state. */
    const loadAndApplySettings = useCallback(async (info: TabInfo) => {
        const settings = await loadEffectiveSettings(info.domain);
        setFontSize(settings.fontSize);
        setLineHeight(settings.lineHeight);
        savedSettingsRef.current = settings;
        hasUnsavedPreviewRef.current = false;
    }, []);

    /** Transition to a new tab: revert old preview, load new settings. */
    const switchToTab = useCallback(async (newInfo: TabInfo) => {
        const oldInfo = tabInfoRef.current;

        // Revert preview on old tab if needed
        if (oldInfo && hasUnsavedPreviewRef.current) {
            sendRevertMessage(oldInfo.tabId);
        }

        // Cancel any pending debounced preview
        if (previewTimerRef.current) {
            clearTimeout(previewTimerRef.current);
            previewTimerRef.current = null;
        }

        // Update tab state
        setTabInfo(newInfo);
        tabInfoRef.current = newInfo;

        // Load settings for the new domain
        await loadAndApplySettings(newInfo);
    }, [loadAndApplySettings]);

    /**
     * Handle transition to a tab/URL with no usable domain
     * (chrome:// pages, about:blank, etc.).
     */
    const clearTab = useCallback(() => {
        const oldInfo = tabInfoRef.current;
        if (oldInfo && hasUnsavedPreviewRef.current) {
            sendRevertMessage(oldInfo.tabId);
        }

        if (previewTimerRef.current) {
            clearTimeout(previewTimerRef.current);
            previewTimerRef.current = null;
        }

        setTabInfo(null);
        tabInfoRef.current = null;
        hasUnsavedPreviewRef.current = false;
    }, []);

    // ── Effect: initialize on mount ────────────────────────────

    useEffect(() => {
        async function init() {
            const info = await queryActiveTab();
            if (info) {
                setTabInfo(info);
                tabInfoRef.current = info;
                await loadAndApplySettings(info);
            }
        }
        init();
    }, [loadAndApplySettings]);

    // ── Effect: track tab changes ──────────────────────────────

    useEffect(() => {
        /**
         * User switched to a different tab.
         */
        const handleActivated = async (
            activeInfo: { tabId: number; windowId: number },
        ) => {
            try {
                const tab = await chrome.tabs.get(activeInfo.tabId);
                if (!tab.url) return;

                const domain = extractDomain(tab.url);
                if (!domain) {
                    clearTab();
                    return;
                }

                await switchToTab({ tabId: activeInfo.tabId, domain });
            } catch {
                // Tab may have been closed between activation and query.
                clearTab();
            }
        };

        /**
         * URL changed within the currently tracked tab.
         * Catches both traditional navigation and SPA route changes.
         * Filtered: it only reacts to actual URL changes, ignores
         * loading state, title, favicon, and other tab updates.
         */
        const handleUpdated = async (
            tabId: number,
            changeInfo: { url?: string },
        ) => {
            if (!changeInfo.url) return;

            const current = tabInfoRef.current;
            if (!current || tabId !== current.tabId) return;

            const newDomain = extractDomain(changeInfo.url);

            if (!newDomain) {
                clearTab();
                return;
            }

            // Same domain — no action needed (SPA navigation within site)
            if (newDomain === current.domain) return;

            // Domain changed — switch context
            await switchToTab({ tabId, domain: newDomain });
        };

        chrome.tabs.onActivated.addListener(handleActivated);
        chrome.tabs.onUpdated.addListener(handleUpdated);

        return () => {
            chrome.tabs.onActivated.removeListener(handleActivated);
            chrome.tabs.onUpdated.removeListener(handleUpdated);
        };
    }, [switchToTab, clearTab]);

    // ── Effect: debounced live preview ─────────────────────────

    useEffect(() => {
        if (!tabInfo) return;

        // Skip if values haven't diverged from saved settings
        // (prevents spurious preview on mount and after save/reset)
        const saved = savedSettingsRef.current;
        if (fontSize === saved.fontSize && lineHeight === saved.lineHeight) {
            return;
        }

        if (previewTimerRef.current) {
            clearTimeout(previewTimerRef.current);
        }

        previewTimerRef.current = setTimeout(() => {
            sendPreviewMessage(tabInfo.tabId, { fontSize, lineHeight });
            hasUnsavedPreviewRef.current = true;
            previewTimerRef.current = null;
        }, PREVIEW_DEBOUNCE_MS);

        return () => {
            if (previewTimerRef.current) {
                clearTimeout(previewTimerRef.current);
                previewTimerRef.current = null;
            }
        };
    }, [fontSize, lineHeight, tabInfo]);

    // ── Effect: revert preview on sidepanel close ──────────────

    useEffect(() => {
        const handleUnload = () => {
            const info = tabInfoRef.current;
            if (info && hasUnsavedPreviewRef.current) {
                // Best-effort: message may not complete before page unloads.
                // Worst case: preview persists until next toggle or page reload.
                sendRevertMessage(info.tabId);
            }
        };

        window.addEventListener("beforeunload", handleUnload);
        return () => window.removeEventListener("beforeunload", handleUnload);
    }, []);

    // ── Save handler ───────────────────────────────────────────

    const handleSave = useCallback(async () => {

        if (!tabInfo) return;
        setSaveFeedback("in-progress");

        // Merge into existing domain data (preserve `enabled` and other fields)
        const result = await chrome.storage.local.get(tabInfo.domain);
        const existing = result[tabInfo.domain] ?? {};
        await chrome.storage.local.set({
            [tabInfo.domain]: { ...existing, fontSize, lineHeight },
        });

        savedSettingsRef.current = { fontSize, lineHeight };
        hasUnsavedPreviewRef.current = false;

        setSaveFeedback("done");
        setTimeout(() => setSaveFeedback("idle"), FEEDBACK_DURATION_MS);
    }, [tabInfo, fontSize, lineHeight]);

    // ── Reset handler ──────────────────────────────────────────

    const handleReset = useCallback(async () => {
        if (!tabInfo) return;
        setResetFeedback("in-progress");

        // Remove domain-specific overrides (keeps `enabled` flag intact)
        await removeDomainOverrides(tabInfo.domain);

        // Load new effective settings (now = global defaults)
        const effective = await loadEffectiveSettings(tabInfo.domain);
        setFontSize(effective.fontSize);
        setLineHeight(effective.lineHeight);
        savedSettingsRef.current = effective;

        // Content script re-reads from storage (which no longer has overrides)
        sendRevertMessage(tabInfo.tabId);
        hasUnsavedPreviewRef.current = false;

        setResetFeedback("done");
        setTimeout(() => setResetFeedback("idle"), FEEDBACK_DURATION_MS);
    }, [tabInfo]);

    // ── Render ─────────────────────────────────────────────────

    // No usable domain (chrome:// page, new tab, etc.)
    if (!tabInfo) {
        return (
            <div>

                <h1>[Enlarge Arabic]</h1>

                <div className="settings-card">
                    <p className="info-message">
                        No webpage detected. Open a webpage to configure
                        domain-specific enlargement settings.
                    </p>
                </div>
            </div>
        );
    }

    const saveLabel =
        saveFeedback === "in-progress" ? "Saving…" :
            saveFeedback === "done"        ? "Saved ✓" :
                "Save for this site";

    const resetLabel =
        resetFeedback === "in-progress" ? "Resetting…" :
            resetFeedback === "done"        ? "Reset ✓" :
                "Reset to global defaults";

    const isAnyActionInProgress =
        saveFeedback === "in-progress" || resetFeedback === "in-progress";

    return (
        <div>

            {/*<h1>[Enlarge Arabic]</h1> */}

            <p className="sidepanel-subtitle">
                Settings for <strong>{tabInfo.domain}</strong>
            </p>
            <hr/>
            <br/>

            <div className="settings-card">
                <h2>Enlargement</h2>
                <Slider
                    label="Font size"
                    value={fontSize}
                    unit=" em"
                    min={FONT_SIZE_MIN}
                    max={FONT_SIZE_MAX}
                    step={SLIDER_STEP}
                    onChange={setFontSize}
                />
                <Slider
                    label="Line height"
                    value={lineHeight}
                    min={LINE_HEIGHT_MIN}
                    max={LINE_HEIGHT_MAX}
                    step={SLIDER_STEP}
                    onChange={setLineHeight}
                />
            </div>

            <div className="button-row">
                <button
                    className="btn btn-reset"
                    data-status={resetFeedback === "done" ? "reset" : undefined}
                    disabled={isAnyActionInProgress}
                    onClick={handleReset}
                >
                    {resetLabel}
                </button>
                <button
                    className="btn btn-save"
                    data-status={saveFeedback === "done" ? "saved" : undefined}
                    disabled={isAnyActionInProgress}
                    onClick={handleSave}
                >
                    {saveLabel}
                </button>
            </div>
        </div>
    );
}

// ── Mount ──────────────────────────────────────────────────────────────────────

const rootElement = document.getElementById("root");

if (rootElement) {
    createRoot(rootElement).render(<SidepanelPage />);
} else {
    console.error("[Enlarge Arabic] Sidepanel: #root element not found");
}
