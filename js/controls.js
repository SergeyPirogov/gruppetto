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
 * Rebinding the Zwift controllers' buttons, one by one. Each device lists its buttons by hand, the left
 * unit's and the right unit's (Click: − and +; Play adds the arrows, A B Y Z and the paddles; Ride the
 * power-ups). The buttons send the same names on every device, so one map serves them all; a side's two
 * shift buttons on a Ride are one entry.
 */
const B = (id, mark, name, buttons = [id]) => ({ id, mark, name, buttons });
const MINUS = B('minus', '−', 'Minus', ['shiftUpL', 'shiftDownL']), PLUS = B('plus', '+', 'Plus', ['shiftUpR', 'shiftDownR']);
const ARROWS = [B('up', '▲', 'Up'), B('down', '▼', 'Down'), B('left', '◀', 'Left'), B('right', '▶', 'Right')];
const FACE = [B('y', 'Y', 'Y'), B('a', 'A', 'A'), B('b', 'B', 'B'), B('z', 'Z', 'Z')];
export const CTL_LAYOUT = {
  click: { L: [MINUS], R: [PLUS] },
  play: { L: [...ARROWS, MINUS, B('paddleL', '◖', 'Paddle (back)')], R: [...FACE, PLUS, B('paddleR', '◗', 'Paddle (back)')] },
  ride: {
    L: [...ARROWS, { ...MINUS, name: 'Shift, both buttons' }, B('paddleL', 'L', 'Lever'), B('powerUpL', '⚡', 'Power-up')],
    R: [...FACE, { ...PLUS, name: 'Shift, both buttons' }, B('paddleR', 'L', 'Lever'), B('powerUpR', '⚡', 'Power-up')],
  },
};
/** What one button can do. */
export const CTL_ACTIONS = [
  ['harder', 'Harder gear'], ['easier', 'Easier gear'], ['bigHarder', 'Big step harder'], ['bigEasier', 'Big step easier'],
  ['left', 'Lane left'], ['right', 'Lane right'], ['toggleErg', 'ERG on / off'], ['togglePause', 'Pause / resume'],
  ['camera', 'Next camera'], ['skip', 'Skip interval'], ['pacer', 'Pacer on / off'], ['hud', 'Hide / show the dashboard'], ['none', 'Nothing'],
];
/** As in Zwift; what every button does until you change it. */
export const CTL_DEFAULTS = {
  minus: 'easier', plus: 'harder', up: 'harder', down: 'easier', left: 'bigEasier', right: 'bigHarder',
  a: 'toggleErg', b: 'togglePause', y: 'camera', z: 'skip', paddleL: 'left', paddleR: 'right', powerUpL: 'pacer', powerUpR: 'hud',
};
const ALL = Object.values(CTL_LAYOUT.ride).flat();
/** The entry a button belongs to (onOffL / onOffR switch the unit off: in none). */
export const ctlEntryOf = (button) => ALL.find((e) => e.buttons.includes(button)) || null;
/** Which device a controller is by its name (a Ride by default: it has every button). */
export const ctlDevice = (name = '') => (/click/i.test(name) ? 'click' : /play/i.test(name) ? 'play' : 'ride');
/** A map saved by the first version (pairs: "updown": "harder|easier"), spread over its buttons. */
export function ctlMigrate(map = {}) {
  const out = {}, PAIRS = { updown: ['up', 'down'], leftright: ['left', 'right'], paddles: ['paddleL', 'paddleR'], powerup: ['powerUpL', 'powerUpR'] };
  for (const [k, v] of Object.entries(map || {})) {
    if (PAIRS[k] && typeof v === 'string') v.split('|').forEach((a, i) => { if (a && a !== CTL_DEFAULTS[PAIRS[k][i]]) out[PAIRS[k][i]] = a; });
    else if (k in CTL_DEFAULTS && v !== CTL_DEFAULTS[k]) out[k] = v;
  }
  return out;
}

/** What a button does with your map (buttons you never changed keep the Zwift default). */
export const rideIntent = (button, map = {}) => {
  const e = ctlEntryOf(button);
  if (!e) return null;
  const a = map[e.id] || CTL_DEFAULTS[e.id];
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
