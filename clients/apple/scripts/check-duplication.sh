#!/bin/bash
# Mechanical enforcement of shared component usage.
# Run as part of build verification. Fails with clear fix instructions.
set -uo pipefail

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
ALLOWED='FullScreenCodeView\.swift\|FullScreenCodeViewController\.swift\|EmbeddedFileViewerView\.swift\|ToolTimelineRowHelpers\.swift'
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

# 6. ChatInputBar / ExpandedComposerView must not share >5 private func names
SHARED=$(comm -12 \
  <(rg 'private func (\w+)' -o Oppi/Features/Chat/Composer/ChatInputBar.swift 2>/dev/null | sed 's/private func //' | sort -u) \
  <(rg 'private func (\w+)' -o Oppi/Features/Chat/Composer/ExpandedComposerView.swift 2>/dev/null | sed 's/private func //' | sort -u) | wc -l | tr -d ' ')
if [ "$SHARED" -gt 5 ]; then
  err "ChatInputBar and ExpandedComposerView share $SHARED private funcs" \
      "Extract shared logic to a ComposerShared module"
fi

# 7. AskCard / AskCardExpanded must not share >3 private func names
SHARED=$(comm -12 \
  <(rg 'private func (\w+)' -o Oppi/Features/Chat/Composer/AskCard.swift 2>/dev/null | sed 's/private func //' | sort -u) \
  <(rg 'private func (\w+)' -o Oppi/Features/Chat/Composer/AskCardExpanded.swift 2>/dev/null | sed 's/private func //' | sort -u) | wc -l | tr -d ' ')
if [ "$SHARED" -gt 3 ]; then
  err "AskCard and AskCardExpanded share $SHARED private funcs" \
      "Extract shared AskQuestion logic to AskCardShared"
fi

# 8. elapsedMs(ContinuousClock) must exist in at most 1 file
HITS=$(rg -l 'elapsed\.components\.attoseconds' --type swift Oppi/ 2>/dev/null | wc -l | tr -d ' ')
if [ "$HITS" -gt 1 ]; then
  err "elapsedMs(ContinuousClock) duplicated in $HITS files" \
      "Extract to a shared ContinuousClock extension"
fi

# 9. formatTokens must exist in at most 1 file
HITS=$(rg -l 'private func formatTokens' --type swift Oppi/ 2>/dev/null | wc -l | tr -d ' ')
if [ "$HITS" -gt 1 ]; then
  err "formatTokens duplicated in $HITS files" \
      "Extract to a shared formatting extension"
fi

# 10. Git statusColor mapping must exist in at most 1 file
HITS=$(rg -l 'private var statusColor: Color' --type swift Oppi/Features/Review/ 2>/dev/null | wc -l | tr -d ' ')
if [ "$HITS" -gt 1 ]; then
  err "Git statusColor duplicated in $HITS Review files" \
      "Extract to GitStatusColor.color(for:)"
fi

# 11. nowMs must exist in at most 2 files
HITS=$(rg -l 'func nowMs' --type swift Oppi/ 2>/dev/null | wc -l | tr -d ' ')
if [ "$HITS" -gt 2 ]; then
  err "nowMs() duplicated in $HITS files" \
      "Use a single shared static func"
fi

# 12. No plain WKWebView instantiation — use PiWKWebView for pi quick actions
# Matches " WKWebView(" but not "PiWKWebView(" via negative lookbehind.
ALLOWED_WK='PiWKWebView\.swift\|HTMLContentTracker\|PDFFileView\.swift'
HITS=$(rg --pcre2 -l '(?<!Pi)WKWebView\(frame:' --type swift Oppi/ \
  | grep -v "$ALLOWED_WK" || true)
if [ -n "$HITS" ]; then
  err "Plain WKWebView instantiation in: $HITS" \
      "Use PiWKWebView so pi quick actions appear on text selection"
fi

# 13. EmbeddedFileViewerView callers should not need explicit piRouter
#     (environment fallback handles it) — warn if new callers add custom
#     routers identical to the default quick-session pattern.
#     This is informational; not blocking.

if [ $ERRORS -gt 0 ]; then
  echo "=== $ERRORS duplication violation(s) found ==="
  exit 1
fi
echo "No duplication violations found."
