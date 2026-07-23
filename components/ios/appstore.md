# App Store Connect - copy for Signalbox iOS

Suggested content for the App Store Connect forms (TestFlight Test
Information, Beta App Review, and later the App Store listing). Keep this
file current when the copy in App Store Connect changes.

## TestFlight - Test Information

**Beta App Description** (4000 chars max):

> Signalbox is a local-first events board for AI coding agents - one board
> for every agent, terminal, and job you run on your machines.
>
> The iOS app is a companion to the Signalbox hub that runs on your Mac
> (installed via Homebrew: `brew install dwmkerr/signalbox/signalbox`). It
> shows your live session board - which agents are working, which are
> waiting on you, and what they said last - and lets you acknowledge,
> pin, hide, and jump to sessions from your phone.
>
> To test: install the hub on a Mac, enable Connect Phone from the menu
> bar app, and scan the pairing QR with this app. The phone connects to
> your hub over your local network - no account, no cloud service, your
> data stays on your machines.
>
> Docs: https://dwmkerr.github.io/signalbox/

**Feedback Email**: `dwmkerr@gmail.com`

## Contact Information

- **First Name**: Dave
- **Last Name**: Kerr
- **Phone**: (Dave's number - not stored in the repo)
- **Email**: `dwmkerr@gmail.com`

## Sign-In Information

**Uncheck "Sign-in required".** The app has no accounts and no sign-in:
it pairs with the user's own hub by scanning a QR code shown on their
Mac. There is no username/password to hand to review.

## Beta App Review notes (when prompted)

> Signalbox has no user accounts. The app is a companion to a hub the
> user runs on their own Mac; the phone pairs by scanning a QR code from
> the Mac's menu bar app and talks to the hub over the local network
> only. Without a paired hub the app shows an empty board and the
> pairing flow - this is the expected first-run state. There is no
> server-side component operated by us and no data leaves the user's
> devices.

## App Store listing (later - not yet submitted)

- **Name**: Signalbox
- **Subtitle** (30 chars): Events board for AI agents
- **Category**: Developer Tools
- **Privacy**: no data collected - the app talks only to the user's own
  hub on their local network. Privacy manifest: `SignalboxApp/PrivacyInfo.xcprivacy`.
- **Support URL**: https://github.com/dwmkerr/signalbox/issues
- **Marketing URL**: https://dwmkerr.github.io/signalbox/
- App Review will need a demo path (the app is empty without a hub) -
  tracked as a launch blocker; likely a demo/sample-board mode.
