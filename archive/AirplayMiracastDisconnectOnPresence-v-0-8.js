// VERSION 0.8

import xapi from 'xapi';

/**
 * ShareAutoDisconnect v0.8
 *
 * Disconnects AirPlay and Miracast wireless sharing when the room becomes
 * unoccupied. Shows an on-screen prompt before disconnecting so a present
 * user can cancel. Never interrupts an active call.
 *
 * Changes from v0.7:
 *   - Fixed Presentation.Stop: uses blanket stop instead of invalid
 *     PresentationSource string parameters. The xAPI Presentation.Stop
 *     accepts ConnectorId (integer), not source-type strings. A blanket
 *     stop is safe here because the room is confirmed empty.
 *   - Deferred initial evaluate() — subscriptions no longer fire evaluate
 *     individually during init. A single evaluate('startup') runs after
 *     all state is loaded, eliminating 3-5 redundant evaluations.
 *   - Added withTimeout to wireless subscription get() calls for
 *     consistency with occupancy reads.
 *   - Consolidated timer management with named timer helper.
 *
 * Requires:
 *   xConfiguration RoomAnalytics PeoplePresenceDetector: On
 *   xConfiguration RoomAnalytics PeopleCountOutOfCall: On
 *
 * Tested on: RoomOS 11.x (Room Kit, Room Bar, Board, Desk series)
 */

/* =========================
 * USER SETTINGS (EDIT THESE)
 * ========================= */
const SETTINGS = {
  // Which occupancy signal(s) should drive behavior?
  // 'Presence'  -> only PeoplePresence == "No"
  // 'Count'     -> only PeopleCount.Current == 0
  // 'Either'    -> Presence == "No" OR Count == 0
  occupancyBasis: 'Either',

  // Prompt settings
  promptEnabled: true,
  showPromptOnOSD: true,
  showPromptOnNavigator: true,

  // If multiple controllers exist, set the PeripheralId for the desired Navigator.
  // If null, macro will omit PeripheralId (often more reliable in single-Navigator rooms).
  navigatorPeripheralId: 1, // set to null to omit

  promptTitle: 'Are you still in the room?',
  promptText: 'Sharing will stop soon because the room appears unoccupied. Select "I\'m still here" to keep sharing.',
  optionStillHere: "I'm still here",
  optionDisconnect: 'Stop sharing',

  // Timing
  secondsBeforePrompt: 30,         // wait before showing prompt
  secondsBeforeDisconnect: 150,    // total time since unoccupied before stopping share
  promptMaxSecondsOpen: 120,       // max prompt open time (capped to disconnect deadline)

  // Suppression window when user confirms still present
  suppressSecondsAfterStillHere: 15 * 60,

  // Wireless sharing detection behavior:
  // If true: only act when we positively detect AirPlay/Miracast sharing.
  // If false: allow fallback when detection isn't available (not recommended).
  requirePositiveWirelessDetection: true,
  assumeWirelessActiveWhenUnknown: false,

  // Presence "Unknown" handling (safer default: treat Unknown as occupied)
  treatPresenceUnknownAsOccupied: true,

  // Logging
  debug: true,
  logEvaluateSnapshot: true,
  logWirelessInitialValues: true,
};

/* =========================
 * INTERNAL STATE
 * ========================= */
const STATE = {
  // Occupancy
  peoplePresence: 'Unknown', // Yes|No|Unknown
  peopleCount: null,         // integer or null

  // Call guardrail
  systemState: null,
  inCall: false,

  // Wireless share
  airPlayActive: false,
  airPlayActivity: null,
  miraCastActive: false,
  miracastStatus: null,
  miraCastTransport: null,
  wirelessDetectionAvailable: false,

  // Timers / windows
  unoccupiedSinceMs: null,
  suppressUntilMs: 0,
  promptVisible: false,

  timers: {
    promptTimer: null,
    disconnectTimer: null,
    promptAutoCloseTimer: null,
    suppressEndTimer: null,
  },
};

const PROMPT_FEEDBACK_ID = 77;

/* =========================
 * HELPERS
 * ========================= */
function log(...args) {
  if (SETTINGS.debug) console.log('[ShareAutoDisconnect]', ...args);
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms)
    ),
  ]);
}

