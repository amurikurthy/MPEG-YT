'use strict';
const crypto = require('crypto');
const { TTLCache } = require('../util/cache');

/**
 * SponsorBlock (sponsor.ajay.app): crowd-sourced timestamps of sponsor reads and
 * self-promotion inside videos, so the player can skip them. Lookups use the
 * privacy-preserving hash-prefix endpoint: only the first 4 hex characters of the
 * video ID's SHA-256 are sent, never the ID itself.
 */
class SponsorBlock {
  constructor(config) {
    this.cfg = config.sponsorblock;
    this.cache = new TTLCache({ ttlMs: 60 * 60_000, max: 2000 });
  }

  async segments(id) {
    if (!this.cfg.enabled || !/^[\w-]{11}$/.test(id)) return [];
    return this.cache.wrap(id, async () => {
      const prefix = crypto.createHash('sha256').update(id).digest('hex').slice(0, 4);
      const q = `categories=${encodeURIComponent(JSON.stringify(this.cfg.categories))}&actionTypes=${encodeURIComponent('["skip"]')}`;
      const res = await fetch(`${this.cfg.api}/api/skipSegments/${prefix}?${q}`, { signal: AbortSignal.timeout(5000) });
      if (res.status === 404) return []; // no segments for any video with this prefix
      if (!res.ok) throw new Error(`SponsorBlock HTTP ${res.status}`);
      const list = await res.json();
      const v = (Array.isArray(list) ? list : []).find((x) => x.videoID === id);
      return (v?.segments || [])
        .filter((s) => Array.isArray(s.segment) && s.segment[1] - s.segment[0] >= 1)
        .map((s) => ({ start: s.segment[0], end: s.segment[1], category: s.category }))
        .sort((a, b) => a.start - b.start);
    }).catch(() => []); // never block playback on SponsorBlock
  }
}

module.exports = { SponsorBlock };
