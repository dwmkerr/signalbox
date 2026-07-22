import SwiftUI
import VisionKit

// A thin wrapper over VisionKit's live QR scanner. It only ever hands back a
// string; every decision about whether that string is a valid pairing link, and
// whether to act on it, stays in PairLink and the one confirmation gate. The
// camera cannot run in the simulator, so this is convenience for a real device -
// the signalbox:// deep link is the load-bearing path and is tested on its own.
struct PairScannerView: UIViewControllerRepresentable {
    // True only where a real camera can drive the scanner. The simulator
    // reports false, which is what makes PairSheet fall back to instructions.
    static var isSupported: Bool {
        DataScannerViewController.isSupported && DataScannerViewController.isAvailable
    }

    // Called with the first scanned QR payload that parses as a pairing link.
    let onScan: (URL) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            isHighFrameRateTrackingEnabled: false,
            isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
        try? scanner.startScanning()
    }

    static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator: Coordinator) {
        scanner.stopScanning()
    }

    func makeCoordinator() -> Coordinator { Coordinator(onScan: onScan) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        private let onScan: (URL) -> Void
        // A live scanner fires repeatedly for the same code in frame; pair once.
        private var handled = false

        init(onScan: @escaping (URL) -> Void) { self.onScan = onScan }

        func dataScanner(_ scanner: DataScannerViewController, didTapOn item: RecognizedItem) {
            handle(item)
        }

        func dataScanner(
            _ scanner: DataScannerViewController,
            didAdd addedItems: [RecognizedItem],
            allItems: [RecognizedItem]
        ) {
            for item in addedItems { handle(item) }
        }

        private func handle(_ item: RecognizedItem) {
            guard !handled, case let .barcode(barcode) = item,
                  let text = barcode.payloadStringValue,
                  let url = URL(string: text), PairLink(url) != nil else { return }
            handled = true
            onScan(url)
        }
    }
}