function nowMs() {
  return Date.now();
}

function clearTimer(name) {
  if (STATE.timers[name]) {
    clearTimeout(STATE.timers[name]);
    STATE.timers[name] = null;
  }
}

function clearActionTimers() {
  clearTimer('promptTimer');
  clearTimer('disconnectTimer');
  clearTimer('promptAutoCloseTimer');
  // NOTE: Do not clear suppressEndTimer here; it must survive until suppression ends.
}

function isInCall() {
  return !!STATE.inCall;
}

function inSuppressWindow() {
  return nowMs() < STATE.suppressUntilMs;
}

function occupancyIsZero() {
  const presenceZero =
    STATE.peoplePresence === 'No' ||
    (!SETTINGS.treatPresenceUnknownAsOccupied && STATE.peoplePresence === 'Unknown');

  const countZero = (typeof STATE.peopleCount === 'number' && STATE.peopleCount === 0);

  switch (SETTINGS.occupancyBasis) {
    case 'Presence':
      return presenceZero;
    case 'Count':
      return countZero;
    case 'Either':
    default:
      return presenceZero || countZero;
  }
}

function wirelessSharingActive() {
  if (STATE.wirelessDetectionAvailable) {
    return STATE.airPlayActive || STATE.miraCastActive;
  }
  if (SETTINGS.requirePositiveWirelessDetection) return false;
  return SETTINGS.assumeWirelessActiveWhenUnknown;
}

function snapshot(trigger) {
  if (!SETTINGS.logEvaluateSnapshot) return;
  log('EVALUATE snapshot:', {
    trigger,
    inCall: STATE.inCall,
    systemState: STATE.systemState,
    suppressed: inSuppressWindow(),
    occupancyBasis: SETTINGS.occupancyBasis,
    presence: STATE.peoplePresence,
    count: STATE.peopleCount,
    occZero: occupancyIsZero(),
    wirelessDetectionAvailable: STATE.wirelessDetectionAvailable,
    airPlayActivity: STATE.airPlayActivity,
    airPlayActive: STATE.airPlayActive,
    miracastStatus: STATE.miracastStatus,
    miracastTransport: STATE.miraCastTransport,
    miracastActive: STATE.miraCastActive,
    sharingActive: wirelessSharingActive(),
    promptVisible: STATE.promptVisible,
    unoccupiedSinceMs: STATE.unoccupiedSinceMs,
  });
}

/* =========================
 * PROMPT UI
 * ========================= */
async function safePromptDisplay(params) {
  try {
    await xapi.Command.UserInterface.Message.Prompt.Display(params);
    return true;
  } catch (e) {
    log('Prompt.Display failed:', e?.message || e);
    return false;
  }
}

async function safePromptClear(params) {
  try {
    await xapi.Command.UserInterface.Message.Prompt.Clear(params);
    return true;
  } catch (e) {
    try {
      await xapi.Command.UserInterface.Message.Prompt.Clear();
      return true;
    } catch (e2) {
      log('Prompt.Clear failed:', e2?.message || e2);
      return false;
    }
  }
}

async function closePrompt(reason = 'unknown') {
  if (!STATE.promptVisible) return;
  STATE.promptVisible = false;

  const base = { FeedbackId: PROMPT_FEEDBACK_ID };

  if (SETTINGS.showPromptOnOSD) {
    await safePromptClear({ ...base, Target: 'OSD' });
  }

  if (SETTINGS.showPromptOnNavigator) {
    let cleared = false;

    if (SETTINGS.navigatorPeripheralId != null) {
      cleared = await safePromptClear({
        ...base,
        Target: 'Controller',
        PeripheralId: SETTINGS.navigatorPeripheralId,
      });
    }

    if (!cleared) {
      await safePromptClear({ ...base, Target: 'Controller' });
    }
  }

  clearTimer('promptAutoCloseTimer');
  log('Prompt closed:', reason);
}

