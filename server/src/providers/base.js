'use strict';

/**
 * Provider contract
 * =================
 * A provider adapts one media platform (YouTube, a local folder, Plex, Jellyfin…)
 * to a small, normalized API. The UI and the streaming pipeline only ever talk
 * to this interface, so adding a platform means adding one file.
 *
 * Normalized shapes (plain JSON, sent to the browser):
 *
 *   Item = {
 *     kind: 'video' | 'collection',   // collection = channel / playlist / folder / library
 *     id: string,                      // opaque to the UI, unique within the provider
 *     title: string,
 *     subtitle?: string,               // channel / show / folder name
 *     subtitleRef?: { kind: 'collection', id: string },  // makes subtitle clickable
 *     thumbnail?: string,              // absolute URL or /api/p/<provider>/thumb/<id>
 *     duration?: number,               // seconds
 *     views?: number,
 *     published?: string,              // ISO date
 *     live?: boolean,
 *     variant?: string,                // UI hint: 'channel' | 'folder' | 'playlist' | 'show' ...
 *   }
 *
 *   Shelf  = { title: string, items: Item[], more?: { kind: 'search'|'collection', id: string } }
 *   Page   = { items: Item[], next?: string|number|null }
 *
 *   Detail = Item & {
 *     description?: string,
 *     qualities: number[],             // available output heights, e.g. [360, 480, 720, 1080]
 *     sourceFps?: number,              // highest source frame rate; UI offers output rates up to it
 *     seekable: boolean,
 *     likes?: number,
 *     extra?: Record<string, string>,  // free-form "label: value" facts shown under the title
 *   }
 *
 *   Media (from resolve(); server-side only — never sent to the browser) = {
 *     inputs: Array<{
 *       url: string,                   // anything ffmpeg can open: file path, http(s), hls...
 *       headers?: Record<string,string>,
 *       hasVideo: boolean,
 *       hasAudio: boolean,
 *       inputArgs?: string[],          // extra ffmpeg args placed before this -i
 *     }>,
 *     duration?: number,
 *     fps?: number,                    // source frame rate (output is snapped to 24/25/30)
 *     sourceHeight?: number,           // to avoid upscaling
 *     seekable: boolean,
 *     live?: boolean,
 *   }
 *
 * Only `item` and `resolve` are mandatory. Capabilities advertised to the UI
 * are derived from which optional methods a subclass overrides.
 */
class Provider {
  /** @param {object} config full app config  */
  constructor(config) {
    this.config = config;
  }

  /** Stable id used in URLs. Override as a static field. */
  static id = 'base';
  /** Human name for the UI. */
  static displayName = 'Base';

  get id() {
    return this.constructor.id;
  }

  /** One-time async setup (verify binaries, log in, warm caches). Throw to disable. */
  async init() {}

  /** @returns {Promise<Shelf[]>} */
  async home() {
    return [];
  }

  /** @returns {Promise<Page>} */
  async search(_query, _opts = {}) {
    throw notSupported('search');
  }

  /** @returns {Promise<string[]>} */
  async suggest(_query) {
    return [];
  }

  /** @returns {Promise<Detail>} */
  async item(_id) {
    throw notSupported('item');
  }

  /** @returns {Promise<Item[]>} */
  async related(_id) {
    return [];
  }

  /** @returns {Promise<{title: string, subtitle?: string, thumbnail?: string, items: Item[]}>} */
  async collection(_id) {
    throw notSupported('collection');
  }

  /**
   * Serve a thumbnail for `id` (only needed if Items point at /api/p/<id>/thumb/...).
   * @returns {Promise<{ body: Buffer|import('stream').Readable, type: string } | null>}
   */
  async thumbnail(_id) {
    return null;
  }

  // ---------- optional: accounts ----------
  // Implement account() to advertise sign-in support; the others as available.
  //   account()            -> { signedIn: boolean, methods: Array<'browser'|'cookies'> }
  //   startLogin()         -> BrowserLoginSession status (server-side sign-in browser)
  //   loginSession()       -> the active BrowserLoginSession, or null
  //   finishLogin() / cancelLogin()
  //   saveCookies(text)    -> account()   (upload a Netscape cookies.txt)
  //   signOut()            -> account()

  /**
   * Resolve a playable source for the transcoder.
   * @param {string} _id
   * @param {{height: number, fps: number}} _opts  requested output height / frame rate
   *   (providers may use fps to prefer high-frame-rate source formats)
   * @returns {Promise<Media>}
   */
  async resolve(_id, _opts) {
    throw notSupported('resolve');
  }

  describe() {
    const proto = Provider.prototype;
    const has = (m) => this[m] !== proto[m];
    const account = typeof this.account === 'function' ? this.account() : undefined;
    return {
      account,
      id: this.id,
      name: this.constructor.displayName,
      capabilities: {
        home: has('home'),
        search: has('search'),
        suggest: has('suggest'),
        related: has('related'),
        collections: has('collection'),
      },
    };
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function notSupported(what) {
  return new HttpError(404, `${what} is not supported by this provider`);
}

module.exports = { Provider, HttpError };
