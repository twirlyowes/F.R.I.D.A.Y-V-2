/**
 * AutoMod + Anti-Nuke settings, stored per server in Firestore:
 *   protection_configs/{guildId}  ->  { automod: {...}, antinuke: {...} }
 *
 * Settings only change when an admin presses a button, so writes are rare.
 * Reads come from an in-memory cache, so the message/audit hot paths are cheap.
 */
const db = require("../firebase");

const COLLECTION = "protection_configs";

const AUTOMOD_DEFAULTS = Object.freeze({
  // Master switch for the AutoMod rules (the bad-word filter has its own switch).
  enabled: false,
  rules: {
    spam: true,
    duplicates: true,
    mentions: true,
    emojis: true,
    invites: true,
    links: false,
    caps: false,
    badwords: false
  },
  // "log" = only report, "delete" = remove the message, "timeout" = remove + timeout
  action: "log",
  timeoutMinutes: 2,
  // How many messages in 5 seconds count as spam: low = 15, medium = 8, high = 5
  spamSensitivity: "low",
  ignoredChannels: [],
  ignoredRoles: []
});

const ANTINUKE_DEFAULTS = Object.freeze({
  enabled: false,
  protections: {
    channelDelete: true,
    channelCreate: true,
    roleDelete: true,
    roleCreate: true,
    ban: true,
    kick: true,
    webhook: true,
    botAdd: true,
    rolePerms: true
  },
  // What happens to the person who triggers it: "strip" roles, "kick" or "ban"
  punishment: "strip",
  // Mass actions allowed inside the window before the punishment fires
  threshold: 5,
  windowSeconds: 10,
  // Re-create channels/roles the offender deleted (and remove what they spammed)
  restore: true,
  trusted: []
});

const MAX_LIST = 50;

const clone = value => JSON.parse(JSON.stringify(value));

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(v => typeof v === "string" && /^\d{17,20}$/.test(v)))].slice(0, MAX_LIST);
}

/** Defaults first, then whatever was stored, so new settings appear with their defaults. */
function merge(defaults, stored) {
  const out = clone(defaults);
  if (!stored || typeof stored !== "object") return out;

  for (const key of Object.keys(out)) {
    if (!(key in stored)) continue;

    if (out[key] && typeof out[key] === "object" && !Array.isArray(out[key])) {
      if (stored[key] && typeof stored[key] === "object") {
        out[key] = { ...out[key], ...stored[key] };
      }
    } else {
      out[key] = stored[key];
    }
  }

  return out;
}

function sanitizeAutomod(cfg) {
  cfg.ignoredChannels = stringList(cfg.ignoredChannels);
  cfg.ignoredRoles = stringList(cfg.ignoredRoles);
  if (!["log", "delete", "timeout"].includes(cfg.action)) cfg.action = AUTOMOD_DEFAULTS.action;
  if (!["low", "medium", "high"].includes(cfg.spamSensitivity)) cfg.spamSensitivity = "low";
  if (!(cfg.timeoutMinutes > 0)) cfg.timeoutMinutes = AUTOMOD_DEFAULTS.timeoutMinutes;
  return cfg;
}

function sanitizeAntinuke(cfg) {
  cfg.trusted = stringList(cfg.trusted);
  if (!["strip", "kick", "ban"].includes(cfg.punishment)) cfg.punishment = "strip";
  if (!(cfg.threshold >= 2)) cfg.threshold = ANTINUKE_DEFAULTS.threshold;
  if (!(cfg.windowSeconds > 0)) cfg.windowSeconds = ANTINUKE_DEFAULTS.windowSeconds;
  return cfg;
}

const cache = new Map(); // guildId -> { automod, antinuke }
const cacheFetchedAt = new Map();
const pendingLoads = new Map();
const nextRetryAt = new Map();
const CACHE_TTL_MS = 30 * 1000;
const ERROR_RETRY_MS = 5 * 1000;

async function load(guildId) {
  const now = Date.now();
  const cached = cache.get(guildId);
  const fetchedAt = cacheFetchedAt.get(guildId) || 0;
  if (cached && now - fetchedAt < CACHE_TTL_MS) return cached;
  if ((nextRetryAt.get(guildId) || 0) > now) {
    return cached || {
      automod: sanitizeAutomod(clone(AUTOMOD_DEFAULTS)),
      antinuke: sanitizeAntinuke(clone(ANTINUKE_DEFAULTS))
    };
  }
  if (pendingLoads.has(guildId)) return pendingLoads.get(guildId);

  const task = (async () => {
    let stored = {};

    try {
      const doc = await db.collection(COLLECTION).doc(guildId).get();
      if (doc.exists) stored = doc.data() || {};
    } catch (error) {
      console.error(`[Protection] Failed to load ${guildId}:`, error);
      // Back off failed reads so high-volume message/audit events do not hammer Firestore.
      nextRetryAt.set(guildId, Date.now() + ERROR_RETRY_MS);
      // Keep the last known good settings if Firestore is temporarily unavailable.
      return cached || {
        automod: sanitizeAutomod(clone(AUTOMOD_DEFAULTS)),
        antinuke: sanitizeAntinuke(clone(ANTINUKE_DEFAULTS))
      };
    }

    nextRetryAt.delete(guildId);
    const entry = {
      automod: sanitizeAutomod(merge(AUTOMOD_DEFAULTS, stored.automod)),
      antinuke: sanitizeAntinuke(merge(ANTINUKE_DEFAULTS, stored.antinuke))
    };

    cache.set(guildId, entry);
    cacheFetchedAt.set(guildId, Date.now());
    return entry;
  })();

  pendingLoads.set(guildId, task);
  try {
    return await task;
  } finally {
    if (pendingLoads.get(guildId) === task) pendingLoads.delete(guildId);
  }
}

async function persist(guildId, section, value) {
  await db.collection(COLLECTION).doc(guildId).set({ [section]: value }, { merge: true });
}

async function getAutomod(guildId) {
  return (await load(guildId)).automod;
}

async function getAntinuke(guildId) {
  return (await load(guildId)).antinuke;
}

/** Copy -> change -> validate -> save. `change` may mutate the copy or return a replacement. */
async function updateAutomod(guildId, change) {
  const entry = await load(guildId);
  const next = clone(entry.automod);
  const replaced = change(next);
  const final = sanitizeAutomod(replaced || next);

  await persist(guildId, "automod", final);
  cache.set(guildId, { ...entry, automod: final });
  cacheFetchedAt.set(guildId, Date.now());
  nextRetryAt.delete(guildId);
  return final;
}

async function updateAntinuke(guildId, change) {
  const entry = await load(guildId);
  const next = clone(entry.antinuke);
  const replaced = change(next);
  const final = sanitizeAntinuke(replaced || next);

  await persist(guildId, "antinuke", final);
  cache.set(guildId, { ...entry, antinuke: final });
  cacheFetchedAt.set(guildId, Date.now());
  nextRetryAt.delete(guildId);
  return final;
}

function invalidate(guildId) {
  cache.delete(guildId);
  cacheFetchedAt.delete(guildId);
  nextRetryAt.delete(guildId);
  pendingLoads.delete(guildId);
}

module.exports = {
  AUTOMOD_DEFAULTS,
  ANTINUKE_DEFAULTS,
  getAutomod,
  getAntinuke,
  updateAutomod,
  updateAntinuke,
  invalidate,
  clone
};