async function showPrompt() {
  if (!SETTINGS.promptEnabled) return;
  if (STATE.promptVisible) return;
  if (isInCall()) return;

  const disconnectAtMs = STATE.unoccupiedSinceMs + SETTINGS.secondsBeforeDisconnect * 1000;
  const remainingToDisconnectSec = Math.max(0, Math.floor((disconnectAtMs - nowMs()) / 1000));

  const promptDurationSec = Math.max(
    5,
    Math.min(SETTINGS.promptMaxSecondsOpen, remainingToDisconnectSec)
  );
  if (promptDurationSec <= 0) return;

  const base = {
    FeedbackId: PROMPT_FEEDBACK_ID,
    Title: SETTINGS.promptTitle,
    Text: SETTINGS.promptText,
    Duration: promptDurationSec,
    'Option.1': SETTINGS.optionStillHere,
    'Option.2': SETTINGS.optionDisconnect,
  };

  let anyShown = false;

  if (SETTINGS.showPromptOnOSD) {
    const ok = await safePromptDisplay({ ...base, Target: 'OSD' });
    log('Prompt display OSD:', ok);
    anyShown = ok || anyShown;
  }

  if (SETTINGS.showPromptOnNavigator) {
    let shown = false;

    if (SETTINGS.navigatorPeripheralId != null) {
      shown = await safePromptDisplay({
        ...base,
        Target: 'Controller',
        PeripheralId: SETTINGS.navigatorPeripheralId,
      });
      log('Prompt display Controller (with PeripheralId):', shown);
    }

    if (!shown) {
      shown = await safePromptDisplay({ ...base, Target: 'Controller' });
      log('Prompt display Controller (no PeripheralId):', shown);
    }

    anyShown = shown || anyShown;
  }

  if (anyShown) {
    STATE.promptVisible = true;
    log('Prompt shown:', { duration: promptDurationSec, remainingToDisconnectSec });

    clearTimer('promptAutoCloseTimer');
    STATE.timers.promptAutoCloseTimer = setTimeout(() => {
      closePrompt('auto-timeout');
    }, promptDurationSec * 1000);
  }
}

/* =========================
 * SHARE CONTROL
 * ========================= */

/**
 * Stop all active wireless presentations. Uses a blanket Presentation.Stop()
 * rather than targeting by PresentationSource name — the xAPI Presentation.Stop
 * accepts ConnectorId (integer), not source-type strings like 'AirPlay' or
 * 'Miracast'. A blanket stop is safe here because the room is confirmed empty
 * (or the user explicitly requested disconnect), so there is no presentation
 * worth preserving.
 */
async function stopWirelessSharing(reason = 'unoccupied-timeout') {
  if (isInCall()) {
    log('Stop skipped (in-call guardrail):', reason);
    return;
  }

  log('Stopping wireless sharing:', reason);

  try {
    await xapi.Command.Presentation.Stop();
    log('Presentation.Stop success');
  } catch (e) {
    log('Presentation.Stop (no active presentation or error):', e?.message || e);
  }
}

/* =========================
 * SUPPRESSION WINDOW
 * ========================= */
function startSuppressionWindow(seconds) {
  STATE.suppressUntilMs = nowMs() + seconds * 1000;
  log('Suppression started for seconds:', seconds);

  clearTimer('suppressEndTimer');
  STATE.timers.suppressEndTimer = setTimeout(() => {
    log('Suppression ended -> triggering evaluate()');
    evaluate('suppression-ended');
  }, seconds * 1000);
}

/* =========================
 * CORE LOGIC
 * ========================= */
function resetUnoccupiedState() {
  STATE.unoccupiedSinceMs = null;
  clearActionTimers();
  closePrompt('occupancy-restored');
}

function cancelAllActions(reason) {
  STATE.unoccupiedSinceMs = null;
  clearActionTimers();
  closePrompt(reason);
}

