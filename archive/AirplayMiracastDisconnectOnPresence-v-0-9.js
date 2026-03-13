// VERSION 0.9
import xapi from 'xapi';

/**
 * ShareAutoDisconnect v0.9
 *
 * Fixes:
 * - After reboot, some Video Input status nodes may not exist until first use.
 *   When they don't exist, xAPI throws "No match on address expression".
 *   We now treat that as "node not available yet" (not a fatal init error),
 *   and we retry subscribing until the node becomes available.
 *
 * Behavior:
 * - Uses AirPlay Activity == "Screen" as the ONLY reliable AirPlay "actively sharing" indicator. [1](https://devicebase.net/en/cisco-roomos/updates/airplay-fairplay-support/6vr)
 * - Uses Miracast Status == "Started" AND Transport == "Direct|Infrastructure" as reliable Miracast indicator.
 * - Logs AirPlay Status + Miracast Status for visibility, but does NOT treat them as "actively sharing"
 *   because you observed they can be "Active/Started" before any share occurs.
 * - Guardrail: never prompt or stop sharing while in a call (SystemUnit.State.System == InCall). [2](https://www.slideshare.net/slideshow/room-kitadministratorguidece95/239158563)
 * - Suppression window ends trigger evaluate().
 */

/* =========================
 * USER SETTINGS (EDIT THESE)
 * ========================= */
const SETTINGS = {
  occupancyBasis: 'Either',     // 'Presence' | 'Count' | 'Either'

  promptEnabled: true,
  showPromptOnOSD: true,
  showPromptOnNavigator: true,
  navigatorPeripheralId: 1,     // set to null to omit

  promptTitle: 'Are you still in the room?',
  promptText: 'Sharing will stop soon because the room appears unoccupied. Select "I\'m still here" to keep sharing.',
  optionStillHere: "I'm still here",
  optionDisconnect: 'Stop sharing',

  secondsBeforePrompt: 30,
  secondsBeforeDisconnect: 150,
  promptMaxSecondsOpen: 120,

  suppressSecondsAfterStillHere: 15 * 60,

  // Wireless sharing detection behavior:
  // We keep requirePositiveWirelessDetection = true to avoid false positives when
  // AirPlay Status shows Active / Miracast Status shows Started after reboot.
  requirePositiveWirelessDetection: true,
  assumeWirelessActiveWhenUnknown: false,

  treatPresenceUnknownAsOccupied: true,

  // Retry behavior for "late appearing" nodes
  wirelessRetryIntervalSeconds: 10,  // retry every 10s until Activity/Transport exist
  wirelessRetryMaxAttempts: 0,       // 0 = unlimited retries

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
  peoplePresence: 'Unknown',
  peopleCount: null,

  // Call guardrail [2](https://www.slideshare.net/slideshow/room-kitadministratorguidece95/239158563)
  systemState: null,
  inCall: false,

  // Wireless share
  airPlayActive: false,
  airPlayActivity: null,
  airPlayStatus: null,           // for logging only
  airPlayActivityAvailable: false,

  miraCastActive: false,
  miracastStatus: null,
  miraCastTransport: null,
  miracastTransportAvailable: false,

  // This indicates whether we have at least one *reliable* signal path available
  // (AirPlay Activity and/or Miracast Transport). If not, we treat sharingActive as false
  // when requirePositiveWirelessDetection is true.
  wirelessReliableAvailable: false,

  // Timers / windows
  unoccupiedSinceMs: null,
  suppressUntilMs: 0,
  promptVisible: false,

  // Retry counters
  wirelessRetryAttempts: 0,

  timers: {
    promptTimer: null,
    disconnectTimer: null,
    promptAutoCloseTimer: null,
    suppressEndTimer: null,
    wirelessRetryTimer: null,
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
    case 'Presence': return presenceZero;
    case 'Count': return countZero;
    case 'Either':
    default: return presenceZero || countZero;
  }
}

