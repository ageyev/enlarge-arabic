// ── Dev or Production mode  ──────────────────────────────────────────────────────

export const devMode = true; // TODO: change in production
// export const devMode: boolean = false;

// ── Icons ───────────────────────────────────────────────────────────────────────
export const enabledIcon: string = "images/ain_enabled_teal_16.png";
export const disabledIcon: string = "images/ain_disabled_grey_16.png";


// ── Storage keys ───────────────────────────────────────────────────────────────
/**
 * Reserved storage key for global enlargement settings.
 * Double-underscore prefix guarantees no collision with domain hostnames
 * (hostnames cannot begin with underscores per RFC 952 / RFC 1123).
 */
export const GLOBAL_SETTINGS_KEY = "__global_settings__";

// ── Default values ─────────────────────────────────────────────────────────────

/**
 * IMPORTANT — DEFAULT VALUES SYNC:
 * The default values below must match the CSS fallback values
 * declared in public/content.css:
 *
 *   .arabic-enlarged {
 *       font-size:   var(--arabic-enlarger-size,   1.4em);
 *       line-height: var(--arabic-enlarger-height,  1.6);
 *   }
 *
 * If you change the defaults here, update content.css fallbacks to match.
 * If you change the content.css fallbacks, update the defaults here to match.
 */

export const DEFAULT_FONT_SIZE = "1.40";
export const DEFAULT_LINE_HEIGHT = "1.60";

// ── Slider configuration ───────────────────────────────────────────────────────

export const FONT_SIZE_MIN = 1.1;
export const FONT_SIZE_MAX = 2.0;
export const LINE_HEIGHT_MIN = 1.0;
export const LINE_HEIGHT_MAX = 2.5;
export const SLIDER_STEP = 0.05;

// ── Types ──────────────────────────────────────────────────────────────────────

export interface GlobalSettings {
    fontSize: string;   // em value as string, e.g. "1.40"
    lineHeight: string; // unitless value as string, e.g. "1.60"
}

