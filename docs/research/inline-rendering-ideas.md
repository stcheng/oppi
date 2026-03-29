# Inline Rendering — Remaining Ideas

## Export Pipeline Consistency Audit
The `synchronousRendering` flag fixes mermaid but three other async paths are inconsistent:

| Component | Live Mode | Export Mode | Status |
|---|---|---|---|
| Mermaid diagrams | async Task.detached | sync via applyAsDiagramSync | FIXED |
| Syntax highlighting | async Task.detached (scheduleHighlight) | still async — exports unhighlighted | TODO |
| Online images (URL) | async URLSession | still async — exports as spinner | TODO |
| Workspace images | async fetchWorkspaceFile | no fetch closure passed — broken | TODO |

### Fix plan
- **Syntax highlighting**: when `synchronousRendering`, call `SyntaxHighlighter.highlight()` inline on the current thread in the applier instead of `scheduleHighlight()`
- **Images**: make `renderMarkdownToImage` async. Before snapshotting, await all image load tasks. Or: pre-download images before creating the view.
- **Workspace images**: pass `fetchWorkspaceFile` closure to the export config

## Table Export (needs research)
- Research agent investigating Google Docs, Word, Pages, Notion, Obsidian, GitHub
- Key question: wrap text, scale down, clip, or landscape?
- See `table-export-behavior.md` for findings
- Implementation: likely add export mode to `NativeTableBlockView` similar to `synchronousRendering` for mermaid

## Privacy Mitigations for Online Images
- Currently auto-loads all HTTPS URLs (tracking pixels, IP leaks)
- Options: tap-to-load placeholder, domain allowlist, size cap on URLSession responses
- Low priority — HTTPS-only via ATS already limits exposure

## Relative Image Support in File Viewers
- `MarkdownFileView` and `NativeFullScreenMarkdownBody` create `Configuration` without `workspaceID`/`serverBaseURL`
- Absolute URLs work, but relative workspace paths won't resolve
- Need to thread workspace context through to these viewers

## Inline Mermaid — Future Polish
- Consider inline pinch-to-zoom (removed for gesture conflict simplicity)
- Could add back with a UIControl-based approach instead of UIScrollView
- Low priority since fullscreen viewer provides zoom
