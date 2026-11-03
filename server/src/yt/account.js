'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { run } = require('../util/exec');
const { BrowserLoginSession } = require('../login/browser-session');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** True if a Netscape cookies.txt holds a signed-in YouTube session. */
function hasLoginCookies(text) {
  return /^(#HttpOnly_)?\.?(www\.)?youtube\.com\t.*\t(LOGIN_INFO|SAPISID|__Secure-3PAPISID)\t/m.test(text || '');
}

/**
 * The signed-in YouTube session: a cookies.txt in CONFIG_DIR, created either by the
 * in-app sign-in browser or by uploading one. Shared by InnerTube (feeds, actions)
 * and yt-dlp (stream URLs).
 */
class Account {
  constructor(config, { onChange } = {}) {
    this.config = config;
    this.onChange = onChange || (() => {});
    this.cookiesFile = config.youtube.cookiesFile || path.join(config.configDir, 'youtube-cookies.txt');
    this.profileDir = path.join(config.configDir, 'youtube-signin-browser');
    this.login = null;
    this.signedIn = false;
  }

  async init() {
    await fsp.mkdir(path.dirname(this.cookiesFile), { recursive: true }).catch(() => {});
    this.refresh(false);
    if (this.signedIn) console.log(`[account] signed in (cookies: ${this.cookiesFile})`);
  }

  readCookies() {
    try {
      return fs.readFileSync(this.cookiesFile, 'utf8');
    } catch {
      return '';
    }
  }

  refresh(notify = true) {
    const was = this.signedIn;
    this.signedIn = hasLoginCookies(this.readCookies());
    if (notify && was !== this.signedIn) this.onChange(this.signedIn);
    else if (notify) this.onChange(this.signedIn);
  }

  /** "name=value; ..." for youtube.com, as InnerTube expects in a Cookie header. */
  cookieHeader() {
    if (!this.signedIn) return '';
    const now = Date.now() / 1000;
    const pairs = new Map();
    for (const line of this.readCookies().split(/\r?\n/)) {
      if (!line || (line.startsWith('#') && !line.startsWith('#HttpOnly_'))) continue;
      const f = line.replace(/^#HttpOnly_/, '').split('\t');
      if (f.length < 7) continue;
      const [domain, , , , expires, name, value] = f;
      if (!/(^|\.)youtube\.com$/.test(domain)) continue;
      if (+expires && +expires < now) continue;
      pairs.set(name, value);
    }
    return [...pairs].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  status() {
    const methods = ['cookies'];
    if (this.config.login.enabled) methods.unshift('browser');
    return { signedIn: this.signedIn, methods, login: this.login ? this.login.status() : null };
  }

  // ---------- in-app sign-in ----------

  async startLogin() {
    if (!this.config.login.enabled) throw new HttpError(404, 'in-app sign-in is disabled (LOGIN_BROWSER=0)');
    if (this.login && ['starting', 'running', 'finishing'].includes(this.login.state)) return this.login.status();
    await fsp.rm(this.profileDir, { recursive: true, force: true }).catch(() => {});
    this.login = new BrowserLoginSession({
      config: this.config,
      url: 'https://accounts.google.com/ServiceLogin?service=youtube&hl=en&continue=' +
        encodeURIComponent('https://www.youtube.com/signin?action_handle_signin=true&next=%2Faccount'),
      profileDir: this.profileDir,
      // Google's sign-in pages are titled just "YouTube". The account page ("Account - YouTube")
      // is only reachable once signed in (signed-out visitors are bounced back to sign-in).
      doneTitle: /^.+ - YouTube$/,
      onDone: () => this.importBrowserCookies(),
    });
    return this.login.start();
  }

  loginSession() {
    return this.login;
  }

  async finishLogin() {
    if (!this.login) throw new HttpError(409, 'no sign-in in progress');
    return { ...(await this.login.finish()), account: this.status() };
  }

  async cancelLogin() {
    if (this.login) await this.login.cancel();
    this.login = null;
    return this.status();
  }

  /** Pull cookies out of the sign-in browser's profile via yt-dlp. */
  async importBrowserCookies() {
    const tmp = `${this.cookiesFile}.import`;
    await fsp.rm(tmp, { force: true });
    // Loading from the browser and saving with --cookies dumps the jar to a cookies.txt file.
    await run(this.config.bin.ytdlp, [
      '--ignore-config', '--no-warnings', '--js-runtimes', 'node',
      '--cookies-from-browser', `chromium+basictext:${this.profileDir}`,
      '--cookies', tmp, '--skip-download', '--flat-playlist', '--playlist-end', '1', ':ytrec',
    ], { timeoutMs: 90_000 }).catch((e) => console.warn(`[account] cookie import: ${e.message}`));
    const text = await fsp.readFile(tmp, 'utf8').catch(() => '');
    await fsp.rm(tmp, { force: true });
    if (!hasLoginCookies(text)) throw new Error('Sign-in was not completed - no YouTube session found.');
    await this.writeCookies(text);
  }

  async saveCookies(text) {
    if (typeof text !== 'string' || text.length > 1024 * 1024) throw new HttpError(400, 'invalid file');
    if (!hasLoginCookies(text)) {
      throw new HttpError(400, 'No signed-in YouTube session found in that file. Export cookies for youtube.com in Netscape (cookies.txt) format while signed in.');
    }
    await this.writeCookies(text);
    return this.status();
  }

  async writeCookies(text) {
    const keep = text.split(/\r?\n/).filter((line) => {
      if (!line || line.startsWith('# ')) return line.startsWith('# Netscape');
      const domain = line.replace(/^#HttpOnly_/, '').split('\t')[0];
      return /(^|\.)(youtube\.com|google\.com)$/.test(domain);
    });
    if (!keep[0] || !keep[0].startsWith('# Netscape')) keep.unshift('# Netscape HTTP Cookie File');
    await fsp.writeFile(this.cookiesFile, keep.join('\n') + '\n', { mode: 0o600 });
    this.refresh();
    console.log(`[account] signed in; cookies saved to ${this.cookiesFile}`);
  }

  async signOut() {
    if (this.login) await this.login.cancel();
    this.login = null;
    await fsp.rm(this.cookiesFile, { force: true });
    await fsp.rm(this.profileDir, { recursive: true, force: true }).catch(() => {});
    this.refresh();
    console.log('[account] signed out');
    return this.status();
  }
}

module.exports = { Account, HttpError, hasLoginCookies };
