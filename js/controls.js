// Maps controller inputs (OpenBikeControl button IDs, Zwift Ride buttons) to app intents.
//
// Intents: harder, easier, bigHarder, bigEasier, left, right, togglePause, pause, resume, skip, toggleErg, camera, pacer, hud, gear (value), steer (degrees).
// A device may send several related IDs for one physical press (e.g. Shift Up + Increase Difficulty + Nav Up),
// so intents from one message are de-duplicated before they run.

// OpenBikeControl v1 standard button IDs, see github.com/OpenBikeControl/openbikecontrol-protocol
export const OBC = {
  SHIFT_UP: 0x01, SHIFT_DOWN: 0x02, GEAR_SET: 0x03,
  NAV_UP: 0x10, NAV_DOWN: 0x11, NAV_LEFT: 0x12, NAV_RIGHT: 0x13,
  STEER_LEFT: 0x18, STEER_RIGHT: 0x19, STEERING_ANGLE: 0x1b,
  ERG_UP: 0x30, ERG_DOWN: 0x31, SKIP: 0x32, PAUSE: 0x33, RESUME: 0x34,
  HUD: 0x44,
};

const OBC_DIGITAL = {
  [OBC.SHIFT_UP]: 'harder', [OBC.ERG_UP]: 'harder', [OBC.NAV_UP]: 'harder',
  [OBC.SHIFT_DOWN]: 'easier', [OBC.ERG_DOWN]: 'easier', [OBC.NAV_DOWN]: 'easier',
  [OBC.NAV_LEFT]: 'left', [OBC.STEER_LEFT]: 'left',
  [OBC.NAV_RIGHT]: 'right', [OBC.STEER_RIGHT]: 'right',
  [OBC.SKIP]: 'skip', [OBC.PAUSE]: 'pause', [OBC.RESUME]: 'resume', [OBC.HUD]: 'hud',
};

/** Button IDs this app understands (sent to the device in the App Information message). */
export const OBC_SUPPORTED = [...new Set([...Object.keys(OBC_DIGITAL).map(Number), OBC.GEAR_SET, OBC.STEERING_ANGLE])];

/** Parse a button state message: [0x01, id, state, id, state, ...]. */
export function parseObcButtons(bytes) {
  if (!bytes.length || bytes[0] !== 0x01) return [];
  const out = [];
  for (let i = 1; i + 1 < bytes.length; i += 2) out.push({ id: bytes[i], value: bytes[i + 1] });
  return out;
}

/** App Information message: [0x04, 0x01, len, appId, len, version, count, ids...]. */
export function obcAppInfo(appId, version, ids = OBC_SUPPORTED) {
  const enc = new TextEncoder();
  const a = enc.encode(appId).slice(0, 32), v = enc.encode(version).slice(0, 32);
  return new Uint8Array([0x04, 0x01, a.length, ...a, v.length, ...v, ids.length, ...ids]);
}

/**
 * Turn OBC state changes into intents. `prev` is a Map<id, value> updated in place,
 * so only press transitions (released -> pressed) fire digital intents.
 */
export function obcIntents(changes, prev) {
  const intents = new Map();
  for (const { id, value } of changes) {
    const before = prev.get(id) || 0;
    prev.set(id, value);
    if (id === OBC.GEAR_SET) {
      if (value >= 2) intents.set('gear', value - 1);
    } else if (id === OBC.STEERING_ANGLE) {
      if (value >= 2 && value <= 0xfe) intents.set('steer', (value - 0x80) * 0.5);
    } else if (OBC_DIGITAL[id] && value !== 0 && before === 0) {
      intents.set(OBC_DIGITAL[id], true);
    }
  }
  return intents;
}

// Zwift Ride: the shift buttons go by direction on both units (up = harder, down = easier), ▲ / ▼
// the same; the paddles (the brake levers) change lane: left paddle left, right paddle right.
// onOffL / onOffR switch the controller itself off: left alone (in no row below)

/**
 * Rebinding the Zwift controllers' buttons: the rows the Devices page lists, each one button or a pair
 * (▲ ▼, ◀ ▶, the paddles, power-ups) that takes a pair of actions. Which rows a device has: Click only − and +,
 * Play no power-ups, Ride all. The buttons send the same names on every device, so one map serves them all.
 */
