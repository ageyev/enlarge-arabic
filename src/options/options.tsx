/**
 * [Enlarge Arabic] — Options Page
 *
 * Global settings for Arabic text enlargement:
 *   - Font size (em) — controls relative size of Arabic text
 *   - Line height (unitless) — controls vertical spacing
 *   - Live preview on a sample mixed Arabic/Latin text
 *
 * Persistence model:
 *   Save   → writes { fontSize, lineHeight } to chrome.storage.local
 *   Reset  → deletes the key entirely (content scripts fall back to CSS defaults)
 *
 * Active content scripts detect changes via chrome.storage.onChanged
 * and update CSS custom properties immediately — no tab messaging needed.
 */

import React, {useCallback, useEffect, useState} from "react";
import {createRoot} from "react-dom/client";

import Slider from "../shared/Slider";

import {
    DEFAULT_FONT_SIZE,
    DEFAULT_LINE_HEIGHT,
    FONT_SIZE_MAX,
    FONT_SIZE_MIN,
    GLOBAL_SETTINGS_KEY,
    type GlobalSettings,
    LINE_HEIGHT_MAX,
    LINE_HEIGHT_MIN,
    SLIDER_STEP,
} from "../shared/constants";

// ── Local constants ────────────────────────────────────────────────────────────

/** Duration (ms) for the "Saved ✓" / "Reset ✓" feedback on buttons. */
const FEEDBACK_DURATION_MS = 2000;

// ── Components ─────────────────────────────────────────────────────────────────

/**
 * Live preview showing mixed Arabic/Latin text at current settings.
 * Arabic spans are enlarged via CSS custom properties scoped to this panel,
 * so the user sees the exact effect before saving.
 *
 * Three sample paragraphs cover the main use cases:
 *   1. Inline Arabic in English prose
 *   2. Short Arabic terms alongside translations
 *   3. Fully vowelized (tashkeel) text — the hardest rendering case
 */
function Preview({ fontSize, lineHeight }: GlobalSettings) {
    const previewStyle = {
        "--preview-font-size": `${fontSize}em`,
        "--preview-line-height": lineHeight,
    } as React.CSSProperties;

    return (
        <div className="settings-card">
            <h2>Preview</h2>
            <div className="preview-text" style={previewStyle}>
                <p>
                    This is regular English text mixed with{" "}
                    <span className="arabic-preview">
                        بِسْمِ ٱللَّهِ ٱلرَّحْمَـٰنِ ٱلرَّحِيمِ
                    </span>
                    {" "}to show the enlargement effect at <strong>{fontSize}em</strong>.
                </p>
                <p>
                    A Wikipedia article about{" "}
                    <span className="arabic-preview">القُدْس</span>{" "}
                    (Jerusalem) contains both{" "}
                    <span className="arabic-preview">العربية</span>{" "}
                    and English text side by side.
                </p>
                <p>
                    Diacritics test:{" "}
                    <span className="arabic-preview">
                        كِتَابٌ مُفِيدٌ فِي تَعَلُّمِ اللُّغَةِ
                    </span>
                    {" "}— fully vowelized text is the hardest case.
                </p>
            </div>
        </div>
    );
}

// ── Main ───────────────────────────────────────────────────────────────────────

type ButtonFeedback = "idle" | "in-progress" | "done";

function OptionsPage() {

    const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE);
    const [lineHeight, setLineHeight] = useState(DEFAULT_LINE_HEIGHT);
    const [saveFeedback, setSaveFeedback] = useState<ButtonFeedback>("idle");
    const [resetFeedback, setResetFeedback] = useState<ButtonFeedback>("idle");

    // Load persisted settings on mount.
    // If no settings are stored (first run, or after reset), defaults from
    // useState initialization remain — matching the CSS fallback values.
    useEffect(() => {
        async function loadSettings(): Promise<void> {
            const result = await chrome.storage.local.get(GLOBAL_SETTINGS_KEY);
            const stored = result[GLOBAL_SETTINGS_KEY] as GlobalSettings | undefined;
            if (stored) {
                setFontSize(stored.fontSize);
                setLineHeight(stored.lineHeight);
            }
        }
        loadSettings();
    }, []);

    // Save: persist current slider values to storage.
    const handleSave = useCallback(async () => {
        setSaveFeedback("in-progress");

        const settings: GlobalSettings = { fontSize, lineHeight };
        await chrome.storage.local.set({ [GLOBAL_SETTINGS_KEY]: settings });

        setSaveFeedback("done");
        setTimeout(() => setSaveFeedback("idle"), FEEDBACK_DURATION_MS);
    }, [fontSize, lineHeight]);

    // Reset: delete stored settings and return sliders to built-in defaults.
    // This is a complete action — no separate Save needed after Reset.
    const handleReset = useCallback(async () => {
        setResetFeedback("in-progress");

        setFontSize(DEFAULT_FONT_SIZE);
        setLineHeight(DEFAULT_LINE_HEIGHT);
        await chrome.storage.local.remove(GLOBAL_SETTINGS_KEY);

        setResetFeedback("done");
        setTimeout(() => setResetFeedback("idle"), FEEDBACK_DURATION_MS);
    }, []);

    const saveLabel =
        saveFeedback === "in-progress" ? "Saving…" :
            saveFeedback === "done"        ? "Saved ✓" :
                "Save";

    const resetLabel =
        resetFeedback === "in-progress" ? "Resetting…" :
            resetFeedback === "done"        ? "Reset ✓" :
                "Reset to defaults";

    const isAnyActionInProgress =
        saveFeedback === "in-progress" || resetFeedback === "in-progress";

    return (
        <>
            <h1>[Enlarge Arabic] — General Settings</h1>

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

            <Preview fontSize={fontSize} lineHeight={lineHeight} />

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
        </>
    );
}

// ── Mount ──────────────────────────────────────────────────────────────────────

const rootElement = document.getElementById("root");

if (rootElement) {
    createRoot(rootElement).render(<OptionsPage />);
} else {
    console.error("[Enlarge Arabic] Options: #root element not found");
}