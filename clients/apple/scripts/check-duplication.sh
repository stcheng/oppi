#!/bin/bash
# Mechanical enforcement of shared component usage.
# Run as part of build verification. Fails with clear fix instructions.
set -euo pipefail

cd "$(dirname "$0")/.."
ERRORS=0

err() { echo "ERROR: $1"; echo "  FIX: $2"; echo; ERRORS=$((ERRORS + 1)); }

# 1. No raw UIActivityViewController outside FileSharePresenter
HITS=$(rg -l 'UIActivityViewController\(' --type swift Oppi/ \
  | grep -v 'FileSharePresenter\.swift' \
  | grep -v 'FileShareService\.swift' \
  | grep -v 'AssistantMarkdownContentView\.swift' || true)
if [ -n "$HITS" ]; then
  err "Raw UIActivityViewController found in: $HITS" \
      "Use FileSharePresenter.share() or .makeShareBarButtonItem()"
fi

# 2. No raw .sheet + FullScreenCodeView outside the modifier definition
HITS=$(rg -l '\.sheet.*FullScreenCodeView\|FullScreenCodeView.*\.sheet' --type swift Oppi/ \
  | grep -v 'FullScreenCodeView\.swift' || true)
if [ -n "$HITS" ]; then
  err "Raw .sheet + FullScreenCodeView in: $HITS" \
      "Use .fullScreenViewer(isPresented:content:piRouter:) modifier"
fi

# 3. No direct FullScreenCodeViewController creation outside allowed files
ALLOWED='FullScreenCodeView\.swift\|EmbeddedFileViewerView\.swift\|ToolTimelineRowHelpers\.swift'
HITS=$(rg -l 'FullScreenCodeViewController\(' --type swift Oppi/ \
  | grep -v "$ALLOWED" || true)
if [ -n "$HITS" ]; then
  err "Direct FullScreenCodeViewController creation in: $HITS" \
      "Use .fullScreenViewer() (SwiftUI) or ToolTimelineRowPresentationHelpers.presentFullScreenContent() (UIKit)"
fi

# 4. No presentationDetents([.large]) outside allowed files (sign of manual sheet setup)
HITS=$(rg -l 'presentationDetents\(\[\.large\]\)' --type swift Oppi/ \
  | grep -v 'FullScreenCodeView\.swift' || true)
if [ -n "$HITS" ]; then
  err "Manual .presentationDetents([.large]) in: $HITS" \
      "Use .fullScreenViewer() modifier — it handles sheet configuration"
fi

# 5. Renderable file views must use RenderableDocumentWrapper
for VIEW in MarkdownFileView LaTeXFileView MermaidFileView OrgModeFileView HTMLFileView; do
  FILE=$(find Oppi -name "${VIEW}.swift" -type f 2>/dev/null | head -1)
  if [ -n "$FILE" ]; then
    if ! rg -q 'RenderableDocumentWrapper' "$FILE"; then
      err "$VIEW does not use RenderableDocumentWrapper" \
          "Renderable file views must use RenderableDocumentWrapper for shared chrome"
    fi
  fi
done

if [ $ERRORS -gt 0 ]; then
  echo "=== $ERRORS duplication violation(s) found ==="
  exit 1
fi
echo "No duplication violations found."
