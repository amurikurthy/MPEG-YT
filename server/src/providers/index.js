'use strict';
const path = require('path');

/**
 * Loads providers listed in config.providers. Each entry is either the name of a
 * built-in module in this directory ("youtube", "local") or an absolute path to
 * a module exporting a Provider subclass — so third-party providers (e.g. Plex)
 * can be mounted into the container without touching the core.
 */
class ProviderRegistry {
  constructor(config) {
    this.config = config;
    this.providers = new Map();
  }

  async load() {
    for (const name of this.config.providers) {
      const modPath = path.isAbsolute(name) ? name : path.join(__dirname, name);
      try {
        const Cls = require(modPath);
        const provider = new Cls(this.config);
        await provider.init();
        if (this.providers.has(provider.id)) throw new Error(`duplicate provider id "${provider.id}"`);
        this.providers.set(provider.id, provider);
        console.log(`[providers] enabled: ${provider.id}`);
      } catch (e) {
        console.warn(`[providers] "${name}" disabled: ${e.message}`);
      }
    }
    if (!this.providers.size) console.warn('[providers] no providers enabled');
  }

  get(id) {
    return this.providers.get(id);
  }

  list() {
    return [...this.providers.values()].map((p) => p.describe());
  }
}

module.exports = { ProviderRegistry };
