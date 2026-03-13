# Changelog — AirPlay/Miracast Disconnect on Presence

All notable changes to this macro are documented here.

## [0.8] — 2026-03-12

### Fixed
- **Presentation.Stop API misuse** — Replaced invalid `PresentationSource` string parameters with a blanket `Presentation.Stop()` call. The xAPI only accepts `ConnectorId` (integer) or `PresentationInstance` (integer), not source-type strings. Prior versions silently failed to stop shares on most firmware.
- **Redundant startup evaluations** — Subscription handlers no longer call `evaluate()` during initial state reads. A single `evaluate('startup')` fires after all subscriptions and initial values are loaded.
- **Missing timeouts on wireless status reads** — Added 3-second `withTimeout` to `AirPlay.Activity.get()`, `Miracast.Status.get()`, and `Miracast.Transport.get()` initial reads, matching the existing timeout on occupancy reads.

### Changed
- Log prefix updated from `[ShareAutoDisconnect]` (no change in prefix, just noting the version bump in log output).
- Suppression end timer calculation simplified — uses `seconds * 1000` directly instead of recalculating from `suppressUntilMs`.

## [0.7] — 2026-03-12

### Added
- User prompt on OSD and Room Navigator before disconnecting, with "I'm still here" and "Stop sharing" options.
- In-call guardrail — macro takes no action while `SystemUnit.State.System` is `InCall`.
- Wireless-specific detection via `Video.Input.AirPlay.Activity` and `Video.Input.Miracast.Status/Transport` subscriptions.
- 15-minute suppression window after user confirms presence.
- Configurable `occupancyBasis` setting (Presence, Count, or Either).
- `treatPresenceUnknownAsOccupied` safety default.
- State snapshot logging for debugging.
- Navigator PeripheralId targeting with fallback.

### Changed
- Architecture rewrite: introduced `SETTINGS` and `STATE` objects, named timer management, and modular subscription functions.