function wirelessSharingActive() {
  // Only trust "active sharing" when reliable nodes are available
  if (STATE.wirelessReliableAvailable) {
    return STATE.airPlayActive || STATE.miraCastActive;
  }

  // If reliable nodes aren't available yet (common just after reboot), we avoid false positives:
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
    presence: STATE.peoplePresence,
    count: STATE.peopleCount,
    occZero: occupancyIsZero(),

    airPlayStatus: STATE.airPlayStatus,
    airPlayActivity: STATE.airPlayActivity,
    airPlayActive: STATE.airPlayActive,
    airPlayActivityAvailable: STATE.airPlayActivityAvailable,

    miracastStatus: STATE.miracastStatus,
    miracastTransport: STATE.miraCastTransport,
    miracastActive: STATE.miraCastActive,
    miracastTransportAvailable: STATE.miracastTransportAvailable,

    wirelessReliableAvailable: STATE.wirelessReliableAvailable,
    sharingActive: wirelessSharingActive(),

    promptVisible: STATE.promptVisible,
    unoccupiedSinceMs: STATE.unoccupiedSinceMs,
  });
}

/** Detects the common "node missing" error pattern */
function isNoMatchError(e) {
  const msg = String(e?.message || e || '').toLowerCase();
  return msg.includes('no match on address expression');
}

/* =========================
 * PROMPT UI  (OSD + Navigator) [3](https://d38wuhq9pnj07a.cloudfront.net/a14c2920-6171-46b4-b1f3-cf5cd6dd8dea)[4](https://aseicc-my.sharepoint.com/personal/loganevans_asei_com/Documents/Microsoft%20Copilot%20Chat%20Files/AirplayMiracastDisconnectOnPresence-v-0-8.js)
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
  if (isInCall()) return; // guardrail [2](https://www.slideshare.net/slideshow/room-kitadministratorguidece95/239158563)

  const disconnectAtMs = STATE.unoccupiedSinceMs + SETTINGS.secondsBeforeDisconnect * 1000;
  const remainingToDisconnectSec = Math.max(0, Math.floor((disconnectAtMs - nowMs()) / 1000));

  const promptDurationSec = Math.max(5, Math.min(SETTINGS.promptMaxSecondsOpen, remainingToDisconnectSec));
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
      log('Prompt display Controller (with PeripheralId):', shown, 'PeripheralId:', SETTINGS.navigatorPeripheralId);
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
async function stopWirelessSharing(reason = 'unoccupied-timeout') {
  if (isInCall()) {
    log('Stop skipped (in-call guardrail):', reason);
    return;
  }

  log('Stopping wireless sharing:', reason);

  // If you prefer to stop only wireless, Presentation.Stop supports PresentationSource values like AirPlay/Miracast. [5](https://github.com/CiscoDevNet/roomdevices-macros-samples)
  // However, some environments have been inconsistent, so we keep the blanket stop from v0.8:
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

  if (isInCall()) {
    cancelAllActions('in-call-guardrail');
    return;
  }

  if (inSuppressWindow()) {
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
 * WIRELESS DETECTION RECOMPUTE
 * ========================= */
function recomputeWirelessReliability() {
  // Reliable when at least one of the "late appearing" nodes exists:
  STATE.wirelessReliableAvailable = STATE.airPlayActivityAvailable || STATE.miracastTransportAvailable;
}

function recomputeAirPlayActive() {
  // Only consider active sharing if Activity node exists:
  if (!STATE.airPlayActivityAvailable) {
    STATE.airPlayActive = false;
    return;
  }
  STATE.airPlayActive = String(STATE.airPlayActivity || '').toLowerCase() === 'screen';
}

