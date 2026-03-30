import PDFKit
import SwiftUI

/// Renders PDF content using PDFKit's native PDFView.
///
/// Accepts base64-encoded PDF data and displays it in an embedded
/// PDFView with continuous vertical scrolling.
struct PDFFileView: View {
    let content: String

    var body: some View {
        if let data = Data(base64Encoded: content),
           let document = PDFDocument(data: data)
        {
            NativePDFView(document: document)
                .frame(minHeight: 300)
        } else {
            ContentUnavailableView(
                "Unable to Display PDF",
                systemImage: "doc.questionmark",
                description: Text("The PDF data could not be decoded.")
            )
        }
    }
}

private struct NativePDFView: UIViewRepresentable {
    let document: PDFDocument

    func makeUIView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.displayMode = .singlePageContinuous
        view.displayDirection = .vertical
        view.backgroundColor = .clear
        view.document = document
        return view
    }

    func updateUIView(_ view: PDFView, context: Context) {
        view.document = document
    }
}