function scheduleUnoccupiedActions() {
  if (STATE.unoccupiedSinceMs) return;
  STATE.unoccupiedSinceMs = nowMs();

  log('Unoccupied detected: scheduling timers', {
    secondsBeforePrompt: SETTINGS.secondsBeforePrompt,
    secondsBeforeDisconnect: SETTINGS.secondsBeforeDisconnect,
  });

  clearTimer('promptTimer');
  STATE.timers.promptTimer = setTimeout(async () => {
    if (isInCall()) return;
    if (inSuppressWindow()) return;
    if (!occupancyIsZero()) return;
    if (!wirelessSharingActive()) return;

    log('Prompt timer fired -> showing prompt');
    await showPrompt();
  }, SETTINGS.secondsBeforePrompt * 1000);

  clearTimer('disconnectTimer');
  STATE.timers.disconnectTimer = setTimeout(async () => {
    if (isInCall()) return;
    if (inSuppressWindow()) return;
    if (!occupancyIsZero()) return;

    if (!wirelessSharingActive()) {
      log('Disconnect timer fired but not sharing anymore -> closing prompt');
      await closePrompt('no-longer-sharing');
      return;
    }

    log('Disconnect timer fired -> stopping wireless sharing');
    await closePrompt('disconnect-deadline');
    await stopWirelessSharing('unoccupied-timeout');
  }, SETTINGS.secondsBeforeDisconnect * 1000);
}

function evaluate(trigger = 'unknown') {
  snapshot(trigger);

  const occZero = occupancyIsZero();
  const shareActive = wirelessSharingActive();
  const suppressed = inSuppressWindow();
  const inCallNow = isInCall();

  if (inCallNow) {
    cancelAllActions('in-call-guardrail');
    return;
  }

  if (suppressed) {
    cancelAllActions('suppressed');
    return;
  }

  if (!occZero) {
    resetUnoccupiedState();
    return;
  }

  if (!shareActive) {
    cancelAllActions('not-sharing');
    return;
  }

  scheduleUnoccupiedActions();
}

/* =========================
 * SUBSCRIPTIONS
 * ========================= */
async function subscribeCallState() {
  try {
    const initial = await withTimeout(
      xapi.Status.SystemUnit.State.System.get(),
      3000,
      'SystemUnit.State.System.get()'
    );
    STATE.systemState = initial;
    STATE.inCall = String(initial).toLowerCase() === 'incall';
    log('Initial SystemUnit.State.System:', initial, '=> inCall:', STATE.inCall);
  } catch (e) {
    log('Could not read SystemUnit.State.System:', e?.message || e);
  }

  try {
    xapi.Status.SystemUnit.State.System.on((value) => {
      STATE.systemState = value;
      STATE.inCall = String(value).toLowerCase() === 'incall';
      log('SystemUnit.State.System changed:', value, '=> inCall:', STATE.inCall);
      evaluate('call-state-changed');
    });
    log('Subscribed: SystemUnit.State.System');
  } catch (e) {
    log('SystemUnit.State.System subscription failed:', e?.message || e);
  }
}

async function subscribeOccupancy() {
  try {
    const initialPresence = await withTimeout(
      xapi.Status.RoomAnalytics.PeoplePresence.get(),
      3000,
      'RoomAnalytics.PeoplePresence.get()'
    );
    STATE.peoplePresence = initialPresence;
    log('Initial PeoplePresence:', initialPresence);
  } catch (e) {
    log('PeoplePresence initial read failed (continuing):', e?.message || e);
  }

  try {
    xapi.Status.RoomAnalytics.PeoplePresence.on((value) => {
      STATE.peoplePresence = value;
      log('PeoplePresence changed:', value);
      evaluate('people-presence-changed');
    });
    log('Subscribed: RoomAnalytics.PeoplePresence');
  } catch (e) {
    log('PeoplePresence subscription failed:', e?.message || e);
  }

  try {
    const initialCount = await withTimeout(
      xapi.Status.RoomAnalytics.PeopleCount.Current.get(),
      3000,
      'RoomAnalytics.PeopleCount.Current.get()'
    );
    STATE.peopleCount = Number(initialCount);
    log('Initial PeopleCount.Current:', STATE.peopleCount);
  } catch (e) {
    log('PeopleCount initial read failed (continuing):', e?.message || e);
  }

  try {
    xapi.Status.RoomAnalytics.PeopleCount.Current.on((value) => {
      STATE.peopleCount = Number(value);
      log('PeopleCount.Current changed:', STATE.peopleCount);
      evaluate('people-count-changed');
    });
    log('Subscribed: RoomAnalytics.PeopleCount.Current');
  } catch (e) {
    log('PeopleCount subscription failed:', e?.message || e);
  }
}

