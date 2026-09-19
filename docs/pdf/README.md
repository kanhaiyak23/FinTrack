# Rebuilding the PDF guide

`docs/FinTrack-Guide.pdf` is generated from `guide.html`. Edit the HTML, never the PDF.

## Requirements

- Google Chrome (used headless as the renderer — no extra dependency to install)
- `pypdf`, only for the bookmark outline, in a throwaway virtualenv

## Build

```bash
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

"$CHROME" --headless --disable-gpu --no-pdf-header-footer --generate-tagged-pdf \
  --print-to-pdf="$PWD/docs/FinTrack-Guide.pdf" "file://$PWD/docs/pdf/guide.html"

uv venv /tmp/pdfvenv && uv pip install --python /tmp/pdfvenv/bin/python pypdf
/tmp/pdfvenv/bin/python docs/pdf/add_bookmarks.py
```

## Why this toolchain

Chrome renders the inline SVG diagrams as **vectors**, so they stay sharp at any zoom, and
it preserves anchor links as PDF link annotations — that is what makes the contents page
clickable. What it does not produce is a bookmark outline, which is why `pypdf` runs
afterwards.

The bookmark script locates each section by a phrase that appears only in that section's
body. An earlier version searched for the section *titles* and pinned all twelve bookmarks
to page 2, because the contents page contains every title.

## Structure

`guide.html` is one self-contained file: styles in a `<style>` block, diagrams as inline
`<svg>`, no external assets and no network fetches at render time.
