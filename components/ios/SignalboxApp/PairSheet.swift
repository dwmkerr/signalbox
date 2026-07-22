import SwiftUI

// The scan affordance for the main screens. Both Board and Remote put this in
// the top-right of their nav bar so pairing a hub is a first-class action, not
// something buried in Settings. It opens the shared PairSheet, which routes any
// scan back through the app's one confirmation gate.
struct ScanToolbarButton: ToolbarContent {
    let action: () -> Void

    var body: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Button(action: action) {
                Image(systemName: "qrcode.viewfinder")
                    .font(.system(size: 17, weight: .semibold))
            }
            .tint(Theme.blue)
            .accessibilityLabel("Pair with a code")
        }
    }
}

// What the "Pair with a code" button opens. When the camera is available this
// shows the live scanner; the scanned signalbox:// string is opened through the
// app's own URL handler so it lands in the exact same confirmation gate a
// tapped link does - there is only ever one place that decides to pair.
//
// The simulator has no camera, and a real device can refuse it, so the scanner
// is never the only way in: this always offers the instructions for pairing by
// the Camera app or the tappable link instead.
struct PairSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if PairScannerView.isSupported {
                    PairScannerView { scanned in
                        // Close first, then hand the string to the app's URL
                        // handler: routing through openURL means the scanner
                        // shares the one confirmation gate rather than pairing
                        // on its own.
                        dismiss()
                        openURL(scanned)
                    }
                    .ignoresSafeArea(edges: .bottom)
                } else {
                    instructions
                }
            }
            .navigationTitle("Pair with a code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .background(Theme.bg)
        }
    }

    private var instructions: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Run `signalbox pair` on your computer.")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Theme.text)
            Text("""
            It prints a QR code. Scan it with your Camera app, or open the \
            signalbox:// link it shows, and this app will ask you to confirm \
            before pairing.
            """)
                .font(.system(size: 13))
                .foregroundStyle(Theme.faint)
            Text("""
            The phone and the computer must be on the same Wi-Fi. Pairing sends \
            the one-time code to the hub, which returns the token this device \
            then keeps in its Keychain.
            """)
                .font(.system(size: 13))
                .foregroundStyle(Theme.faint)
            Spacer()
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
