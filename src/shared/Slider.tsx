// ── Utility ────────────────────────────────────────────────────────────────────

import React from "react";

/**
 * Normalize a slider value to exactly two decimal places.
 * Prevents floating-point drift from repeated step additions
 * (e.g. 1.1 + 0.05 + 0.05 could produce 1.2000000000000002).
 */
function normalizeSliderValue(raw: string): string {
    return parseFloat(raw).toFixed(2);
}

interface SliderProps {
    label: string;
    value: string;
    unit?: string;
    min: number;
    max: number;
    step: number;
    onChange: (value: string) => void;
}


/**
 * Labeled range slider displaying its current value.
 * Designed for extraction to src/shared/components/ when sidepanel is built.
 */
function Slider({ label, value, unit = "", min, max, step, onChange }: SliderProps) {

    const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        onChange(normalizeSliderValue(event.target.value));
    };

    return (
        <div className="slider-group">
            <div className="slider-label">
                <span>{label}</span>
                <span className="slider-value">{value}{unit}</span>
            </div>
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={handleChange}
            />
        </div>
    );
}

export default Slider;