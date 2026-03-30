import Foundation

/// Host extension metadata from `GET /extensions`.
///
/// The server returns global extensions and, when a workspace host directory is known,
/// project-local `.pi/extensions` entries for that directory.
struct ExtensionInfo: Codable, Identifiable, Sendable, Equatable {
    let name: String
    let path: String
    let kind: String    // "file" | "directory"

    var id: String { name }

    var locationLabel: String {
        path.contains("/.pi/extensions/") ? ".pi/extensions" : "~/.pi/agent/extensions"
    }

    var subtitle: String {
        "\(locationLabel) · \(kind)"
    }
}
