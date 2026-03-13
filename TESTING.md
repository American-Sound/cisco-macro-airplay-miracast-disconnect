# Testing — AirPlay/Miracast Disconnect on Presence

All releases committed to this repository have been fully tested in either a production environment or the ASEI lab before publication.

## Testing Methodology

Each release undergoes validation in two stages:

**Lab validation** is performed in the ASEI integration lab on representative hardware before any production deployment. Lab testing covers the full macro lifecycle: installation, configuration changes, occupancy simulation, prompt behavior, share termination, suppression windows, and call guardrails. Lab devices are reset to factory defaults between test runs to ensure no residual state influences results.

**Production validation** is performed on live client endpoints after lab testing passes. Production testing confirms that the macro behaves correctly under real-world conditions — actual occupancy sensor behavior (not simulated), real AirPlay/Miracast connections from user devices, and interaction with other active macros on the same endpoint. Production tests are run during off-hours or in designated test rooms to avoid disrupting client operations.

## Device Matrix

The following devices have been used to validate releases:

| Device | Mode | RoomOS Version | Display Config | Navigators | Wireless Types | Release Validated |
|--------|------|----------------|----------------|------------|----------------|-------------------|
| Codec EQ | Webex | 26 | Dual display | Dual Navigator | AirPlay, Miracast | v0.10 |
| Codec Plus | Webex | 11 | Single display | Single Navigator | AirPlay, Miracast | v0.10 |
| Codec Pro | MTR | 26 | Single display | Single Navigator | Miracast only | v0.10 |

The device matrix is expanded as new hardware configurations are encountered in client deployments.

## Success Criteria

A release passes testing when all of the following conditions are met:

1. **Macro starts cleanly** — No errors in the macro console log on initial activation or after a device reboot. For v0.9+, the retry loop for missing xAPI nodes must resolve without manual intervention.

2. **Occupancy detection is accurate** — The macro correctly identifies the room as empty when all occupants leave and as occupied when at least one person is present. This is validated against both PeoplePresence and PeopleCount signals independently, and in "Either" mode.

3. **Grace period is honored** — After the room empties, the macro waits the configured `emptyGraceSeconds` before taking any action. Early triggers are a test failure.

4. **Prompt appears correctly** — When a wireless share is active and the room has been empty past the grace period, the prompt appears on the OSD (and on a connected Navigator if present). The prompt must include both response options and must auto-dismiss after `promptTimeoutSeconds`.

5. **Share is terminated on timeout** — If no one responds to the prompt within the timeout, the active wireless share is stopped. Verified by confirming the AirPlay/Miracast session is no longer active on both the codec and the source device.

6. **User confirmation suppresses re-prompting** — When a user taps "I'm still here," the macro must not prompt again for the configured `suppressAfterStayMinutes` duration, even if occupancy sensors briefly report the room as empty.

7. **Active calls are never interrupted** — While a call is in progress (`SystemUnit.State.System: InCall`), the macro must take no action regardless of occupancy or wireless share state.

8. **No false positives** — The macro must not prompt or terminate shares while the room is actively occupied. Tested by remaining in the room for extended periods with an active wireless share.

9. **MTR mode compatibility** — On devices running Microsoft Teams Rooms mode, the macro must function identically to Webex mode for all criteria above. xAPI command availability in MTR mode must not cause errors.

10. **Multi-display and multi-Navigator behavior** — On dual-display and dual-Navigator configurations, prompts must render correctly and share termination must affect all active presentations.
