# AirPlay/Miracast Disconnect on Presence

Cisco RoomOS macro that automatically disconnects wireless sharing (AirPlay and Miracast) when a conference room becomes unoccupied. Designed for enterprise deployments where abandoned wireless shares tie up room displays and create confusion for the next occupant.

**Author:** Logan Evans ([@loganevans](mailto:loganevans@asei.com))

## Problem

Users walk out of conference rooms and leave their AirPlay or Miracast session connected. The next person walks in, sees someone else's screen, and either waits awkwardly or calls IT. At scale across hundreds of rooms, this is a constant source of friction and helpdesk tickets.

## How It Works

1. Monitors RoomAnalytics occupancy signals (PeoplePresence and/or PeopleCount)
2. When the room has been unoccupied for a configurable grace period and a wireless share is still active, displays an on-screen prompt: *"Room appears empty. Stop wireless sharing?"*
3. If someone is still there, they tap "I'm still here" and a suppression window prevents re-prompting for 15 minutes
4. If no one responds within the prompt timeout, the share is stopped automatically
5. Never interrupts an active call

## Features

- **Dual occupancy signals** — Use PeoplePresence, PeopleCount, or both ("Either" mode) to detect empty rooms
- **User prompt before disconnect** — OSD alert with Room Navigator support; never silently kills a share while someone is presenting
- **Call guardrail** — Takes no action while `SystemUnit.State.System` is `InCall`
- **Suppression window** — After a user confirms presence, backs off for a configurable period
- **Wireless-specific detection** — Subscribes to `Video.Input.AirPlay.Activity` and `Video.Input.Miracast.Status/Transport` to only act when wireless sharing is actually active
- **Navigator targeting** — Can send prompts to a specific Room Navigator by PeripheralId
- **MTR compatible** — Works on devices running Microsoft Teams Rooms mode

## Configuration

All settings are in the `SETTINGS` object at the top of the macro file:

| Setting | Default | Description |
|---------|---------|-------------|
| `occupancyBasis` | `'Either'` | Which signal drives behavior: `'Presence'`, `'Count'`, or `'Either'` |
| `treatPresenceUnknownAsOccupied` | `true` | Safety default when presence sensor reports Unknown |
| `promptTimeoutSeconds` | `30` | How long to wait for a response before stopping the share |
| `suppressAfterStayMinutes` | `15` | Cooldown after user confirms they're still present |
| `emptyGraceSeconds` | `60` | How long to wait after room empties before prompting |
| `navigatorPeripheralId` | `''` | Target a specific Navigator (empty = all displays) |

## Requirements

- RoomOS 11.x or later (Room Kit, Room Bar, Board, Desk series)
- `xConfiguration RoomAnalytics PeoplePresenceDetector: On`
- `xConfiguration RoomAnalytics PeopleCountOutOfCall: On`

## Installation

### Via Webex Control Hub
Upload `AirplayMiracastDisconnectOnPresence-v-0-8.js` through **Devices > [device] > Macros** in Control Hub.

### Via xAPI
```
xCommand Macros Macro Save Name: "ShareAutoDisconnect" Overwrite: True Transpile: True
<macro source code>
.
xCommand Macros Macro Activate Name: "ShareAutoDisconnect"
xCommand Macros Runtime Restart
```

## Version History

See [CHANGELOG.md](CHANGELOG.md) for detailed release notes.

| Version | Date | Author |
|---------|------|--------|
| 0.8 | 2026-03-12 | Doug Schaefer (with Claude Code) |
| 0.7 | 2026-03-12 | Logan Evans (with GitHub Copilot) |

## License

MIT