export const CTL_ROWS = [
  { id: 'minus', key: '−', buttons: ['shiftUpL', 'shiftDownL'], label: { click: 'Minus', play: 'Left: minus', ride: 'Left shifter, both buttons' } },
  { id: 'plus', key: '+', buttons: ['shiftUpR', 'shiftDownR'], label: { click: 'Plus', play: 'Right: plus', ride: 'Right shifter, both buttons' } },
  { id: 'updown', key: '▲ ▼', pair: ['up', 'down'], label: { play: 'Left: arrows up / down', ride: 'Arrows up / down' } },
  { id: 'leftright', key: '◀ ▶', pair: ['left', 'right'], label: { play: 'Left: arrows left / right', ride: 'Arrows left / right' } },
  { id: 'a', key: 'A', buttons: ['a'], label: { play: 'Right: A', ride: 'A' } },
  { id: 'b', key: 'B', buttons: ['b'], label: { play: 'Right: B', ride: 'B' } },
  { id: 'y', key: 'Y', buttons: ['y'], label: { play: 'Right: Y', ride: 'Y' } },
  { id: 'z', key: 'Z', buttons: ['z'], label: { play: 'Right: Z', ride: 'Z' } },
  { id: 'paddles', key: '◖ ◗', pair: ['paddleL', 'paddleR'], label: { play: 'Paddles left / right', ride: 'Paddles left / right' } },
  { id: 'powerup', key: 'PU', pair: ['powerUpL', 'powerUpR'], label: { ride: 'Power-up left / right' } },
];
/** One button's actions, and the pairs a two-button row can take (first button, second button). */
export const CTL_ACTIONS = [
  ['harder', 'Harder gear'], ['easier', 'Easier gear'], ['bigHarder', 'Big step harder'], ['bigEasier', 'Big step easier'],
  ['left', 'Lane left'], ['right', 'Lane right'], ['toggleErg', 'ERG on / off'], ['togglePause', 'Pause / resume'],
  ['camera', 'Next camera'], ['skip', 'Skip interval'], ['pacer', 'Pacer on / off'], ['hud', 'Hide / show the dashboard'], ['none', 'Nothing'],
];
export const CTL_PAIRS = [
  ['harder|easier', 'Harder / easier gear'], ['easier|harder', 'Easier / harder gear'],
  ['bigEasier|bigHarder', 'Big step easier / harder'], ['bigHarder|bigEasier', 'Big step harder / easier'],
  ['left|right', 'Lane left / right'], ['pacer|hud', 'Pacer / hide dashboard'], ['camera|camera', 'Next camera'], ['none|none', 'Nothing'],
];
/** As in Zwift; what every row does until you change it. */
export const CTL_DEFAULTS = {
  minus: 'easier', plus: 'harder', updown: 'harder|easier', leftright: 'bigEasier|bigHarder',
  a: 'toggleErg', b: 'togglePause', y: 'camera', z: 'skip', paddles: 'left|right', powerup: 'pacer|hud',
};
/** The rows a device shows: 'click', 'play' or 'ride'. */
export const ctlRows = (dev) => CTL_ROWS.filter((r) => r.label[dev]);
/** The row a button belongs to. */
export const ctlRowOf = (button) => CTL_ROWS.find((r) => r.buttons?.includes(button) || r.pair?.includes(button)) || null;
/** Which device a controller is by its name (a Ride by default: it has every button). */
export const ctlDevice = (name = '') => (/click/i.test(name) ? 'click' : /play/i.test(name) ? 'play' : 'ride');

/** What a button does with your map (rows you never changed keep the Zwift default). */
export const rideIntent = (button, map = {}) => {
  const row = ctlRowOf(button);
  if (!row) return null;
  const v = map[row.id] || CTL_DEFAULTS[row.id];
  const a = row.pair ? v.split('|')[row.pair.indexOf(button)] : v;
  return !a || a === 'none' ? null : a;
};

export const OBC_LABELS = {
  [OBC.SHIFT_UP]: 'gear +', [OBC.SHIFT_DOWN]: 'gear −', [OBC.GEAR_SET]: 'gear select',
  [OBC.NAV_UP]: '▲', [OBC.NAV_DOWN]: '▼', [OBC.NAV_LEFT]: '◀', [OBC.NAV_RIGHT]: '▶',
  [OBC.STEER_LEFT]: 'steer ◀', [OBC.STEER_RIGHT]: 'steer ▶', [OBC.STEERING_ANGLE]: 'steering angle',
  [OBC.ERG_UP]: 'ERG +', [OBC.ERG_DOWN]: 'ERG −', [OBC.SKIP]: 'skip interval',
  [OBC.PAUSE]: 'pause', [OBC.RESUME]: 'resume', [OBC.HUD]: 'HUD',
  0x14: 'OK', 0x15: 'back', 0x16: 'menu', // not used: some devices send OK with every shift
};
