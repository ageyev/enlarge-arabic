## v1.0.1 — Fix: contenteditable interference

Fixed a bug where the MutationObserver would wrap Arabic text inside rich text editors (Claude, ChatGPT, Grok, Gemini, and any other editor using `contenteditable`), causing cursor positioning issues and interfering with typing.

**Root cause:** The observer-path contenteditable check only examined the immediate parent of a mutated text node. In rich text editors, the text node sits inside a `<p>` (or similar) nested within the `contenteditable` container — the immediate parent has no `contenteditable` attribute, so the check passed and Arabic text was wrapped inside live editors.

**Fix:** Replaced the immediate-parent check with `closest('[contenteditable="true"]')` to walk the full ancestor chain. Applied to both Element and Text branches of `processAddedNode()`.

The initial full-page scan (`enlargeArabicText()`) was not affected — its TreeWalker starts at `document.body` and correctly rejects `contenteditable` subtrees from above. Only the MutationObserver pathway was vulnerable. 
