# Changelog — AirPlay/Miracast Disconnect on Presence

All notable changes to this macro are documented here.

## [0.10] — 2026-03-13

### Fixed
- **Wireless retry loop persists after connection confirmed** — The retry loop that re-subscribes to wireless status nodes after a reboot (introduced in v0.9) continued polling even after the wireless connection was successfully established. v0.10 stops the retry loop once the subscription succeeds and the node reports a valid state.
- **OSD button cleanup** — Removed leftover on-screen display buttons that were no longer needed after the prompt flow was simplified.
- **PeripheralId removed from prompt commands** — `UserInterface.Message.Prompt.Display` no longer includes `PeripheralId` targeting, which caused prompt delivery failures on certain firmware versions when the Navigator ID changed or was unavailable.

### Tested

Validated on the following device configurations before release:

| Device | Mode | RoomOS | Displays | Navigators | Wireless Types |
|--------|------|--------|----------|------------|----------------|
| Codec EQ | Webex | 26 | Dual | Dual | AirPlay, Miracast |
| Codec Plus | Webex | 11 | Single | Single | AirPlay, Miracast |
| Codec Pro | MTR | 26 | Single | Single | Miracast only |

**Success criteria applied:** Room empties, grace period elapses, prompt appears (or share stops if no Navigator), share is terminated, no false positives during active occupancy, no interference with active calls, suppression window honored after user confirmation. See [TESTING.md](TESTING.md) for full testing methodology.

## [0.9] — 2026-03-13

### Fixed
- **Missing xAPI nodes after reboot cause fatal init error** — After a device reboot, some `Video.Input` status nodes (particularly AirPlay and Miracast) may not exist until first use. Prior versions treated the resulting "No match on address expression" error as a fatal initialization failure, preventing the macro from starting. v0.9 catches this specific error, treats the node as "not available yet," and retries the subscription on a timer until the node becomes available.

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
