/**
 * Shared storage utilities for [Enlarge Arabic].
 *
 * Provides functions for reading and manipulating enlargement settings
 * in chrome.storage.local. Used by: sidepanel, content script.
 *
 * Storage schema:
 *   "__global_settings__": { fontSize: "1.40", lineHeight: "1.60" }
 *   "ar.wikipedia.org":   { enabled: true, fontSize?: "1.60", lineHeight?: "1.80" }
 *
 * Merge chain: domain overrides → global settings → built-in defaults.
 */

import {DEFAULT_FONT_SIZE, DEFAULT_LINE_HEIGHT, GLOBAL_SETTINGS_KEY, type GlobalSettings,} from "./constants";

// ── Types ──────────────────────────────────────────────────────────────────────

/**
 * Per-domain data stored in chrome.storage.local.
 * The `enabled` flag tracks whether the extension is toggled on.
 * Optional fontSize/lineHeight are domain-specific enlargement overrides
 * (set via sidepanel; absent = use global defaults).
 */
export interface DomainData {
    enabled?: boolean;
    fontSize?: string;
    lineHeight?: string;
}

// ── Read operations ────────────────────────────────────────────────────────────

/**
 * Load effective enlargement settings for a domain.
 *
 * Merge chain (first defined value wins):
 *   1. Domain-specific override (from sidepanel)
 *   2. Global settings (from options page)
 *   3. Built-in defaults (matching content.css fallback values)
 *
 * Reads both keys in a single storage call for efficiency.
 */
export async function loadEffectiveSettings(domain: string): Promise<GlobalSettings> {

    const result = await chrome.storage.local.get([GLOBAL_SETTINGS_KEY, domain]);

    const globalData = result[GLOBAL_SETTINGS_KEY] as GlobalSettings | undefined;
    const domainData = result[domain] as DomainData | undefined;

    return {
        fontSize:
            domainData?.fontSize
            ?? globalData?.fontSize
            ?? DEFAULT_FONT_SIZE,
        lineHeight:
            domainData?.lineHeight
            ?? globalData?.lineHeight
            ?? DEFAULT_LINE_HEIGHT,
    };
}

/**
 * Load global settings only (no domain merge).
 * Used by the options page and the storage.onChanged listener in content.ts.
 */
// TODO: can be removed
export async function loadGlobalSettings(): Promise<GlobalSettings> {
    const result = await chrome.storage.local.get(GLOBAL_SETTINGS_KEY);
    const stored = result[GLOBAL_SETTINGS_KEY] as GlobalSettings | undefined;

    return {
        fontSize: stored?.fontSize ?? DEFAULT_FONT_SIZE,
        lineHeight: stored?.lineHeight ?? DEFAULT_LINE_HEIGHT,
    };
}

// ── Write operations ───────────────────────────────────────────────────────────

/**
 * Remove domain-specific enlargement overrides from storage,
 * preserving other domain data (e.g., the `enabled` flag).
 *
 * After this call, the domain falls back to global settings.
 */
export async function removeDomainOverrides(domain: string): Promise<void> {

    const result = await chrome.storage.local.get(domain);
    const existing = result[domain];
    if (!existing) return;

    const cleaned: DomainData = { ...existing };
    delete cleaned.fontSize;
    delete cleaned.lineHeight;
    await chrome.storage.local.set({ [domain]: cleaned });
}
