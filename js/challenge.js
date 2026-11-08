// A ride against a friend (#challenge): a finished ride packed into a link. Whoever opens it races its ghost on
// the same route: where the friend was every 5 s and with what power. No server: the ride is in the link itself
// (deflated JSON, base64url, after #challenge=).

const VERSION = 1;

const toB64url = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** The link's payload for a ride from history (it needs a distance trace), from rider name. */
export async function encodeChallenge(e, name) {
  const d = e.chart.d, pw = e.chart.pw;
  // distance as whole metres gained each 5 s: small numbers that pack well
  const dd = d.map((x, i) => Math.round(x) - (i ? Math.round(d[i - 1]) : 0));
  const json = JSON.stringify({
    v: VERSION, r: e.routeId, n: String(name || '').slice(0, 24), at: e.date.slice(0, 10),
    t: Math.round(e.summary.duration), m: Math.round(e.summary.distance), e: e.chart.every, dd, pw,
  });
  return toB64url(await pipe(new TextEncoder().encode(json), new CompressionStream('deflate-raw')));
}

/** The ride a link carries, as a ghost entry; null when the link is broken or from another version. */
export async function decodeChallenge(s) {
  try {
    const json = JSON.parse(new TextDecoder().decode(await pipe(fromB64url(s), new DecompressionStream('deflate-raw'))));
    if (json.v !== VERSION || typeof json.r !== 'string' || !Array.isArray(json.dd) || json.dd.length < 2) return null;
    let at = 0;
    const d = json.dd.map((x) => (at += Number(x) || 0));
    const pw = Array.isArray(json.pw) ? json.pw.map((x) => Number(x) || 0) : d.map(() => 0);
    return {
      friend: true, name: String(json.n || '').slice(0, 24), routeId: json.r, date: json.at || '',
      summary: { duration: Number(json.t) || 0, distance: Number(json.m) || at }, chart: { every: Number(json.e) || 5, d, pw },
    };
  } catch {
    return null;
  }
}

/** The payload in a page address (#challenge=…), '' when there is none. */
export const challengeIn = (hash) => (/^#challenge=([\w-]+)$/.exec(hash || '') || [])[1] || '';
