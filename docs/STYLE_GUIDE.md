# Basecamp Brand Style Guide

**Aesthetic Profile:** 1970s–1990s Technical Manual / VHS Packaging / Japanese Photo Club Poster
**Visual Tone:** Brutalist, Monochromatic, High-Contrast, CRT / Hardware Interface.

The Basecamp design system prioritizes strict layout rules, massive typography, intense interactivity, and a retro hardware feel over modern "soft" UI paradigms.

---

## 1. Color Palette

The app runs on a strict, local-first, high-contrast dark palette.

- **Void Black (Background):** `#000000`
- **Aged Eggshell / Cream (Primary Text & Borders):** `#f0ead6` (Replaces harsh pure white for a warmer, aged print feel)
- **Terminal Grey (Muted Text/Metadata):** `#9c9a90`
- **Safety Orange (Accent):** `#ff4500` (Used sparingly for high-visibility alerts, massive drop shadows, or active states)

## 2. Typography

**Font Family:** `Geist Pixel` (or a highly legible, uniform monospace equivalent).

- **Scale:** Typographic hierarchy relies exclusively on **size contrast**, never weight contrast.
- **Titles (H1/H2):** Extremely massive (up to `7rem` / `112px`). Line-height is squeezed extremely tight (`0.8` to `0.85`) so the boxy letters stack heavily.
- **Metadata/Labels:** Tiny (`0.75rem` / `12px`). Always **UPPERCASE** (`text-transform: uppercase;`). Wide letter-spacing (`0.05em` to `0.08em`) to mimic stamped hardware serial numbers.
- **Alignment:** Strictly **Left-Aligned**.
- **Sentence Case:** Used only for long-form prompt content and conversation logs. Everything structural (labels, buttons, headers) is uppercase.

## 3. Structural Primitives (The Grid & Cards)

- **Hard Grid Rhythm:** Spacing scales follow a rigid `8px` baseline grid. Generous negative space acts as the primary grouping mechanism inside panels.
- **Aggressive Borders:** All borders (panels, inputs, buttons, header strips) are thick: strictly **`3px solid`**.
- **The "Pixel Chamfer" Corners:**
  - Standard `border-radius` is entirely forbidden (`border-radius: 0 !important;`).
  - To achieve rounded hardware edges while maintaining the pixelated aesthetic, elements use a CSS `clip-path` hack to slice exactly `6px` off every corner. This emulates a chunky, 1-pixel diagonal chamfer scaled up by 300%.
  - *Implementation Guide:*

    ```css
    clip-path: polygon(
      6px 0, calc(100% - 6px) 0, 
      100% 6px, 100% calc(100% - 6px), 
      calc(100% - 6px) 100%, 6px 100%, 
      0 calc(100% - 6px), 0 6px
    );
    ```

## 4. Interactive Elements (Switches, not Buttons)

- **Instant Feedback:** `transition: all 0s;` (No fading or soft transitions anywhere).
- **Aggressive Hover States:** Hovering over an interactive card or button triggers a 100% stark inversion. A black button with an eggshell border snaps into a solid eggshell block with black text.
- **Focus States:** High visibility outlines, such as thick `outline` strokes or `inset` box-shadows in the Safety Orange (`var(--accent)`).
- **Hard Drop Shadows:**
  - Never use blur radiuses or CSS shadows that look soft.
  - Drop shadows should be offset blocks of solid color (`16px 16px 0 var(--accent)`).
  - *Crucial Rule:* Because the UI uses `clip-path` for the pixel corners, traditional `box-shadow` will bleed past the cut corners. Always use `filter: drop-shadow(...)` on parent wrappers so the retro shadow intelligently mirrors the chopped edges.

## 5. Background Textures (CRT & Drafting Paper)

- **The Drafting Grid:** A fixed pseudo-element layer sitting behind the content. It draws an `8px` by `8px` graph-paper grid using extremely faint (`0.08` opacity) white lines.
- **CRT Scanlines:** A fixed overlay applying thick horizontal scanlines across the entire viewport above the content. This is generated via a linear gradient that alternates transparent and `0.25` opacity black rows every `4px`, imparting a heavy, physical monitor footprint.