async function subscribeWirelessSharing() {
  // Helper: read initial value + subscribe, but do NOT call evaluate during init.
  // We defer evaluate to after all subscriptions are wired up.
  const trySub = async (label, getter, subscriber, handler) => {
    try {
      const val = await withTimeout(getter(), 3000, label);
      handler(val, true);
      subscriber((v) => handler(v, false));
      STATE.wirelessDetectionAvailable = true;
      if (SETTINGS.logWirelessInitialValues) {
        log('Wireless initial:', label, '=>', val);
      }
      return true;
    } catch (e) {
      log('Wireless subscribe failed:', label, e?.message || e);
      return false;
    }
  };

  const recomputeMiracastActive = () => {
    const statusOk = String(STATE.miracastStatus || '').toLowerCase() === 'started';
    const transport = String(STATE.miraCastTransport || '').toLowerCase();
    const transportOk = (transport === 'direct' || transport === 'infrastructure');
    STATE.miraCastActive = statusOk && transportOk;
  };

  // AirPlay: Video.Input.AirPlay.Activity -> "Screen" means active
  await trySub(
    'Video.Input.AirPlay.Activity',
    () => xapi.Status.Video.Input.AirPlay.Activity.get(),
    (cb) => xapi.Status.Video.Input.AirPlay.Activity.on(cb),
    (v, isInitial) => {
      STATE.airPlayActivity = v;
      STATE.airPlayActive = String(v).toLowerCase() === 'screen';
      log(`AirPlay Activity ${isInitial ? 'initial' : 'changed'}:`, v, '=> active:', STATE.airPlayActive);
      if (!isInitial) evaluate('airplay-activity-changed');
    }
  );

  // Miracast Status
  await trySub(
    'Video.Input.Miracast.Status',
    () => xapi.Status.Video.Input.Miracast.Status.get(),
    (cb) => xapi.Status.Video.Input.Miracast.Status.on(cb),
    (v, isInitial) => {
      STATE.miracastStatus = v;
      recomputeMiracastActive();
      log(`Miracast Status ${isInitial ? 'initial' : 'changed'}:`, v, '=> active:', STATE.miraCastActive);
      if (!isInitial) evaluate('miracast-status-changed');
    }
  );

  // Miracast Transport
  await trySub(
    'Video.Input.Miracast.Transport',
    () => xapi.Status.Video.Input.Miracast.Transport.get(),
    (cb) => xapi.Status.Video.Input.Miracast.Transport.on(cb),
    (v, isInitial) => {
      STATE.miraCastTransport = v;
      recomputeMiracastActive();
      log(`Miracast Transport ${isInitial ? 'initial' : 'changed'}:`, v, '=> active:', STATE.miraCastActive);
      if (!isInitial) evaluate('miracast-transport-changed');
    }
  );

  log('Wireless detection available:', STATE.wirelessDetectionAvailable);
}

function subscribePromptResponses() {
  try {
    xapi.Event.UserInterface.Message.Prompt.Response.on(async (event) => {
      const feedbackId = Number(event?.FeedbackId);
      if (feedbackId !== PROMPT_FEEDBACK_ID) return;

      const optionId = Number(event?.OptionId);

      if (isInCall()) return;

      log('Prompt response:', { optionId, target: event?.Target, peripheralId: event?.PeripheralId });

      if (optionId === 1) {
        startSuppressionWindow(SETTINGS.suppressSecondsAfterStillHere);
        cancelAllActions('user-still-here');
      } else if (optionId === 2) {
        cancelAllActions('user-stop-now');
        await stopWirelessSharing('user-request');
      }
    });
    log('Subscribed: UserInterface.Message.Prompt.Response');
  } catch (e) {
    log('Prompt response subscription failed:', e?.message || e);
  }
}

/* =========================
 * INIT
 * ========================= */
(async function init() {
  try {
    log('Initializing v0.8...');

    await subscribeCallState();
    await subscribeOccupancy();
    await subscribeWirelessSharing();
    subscribePromptResponses();

    // Single evaluate after all state is loaded — no redundant startup evaluations
    evaluate('startup');

    log('Init complete');
  } catch (e) {
    log('INIT FAILED:', e && e.stack ? e.stack : e);
  }
})();
