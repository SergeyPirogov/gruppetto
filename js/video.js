// Video rides (#video): a first-person ride from YouTube instead of the 3D road. The video runs at your speed
// divided by the speed it was filmed at (0.25–2×, YouTube's range), pauses when you stop, and starts where the
// ride begins (past an intro). The road under it is flat: without the filmed ride's track, its climbs would not
// match the picture. YouTube picks the picture's quality from the player's size and the connection; its own
// controls (the gear for quality) show when the mouse is over the video.

/** The video id in a YouTube link (watch?v=, youtu.be/, shorts/, embed/) or a bare id, '' when none. */
export function youtubeId(u) {
  const s = String(u || '').trim();
  return (/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([\w-]{11})/.exec(s) || [])[1] || (/^[\w-]{11}$/.test(s) ? s : '');
}

/** Seconds from "2:00", "1:02:03", "120", "2m", "1h2m3s"; 0 when it is none of these. */
export function secondsOf(x) {
  const s = String(x ?? '').trim();
  if (!s) return 0;
  if (/^\d+(:\d{1,2}){1,2}$/.test(s)) return s.split(':').reduce((a, b) => a * 60 + Number(b), 0);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(s);
  return m ? Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0) : 0;
}

/** The start in a link's t= or start=, seconds. */
export const startInLink = (u) => secondsOf((/[?&#](?:t|start)=([\dhms:]+)/.exec(String(u || '')) || [])[1]);

/** The playback rate for your speed against the filmed one, in YouTube's range, in 0.05 steps; 0 = pause (stopped). */
export function videoRate(kmh, filmedKmh) {
  if (kmh < 1.5) return 0; // stopped: pause; slower than a quarter of the filmed pace still plays, at 0.25×
  const want = kmh / Math.max(1, filmedKmh || 25);
  return Math.min(2, Math.max(0.25, Math.round(want * 20) / 20));
}

let api = null;
/** YouTube's IFrame API, loaded once. */
function loadApi() {
  return api ||= new Promise((resolve, reject) => {
    if (window.YT?.Player) { resolve(window.YT); return; }
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(window.YT); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { api = null; reject(new Error('YouTube could not be reached')); };
    document.head.appendChild(s);
  });
}

/** What a YouTube player error means, for the rider. */
export function videoError(code) {
  return {
    2: 'The link has no valid video id.',
    5: 'The browser cannot play this video.',
    100: 'The video is gone or private.',
    101: 'The author does not allow this video to play outside YouTube.',
    150: 'The author does not allow this video to play outside YouTube.',
    153: 'YouTube refused the player (configuration): reload the page.',
  }[code] || `YouTube could not play the video (error ${code}).`;
}

/** Subtitles off: the captions module unloaded (not in the documented API, but what the player honours). */
function noCaptions(p) {
  try { p.unloadModule?.('captions'); p.unloadModule?.('cc'); p.setOption?.('captions', 'track', {}); } catch { /* not there */ }
}

/** A video playing in el (a container), kept in step with your speed by follow(). */
export class VideoRide {
  constructor(el, video, { onEnd = () => {}, onError = () => {} } = {}) {
    this.el = el; this.video = video; this.onEnd = onEnd; this.onError = onError; this.rate = 0; this.player = null; this.ended = false;
  }

  async start() {
    const YT = await loadApi();
    // the iframe made here, not by the API: with the page's origin and a referrer policy that sends it, as YouTube
    // now requires (without them: «Error 153, video player configuration error»)
    const q = new URLSearchParams({ enablejsapi: '1', origin: location.origin, start: String(Math.floor(this.video.start || 0)), autoplay: '1', mute: '1',
      controls: '1', disablekb: '1', rel: '0', playsinline: '1', iv_load_policy: '3', cc_load_policy: '0', modestbranding: '1' });
    const f = document.createElement('iframe');
    f.src = `https://www.youtube.com/embed/${encodeURIComponent(this.video.yt)}?${q}`;
    f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    f.referrerPolicy = 'strict-origin-when-cross-origin';
    f.title = this.video.name || 'YouTube';
    this.el.innerHTML = '';
    this.el.appendChild(f);
    await new Promise((resolve, reject) => {
      this.player = new YT.Player(f, {
        events: {
          onReady: (e) => { e.target.mute(); noCaptions(e.target); e.target.playVideo(); resolve(); },
          onStateChange: (e) => {
            if (e.data === 1) noCaptions(e.target);
            if (e.data === 0 && !this.ended) { this.ended = true; this.onEnd(); }
          },
          onApiChange: (e) => noCaptions(e.target),
          onError: (e) => { const err = new Error(videoError(e.data)); err.code = e.data; this.failed = true; this.onError(err); reject(err); },
        },
      });
    });
  }

  /** Your speed (km/h) and whether the ride is paused: the video's rate, play or pause. */
  follow(kmh, paused) {
    const p = this.player;
    if (!p?.getPlayerState || this.ended || this.failed) return;
    const rate = paused ? 0 : videoRate(kmh, this.video.kmh);
    const state = p.getPlayerState();
    if (!rate) { if (state === 1) p.pauseVideo(); this.rate = 0; return; }
    if (state !== 1 && state !== 3) p.playVideo();
    if (Math.abs(rate - this.rate) >= 0.05) { p.setPlaybackRate(rate); this.rate = rate; }
  }

  destroy() {
    try { this.player?.destroy(); } catch { /* gone */ }
    this.player = null;
    this.el.innerHTML = '';
  }
}
