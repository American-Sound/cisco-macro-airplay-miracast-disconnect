// VERSION 0.7


import xapi from 'xapi';

/**
 * ShareAutoDisconnect:
 * - If room becomes unoccupied AND AirPlay/Miracast is actively sharing,
 *   show prompt after delay, then stop sharing after timeout, unless user confirms still present.
 * - Guardrail: do nothing (no prompt, no stop) while in a call. [5](https://roomos.cisco.com/xapi/Command.Presentation.Start)
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
  // If null, macro will omit PeripheralId (often more reliable in single-Navigator rooms). [3](https://roomos.cisco.com/xapi/Configuration.RoomAnalytics.PeoplePresence.Input.HeadDetector/)[4](https://developer.webex.com/docs/api/v1/xapi)
  navigatorPeripheralId: 1, // set to null to omit

  promptTitle: 'Are you still in the room?',
  // No newline characters per request:
  promptText: 'Sharing will stop soon because the room appears unoccupied. Select "I\'m still here" to keep sharing.',
  optionStillHere: "I'm still here",
  optionDisconnect: 'Stop sharing',

  // Timing
  secondsBeforePrompt: 30,         // wait before showing prompt
  secondsBeforeDisconnect: 150,    // total time since unoccupied before stopping share
  promptMaxSecondsOpen: 120,       // max prompt open time (will be capped to disconnect deadline)

  // Suppression window when user confirms still present
  suppressSecondsAfterStillHere: 15 * 60,

  // Wireless sharing detection behavior:
  // If true: only act when we positively detect AirPlay/Miracast sharing.
  // If false: allow fallback when detection isn't available (not recommended).
  requirePositiveWirelessDetection: true,
  assumeWirelessActiveWhenUnknown: false,

  // Presence "Unknown" handling (safer default: treat Unknown as occupied) [1](https://webexcc-sa.github.io/LAB-1451-24/cheatsheet/)
  treatPresenceUnknownAsOccupied: true,

  // Logging
  debug: true,
  logEvaluateSnapshot: true,     // logs state snapshot each time evaluate() runs
  logWirelessInitialValues: true // logs initial AirPlay/Miracast values after get()
};

/* =========================
 * INTERNAL STATE
 * ========================= */
const STATE = {
  // Occupancy [1](https://webexcc-sa.github.io/LAB-1451-24/cheatsheet/)[2](https://github.com/CiscoDevNet/roomdevices-macros-samples)
  peoplePresence: 'Unknown', // Yes|No|Unknown
  peopleCount: null,         // integer or null

  // Call guardrail [5](https://roomos.cisco.com/xapi/Command.Presentation.Start)
  systemState: null,         // e.g. InCall, Initialized, Sleeping...
  inCall: false,

  // Wireless share
  airPlayActive: false,
  airPlayActivity: null,     // expects "Screen" when active per your requirement [6](https://www.slideshare.net/slideshow/room-kitadministratorguidece95/239158563)
  miraCastActive: false,
  miracastStatus: null,      // Started
  miraCastTransport: null,   // Direct|Infrastructure
  wirelessDetectionAvailable: false,

  // Timers / windows
  unoccupiedSinceMs: null,
  suppressUntilMs: 0,
  promptVisible: false,

  timers: {
    promptTimer: null,
    disconnectTimer: null,
    promptAutoCloseTimer: null,
    suppressEndTimer: null, // triggers evaluate() when suppression ends
  },
};

const PROMPT_FEEDBACK_ID = 77; // 0-255 [3](https://roomos.cisco.com/xapi/Configuration.RoomAnalytics.PeoplePresence.Input.HeadDetector/)[4](https://developer.webex.com/docs/api/v1/xapi)

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
    unoccupiedSinceMs: STATE.unoccupiedSinceMs
  });
}