function recomputeMiracastActive() {
  // Only consider active sharing if Transport node exists:
  if (!STATE.miracastTransportAvailable) {
    STATE.miraCastActive = false;
    return;
  }

  const statusOk = String(STATE.miracastStatus || '').toLowerCase() === 'started';
  const transport = String(STATE.miraCastTransport || '').toLowerCase();
  const transportOk = (transport === 'direct' || transport === 'infrastructure');

  STATE.miraCastActive = statusOk && transportOk;
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
    log('Initial SystemUnit.State.System:', initial, '=> inCall:', STATE.inCall); // [2](https://www.slideshare.net/slideshow/room-kitadministratorguidece95/239158563)
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
    log('Initial PeoplePresence:', initialPresence); // [6](https://github.com/cisco-ce/roomos.cisco.com/blob/master/doc/MTR/APIAndCustomizations.md)
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
    log('Initial PeopleCount.Current:', STATE.peopleCount); // [7](https://roomos.cisco.com/doc/TechDocs/MacroTutorial)
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

/**
 * Safe subscribe helper:
 * - If node is missing ("No match on address expression"), we DON'T treat it as fatal.
 * - We mark it as unavailable and let the retry loop try again later.
 */
async function safeStatusSub(label, getter, subscriber, onValue, onMissing) {
  try {
    const val = await withTimeout(getter(), 3000, `${label}.get()`);
    if (SETTINGS.logWirelessInitialValues) log('Wireless initial:', label, '=>', val);
    onValue(val, true);
    subscriber((v) => onValue(v, false));
    return true;
  } catch (e) {
    if (isNoMatchError(e)) {
      log(`Wireless node not available yet (will retry): ${label}`);
      if (onMissing) onMissing();
      return false;
    }
    log(`Wireless subscribe failed: ${label}`, e?.message || e);
    return false;
  }
}


function startWirelessRetryLoopIfNeeded() {
  // If both late nodes are available, no need to retry.
  if (STATE.airPlayActivityAvailable && STATE.miracastTransportAvailable) {
    stopWirelessRetryLoop('already-available');
    return;
  }

  // If timer already running, do nothing
  if (STATE.timers.wirelessRetryTimer) return;

  // Max attempt logic (0 = unlimited)
  if (SETTINGS.wirelessRetryMaxAttempts > 0 &&
      STATE.wirelessRetryAttempts >= SETTINGS.wirelessRetryMaxAttempts) {
    log('Wireless retry max attempts reached; not starting retry loop');
    return;
  }

  log('Starting wireless retry loop...');
  STATE.timers.wirelessRetryTimer = setInterval(async () => {
    // Max attempts guard
    if (SETTINGS.wirelessRetryMaxAttempts > 0 &&
        STATE.wirelessRetryAttempts >= SETTINGS.wirelessRetryMaxAttempts) {
      log('Wireless retry max attempts reached; stopping retry loop');
      clearTimer('wirelessRetryTimer');
      return;
    }

    STATE.wirelessRetryAttempts++;

    // Retry only missing nodes
    if (!STATE.airPlayActivityAvailable) {
      await trySubscribeAirPlayActivity(true);
    }

    if (!STATE.miracastTransportAvailable) {
      await trySubscribeMiracastTransport(true);
    }

    recomputeWirelessReliability();

    // If both are available now, stop the loop and re-evaluate once
    if (STATE.airPlayActivityAvailable && STATE.miracastTransportAvailable) {
      stopWirelessRetryLoop('became-available');
      evaluate('wireless-nodes-became-available');
    }
  }, SETTINGS.wirelessRetryIntervalSeconds * 1000);
}

/* ---- Wireless subscribe implementations ---- */
async function trySubscribeAirPlayStatus() {
  // Exists at boot for you; log it, but do not use as "actively sharing" truth.
  await safeStatusSub(
    'Video.Input.AirPlay.Status',
    () => xapi.Status.Video.Input.AirPlay.Status.get(),
    (cb) => xapi.Status.Video.Input.AirPlay.Status.on(cb),
    (v, isInitial) => {
      STATE.airPlayStatus = v;
      log(`AirPlay Status ${isInitial ? 'initial' : 'changed'}:`, v);
      // Do not call evaluate here; it's not a reliable "actively sharing" indicator in your environment.
    }
  );
}

async function trySubscribeAirPlayActivity(fromRetry = false) {
  const ok = await safeStatusSub(
    'Video.Input.AirPlay.Activity',
    () => xapi.Status.Video.Input.AirPlay.Activity.get(),
    (cb) => xapi.Status.Video.Input.AirPlay.Activity.on(cb),
    (v, isInitial) => {
      STATE.airPlayActivityAvailable = true;
      STATE.airPlayActivity = v;
      recomputeAirPlayActive();
      recomputeWirelessReliability();

      log(`AirPlay Activity ${isInitial ? 'initial' : 'changed'}:`, v, '=> airPlayActive:', STATE.airPlayActive);
      if (!isInitial) evaluate('airplay-activity-changed');
      if (isInitial && fromRetry) evaluate('airplay-activity-now-available');
    },
    () => {
      STATE.airPlayActivityAvailable = false;
      STATE.airPlayActivity = null;
      recomputeAirPlayActive();
      recomputeWirelessReliability();
    }
  );

  return ok;
}

async function trySubscribeMiracastStatus() {
  // Exists at boot for you; log it, but treat as *partial* for active sharing.
  await safeStatusSub(
    'Video.Input.Miracast.Status',
    () => xapi.Status.Video.Input.Miracast.Status.get(),
    (cb) => xapi.Status.Video.Input.Miracast.Status.on(cb),
    (v, isInitial) => {
      STATE.miracastStatus = v;
      recomputeMiracastActive();
      recomputeWirelessReliability();

      log(`Miracast Status ${isInitial ? 'initial' : 'changed'}:`, v, '=> miracastActive:', STATE.miraCastActive);
      // Only evaluate on changes if we have transport available (reliable)
      if (!isInitial && STATE.miracastTransportAvailable) evaluate('miracast-status-changed');
    }
  );
}

async function trySubscribeMiracastTransport(fromRetry = false) {
  const ok = await safeStatusSub(
    'Video.Input.Miracast.Transport',
    () => xapi.Status.Video.Input.Miracast.Transport.get(),
    (cb) => xapi.Status.Video.Input.Miracast.Transport.on(cb),
    (v, isInitial) => {
      STATE.miracastTransportAvailable = true;
      STATE.miraCastTransport = v;
      recomputeMiracastActive();
      recomputeWirelessReliability();

      log(`Miracast Transport ${isInitial ? 'initial' : 'changed'}:`, v, '=> miracastActive:', STATE.miraCastActive);
      if (!isInitial) evaluate('miracast-transport-changed');
      if (isInitial && fromRetry) evaluate('miracast-transport-now-available');
    },
    () => {
      STATE.miracastTransportAvailable = false;
      STATE.miraCastTransport = null;
      recomputeMiracastActive();
      recomputeWirelessReliability();
    }
  );

  return ok;
}

async function subscribeWirelessSharing() {
  // Always try to subscribe to the "always present" status nodes for logging:
  await trySubscribeAirPlayStatus();
  await trySubscribeMiracastStatus();

  // Try the "late appearing" nodes; if missing, we will retry.
  await trySubscribeAirPlayActivity(false);
  await trySubscribeMiracastTransport(false);

  recomputeWirelessReliability();
  log('Wireless reliable available:', STATE.wirelessReliableAvailable);

  // If late nodes are missing, start retry loop
  startWirelessRetryLoopIfNeeded();
}

function subscribePromptResponses() {
  try {
    xapi.Event.UserInterface.Message.Prompt.Response.on(async (event) => { // [4](https://aseicc-my.sharepoint.com/personal/loganevans_asei_com/Documents/Microsoft%20Copilot%20Chat%20Files/AirplayMiracastDisconnectOnPresence-v-0-8.js)
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
    log('Initializing v0.9...');
    await subscribeCallState();
    await subscribeOccupancy();
    await subscribeWirelessSharing();
    subscribePromptResponses();

    evaluate('startup');

    log('Init complete');
  } catch (e) {
    log('INIT FAILED:', e && e.stack ? e.stack : e);
  }
})();
