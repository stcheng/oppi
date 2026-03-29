import SwiftUI

/// Game of Life-style grid forming a rough π, unique per session.
/// Used as the empty chat placeholder. Subtle, non-intrusive.
struct SessionGridView: View {
    let sessionId: String

    var body: some View {
        let palette = ThemeRuntimeState.currentPalette()
        Canvas { context, size in
            let grid = SessionGridRenderer.gridSize
            let cellTotal = size.width / CGFloat(grid)
            let gap = cellTotal * 0.13
            let cellSize = cellTotal - gap
            let cornerRadius = cellSize * 0.24

            let cells = SessionGridRenderer.generateCells(sessionId: sessionId)

            for cell in cells {
                let x = CGFloat(cell.col) * cellTotal + gap / 2
                let y = CGFloat(cell.row) * cellTotal + gap / 2
                let rect = CGRect(x: x, y: y, width: cellSize, height: cellSize)
                let path = Path(roundedRect: rect, cornerRadius: cornerRadius)

                let color: Color
                switch cell.role {
                case .spark:
                    color = palette.orange.opacity(0.90)
                case .almostSpark:
                    color = palette.orange.opacity(0.30)
                case .piCore, .piEdge, .piExposed, .growth, .scatter:
                    color = palette.fg.opacity(Double(cell.opacity))
                }

                context.fill(path, with: .color(color))
            }
        }
        .frame(width: 80, height: 80)
        .allowsHitTesting(false)
    }
}
