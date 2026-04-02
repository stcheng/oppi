import SwiftUI

// MARK: - Icon Grid

/// A grid of SF Symbol icons for picking a server badge icon.
/// No labels — just tappable symbol buttons in a flowing grid.
struct BadgeIconGrid: View {
    @Binding var selection: ServerBadgeIcon
    var tint: Color

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 8), count: 6)

    var body: some View {
        LazyVGrid(columns: columns, spacing: 8) {
            ForEach(ServerBadgeIcon.allCases) { icon in
                let isSelected = icon == selection
                Button {
                    selection = icon
                } label: {
                    Image(systemName: icon.symbolName)
                        .font(.system(size: 18))
                        .symbolRenderingMode(.hierarchical)
                        .foregroundStyle(isSelected ? tint : .themeComment)
                        .frame(width: 40, height: 40)
                        .background(
                            RoundedRectangle(cornerRadius: 8)
                                .fill(isSelected ? tint.opacity(0.18) : Color.clear)
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: 8)
                                .stroke(isSelected ? tint.opacity(0.6) : Color.clear, lineWidth: 1.5)
                        )
                }
                .buttonStyle(.plain)
                .accessibilityLabel(icon.symbolName)
            }
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Color Grid

/// A row of color circles for picking a server badge color.
struct BadgeColorGrid: View {
    @Binding var selection: ServerBadgeColor

    var body: some View {
        HStack(spacing: 10) {
            ForEach(ServerBadgeColor.allCases) { color in
                let isSelected = color == selection
                Button {
                    selection = color
                } label: {
                    Circle()
                        .fill(color.themeColor)
                        .frame(width: 28, height: 28)
                        .overlay(
                            Circle()
                                .stroke(Color.white.opacity(isSelected ? 0.9 : 0), lineWidth: 2)
                                .padding(2)
                        )
                        .overlay(
                            Circle()
                                .stroke(color.themeColor.opacity(isSelected ? 0.8 : 0), lineWidth: 2)
                        )
                        .scaleEffect(isSelected ? 1.15 : 1.0)
                        .animation(.easeInOut(duration: 0.15), value: isSelected)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(color.title)
            }
        }
        .padding(.vertical, 4)
    }
}