async function safePromptDisplay(params) {
  try {
    await xapi.Command.UserInterface.Message.Prompt.Display(params); // [3](https://roomos.cisco.com/xapi/Configuration.RoomAnalytics.PeoplePresence.Input.HeadDetector/)[4](https://developer.webex.com/docs/api/v1/xapi)
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

    // Attempt 1: clear with PeripheralId (if provided)
    if (SETTINGS.navigatorPeripheralId !== null && SETTINGS.navigatorPeripheralId !== undefined) {
      cleared = await safePromptClear({
        ...base,
        Target: 'Controller',
        PeripheralId: SETTINGS.navigatorPeripheralId,
      });
    }

    // Attempt 2: clear without PeripheralId
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

  // Guardrail: never prompt in a call [5](https://roomos.cisco.com/xapi/Command.Presentation.Start)
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

  // OSD
  if (SETTINGS.showPromptOnOSD) {
    const ok = await safePromptDisplay({ ...base, Target: 'OSD' });
    log('Prompt display OSD:', ok);
    anyShown = ok || anyShown;
  }

  // Navigator / Controller (robust fallback) [3](https://roomos.cisco.com/xapi/Configuration.RoomAnalytics.PeoplePresence.Input.HeadDetector/)[4](https://developer.webex.com/docs/api/v1/xapi)
  if (SETTINGS.showPromptOnNavigator) {
    let shown = false;

    // Attempt 1: Controller + PeripheralId (FIXED: now actually passes PeripheralId)
    if (SETTINGS.navigatorPeripheralId !== null && SETTINGS.navigatorPeripheralId !== undefined) {
      shown = await safePromptDisplay({
        ...base,
        Target: 'Controller',
        PeripheralId: SETTINGS.navigatorPeripheralId,
      });
      log('Prompt display Controller (with PeripheralId):', shown, 'PeripheralId:', SETTINGS.navigatorPeripheralId);
    }

    // Attempt 2: Controller without PeripheralId
    if (!shown) {
      shown = await safePromptDisplay({
        ...base,
        Target: 'Controller',
      });
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

async function stopWirelessSharing(reason = 'unoccupied-timeout') {
  // Guardrail: never stop presentations in a call [5](https://roomos.cisco.com/xapi/Command.Presentation.Start)
  if (isInCall()) {
    log('Stop skipped (in-call guardrail):', reason);
    return;
  }

  log('Stopping wireless sharing:', reason);

  // Stop both AirPlay and Miracast (ignore errors if source not active). [7](https://bing.com/search?q=roomos+xapi+xStatus+Call+1+Status+to+detect+in+call+macros)
  const attempts = [
    { PresentationSource: 'AirPlay' },
    { PresentationSource: 'Airplay' },
    { PresentationSource: 'Miracast' },
  ];

  for (const params of attempts) {
    try {
      await xapi.Command.Presentation.Stop(params);
      log('Presentation.Stop success:', params);
    } catch (e) {
      log('Presentation.Stop ignored error:', params, e?.message || e);
    }
  }
}

/* =========================
 * SUPPRESSION WINDOW HANDLING
 * ========================= */
function startSuppressionWindow(seconds) {
  STATE.suppressUntilMs = nowMs() + seconds * 1000;
  log('Suppression started for seconds:', seconds);

  // Ensure we re-evaluate exactly when suppression ends
  clearTimer('suppressEndTimer');
  const delayMs = Math.max(0, STATE.suppressUntilMs - nowMs());
  STATE.timers.suppressEndTimer = setTimeout(() => {
    log('Suppression ended -> triggering evaluate()');
    evaluate('suppression-ended');
  }, delayMs);
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
    secondsBeforeDisconnect: SETTINGS.secondsBeforeDisconnect
  });

  // Schedule prompt
  clearTimer('promptTimer');
  STATE.timers.promptTimer = setTimeout(async () => {
    if (isInCall()) return;
    if (inSuppressWindow()) return;
    if (!occupancyIsZero()) return;
    if (!wirelessSharingActive()) return;

    log('Prompt timer fired -> showing prompt');
    await showPrompt();
  }, SETTINGS.secondsBeforePrompt * 1000);

  // Schedule disconnect
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
  // xStatus SystemUnit State System indicates InCall when actively in a call [5](https://roomos.cisco.com/xapi/Command.Presentation.Start)
  try {
    const initial = await xapi.Status.SystemUnit.State.System.get();
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
  // PeoplePresence [1](https://webexcc-sa.github.io/LAB-1451-24/cheatsheet/)
  try {
    log('Reading initial PeoplePresence...');
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

  // PeopleCount.Current [2](https://github.com/CiscoDevNet/roomdevices-macros-samples)
  try {
    log('Reading initial PeopleCount.Current...');
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
  const trySub = async (label, getter, subscriber, handler) => {
    try {
      const val = await getter();
      handler(val, true); // initial
      subscriber((v) => handler(v, false)); // changes
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

  // AirPlay: Video.Input.AirPlay.Activity -> "Screen" means active [6](https://www.slideshare.net/slideshow/room-kitadministratorguidece95/239158563)
  await trySub(
    'Video.Input.AirPlay.Activity',
    () => xapi.Status.Video.Input.AirPlay.Activity.get(),
    (cb) => xapi.Status.Video.Input.AirPlay.Activity.on(cb),
    (v, isInitial) => {
      STATE.airPlayActivity = v;
      STATE.airPlayActive = String(v).toLowerCase() === 'screen';
      log(`AirPlay Activity ${isInitial ? 'initial' : 'changed'}:`, v, '=> airPlayActive:', STATE.airPlayActive);
      evaluate(isInitial ? 'airplay-activity-initial' : 'airplay-activity-changed');
    }
  );

  // Miracast recompute
  const recomputeMiracastActive = () => {
    const statusOk = String(STATE.miracastStatus || '').toLowerCase() === 'started';
    const transport = String(STATE.miraCastTransport || '').toLowerCase();
    const transportOk = (transport === 'direct' || transport === 'infrastructure');
    STATE.miraCastActive = statusOk && transportOk;
  };

  await trySub(
    'Video.Input.Miracast.Status',
    () => xapi.Status.Video.Input.Miracast.Status.get(),
    (cb) => xapi.Status.Video.Input.Miracast.Status.on(cb),
    (v, isInitial) => {
      STATE.miracastStatus = v;
      recomputeMiracastActive();
      log(`Miracast Status ${isInitial ? 'initial' : 'changed'}:`, v, '=> miraCastActive:', STATE.miraCastActive);
      evaluate(isInitial ? 'miracast-status-initial' : 'miracast-status-changed');
    }
  );

  await trySub(
    'Video.Input.Miracast.Transport',
    () => xapi.Status.Video.Input.Miracast.Transport.get(),
    (cb) => xapi.Status.Video.Input.Miracast.Transport.on(cb),
    (v, isInitial) => {
      STATE.miraCastTransport = v;
      recomputeMiracastActive();
      log(`Miracast Transport ${isInitial ? 'initial' : 'changed'}:`, v, '=> miraCastActive:', STATE.miraCastActive);
      evaluate(isInitial ? 'miracast-transport-initial' : 'miracast-transport-changed');
    }
  );

  log('Wireless detection available:', STATE.wirelessDetectionAvailable);
}

function subscribePromptResponses() {
  try {
    xapi.Event.UserInterface.Message.Prompt.Response.on(async (event) => { //[4](https://developer.webex.com/docs/api/v1/xapi)
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
    log('Initializing macro...');

    log('Step 1/5: subscribeCallState()');
    await subscribeCallState();
    log('Step 1/5 complete');

    log('Step 2/5: subscribeOccupancy()');
    await subscribeOccupancy();
    log('Step 2/5 complete');

    log('Step 3/5: subscribeWirelessSharing()');
    await subscribeWirelessSharing();
    log('Step 3/5 complete');

    log('Step 4/5: subscribePromptResponses()');
    subscribePromptResponses();
    log('Step 4/5 complete');

    log('Step 5/5: evaluate(startup)');
    evaluate('startup');
    log('Init complete ✅');
  } catch (e) {
    log('INIT FAILED:', e && e.stack ? e.stack : e);
  }
})();
