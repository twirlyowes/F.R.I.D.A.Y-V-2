/**
 * Per-server configuration, stored in Firestore: guild_configs/{guildId}
 *
 * Every module reads its channels/roles from here instead of hardcoded IDs.
 * Server admins set values with the `.config` command (see settings.js).
 */
const db = require("../firebase");

const COLLECTION = "guild_configs";

// Hidden legacy keys are accepted only for cleanup / historic ModMail tickets.
// They are intentionally omitted from SETTINGS so admins see one Support Role.
const LEGACY_SETTING_TYPES = {
  supportMinecraft: "role",
  supportDiscord: "role",
  supportOthers: "role"
};

/**
 * type: "text" | "voice" | "category" | "role" | "string"
 * Each key is one setting a server admin can configure.
 */
const SETTINGS = {
  prefix: {
    type: "string",
    label: "Command Prefix",
    description: "Prefix for every command (default `.`, max 5 characters, no spaces)"
  },
  ipMessage: {
    type: "string",
    label: "IP Command Message",
    description: "Text the `ip` command replies with (e.g. your server address)"
  },
  logs: {
    type: "text",
    label: "Mod Logs",
    description: "Moderation, filter, verification and daily staff-report logs"
  },
  staffRole: {
    type: "role",
    label: "Staff Role",
    description: "Can use moderation commands; tracked by Active Time"
  },
  activityRole: {
    type: "role",
    label: "Active Time Role",
    description: "Members with this role are tracked by Active Time (defaults to the Staff Role)"
  },
  atlogsRole: {
    type: "role",
    label: "Activity Logs Role",
    description: "Can view/manage Active Time logs"
  },
  verifyChannel: {
    type: "text",
    label: "Verify Channel",
    description: "Channel where the verification panel is posted"
  },
  verifiedRole: {
    type: "role",
    label: "Verified Role",
    description: "Given to members when they verify"
  },
  unverifiedRole: {
    type: "role",
    label: "Unverified Role",
    description: "Removed from members when they verify (optional)"
  },
  voiceCreate: {
    type: "voice",
    label: "Join-to-Create Channel",
    description: "Joining this voice channel creates a personal room"
  },
  voiceCategory: {
    type: "category",
    label: "Voice Category",
    description: "Category where personal voice rooms are created (optional)"
  },
  ticketCategory: {
    type: "category",
    label: "ModMail Category",
    description: "Category where numbered ModMail tickets are created"
  },
  ticketLogs: {
    type: "text",
    label: "ModMail Logs",
    description: "Where ModMail transcripts and ticket activity logs are sent"
  },
  supportRole: {
    type: "role",
    label: "Support Role",
    description: "The one staff role that can manage all ModMail tickets"
  },
  slowmodeChannel: {
    type: "text",
    label: "Auto-Slowmode Channel",
    description: "Channel that gets automatic slowmode during bursts"
  },
  youtubeChannel: {
    type: "text",
    label: "YouTube Notifications",
    description: "Channel for new-upload announcements"
  },
  youtubeUrl: {
    type: "string",
    label: "YouTube Channel URL",
    description: "e.g. https://www.youtube.com/@name (used with the notifications channel)"
  },
  quarantineRole: {
    type: "role",
    label: "Anti-Nuke Quarantine Role",
    description: "Role assigned to untrusted users who trigger Anti-Nuke; configured with no server-wide permissions and channel access denied"
  }
};

const cache = new Map();
const cacheFetchedAt = new Map();
// Dashboard edits are written directly to Firestore by the trusted dashboard
// backend. Refresh active guild configs periodically so the running bot picks
// up those edits without requiring a restart. A 30s TTL bounds extra reads.
const CACHE_TTL_MS = 30 * 1000;

async function get(guildId) {
  if (!guildId) return {};
  const cached = cache.get(guildId);
  const fetchedAt = cacheFetchedAt.get(guildId) || 0;
  if (cached && Date.now() - fetchedAt < CACHE_TTL_MS) return cached;

  try {
    const doc = await db.collection(COLLECTION).doc(guildId).get();
    const data = doc.exists ? (doc.data() || {}) : {};
    cache.set(guildId, data);
    cacheFetchedAt.set(guildId, Date.now());
    return data;
  } catch (error) {
    console.error(`[GuildConfig] Failed to load ${guildId}:`, error);
    // Preserve the last known good configuration during a transient Firestore
    // failure instead of unexpectedly treating the guild as unconfigured.
    return cached || {};
  }
}

async function set(guildId, key, value) {
  if (!SETTINGS[key]) throw new Error(`Unknown setting: ${key}`);
  const current = await get(guildId);
  const next = { ...current, [key]: value };
  await db.collection(COLLECTION).doc(guildId).set(next, { merge: true });
  cache.set(guildId, next);
  cacheFetchedAt.set(guildId, Date.now());
  return next;
}

/**
 * Update private setup metadata on the same guild-config document without
 * exposing internal keys in the admin-facing SETTINGS menu.
 */
async function setInternal(guildId, key, value) {
  if (!["__setupCreated", "__setupAllCreated", "__setupAllAssigned"].includes(key)) {
    throw new Error("Unknown internal config key: " + key);
  }
  const current = await get(guildId);
  const next = { ...current, [key]: value };
  await db.collection(COLLECTION).doc(guildId).set({ [key]: value }, { merge: true });
  cache.set(guildId, next);
  return next;
}

async function unset(guildId, key) {
  if (!SETTINGS[key] && !LEGACY_SETTING_TYPES[key]) throw new Error(`Unknown setting: ${key}`);
  const current = await get(guildId);
  const next = { ...current };
  delete next[key];
  await db.collection(COLLECTION).doc(guildId).set(next);
  cache.set(guildId, next);
  return next;
}

/**
 * Synchronous cache read for hot paths (presence/voice events).
 * Returns {} if the guild's config hasn't been loaded yet, so call
 * `await get(guildId)` for each guild at startup to warm it.
 */
function peek(guildId) {
  return cache.get(guildId) || {};
}

/** Sync version of isStaff() that relies on the warmed cache. */
function isStaffSync(member, key = "staffRole") {
  if (!member?.guild) return false;
  const roleId = peek(member.guild.id)[key];
  return Boolean(roleId && member.roles.cache.has(roleId));
}

/** All guild IDs that have a stored config (used by background jobs). */
async function listConfiguredGuildIds() {
  try {
    const snap = await db.collection(COLLECTION).get();
    return snap.docs.map(d => d.id);
  } catch (error) {
    console.error("[GuildConfig] Failed to list configs:", error);
    return [];
  }
}

function invalidate(guildId) {
  cache.delete(guildId);
  cacheFetchedAt.delete(guildId);
}

/** Resolve a stored channel ID to a live channel, or null. */
async function resolveChannel(guild, channelId) {
  if (!guild || !channelId) return null;
  return (
    guild.channels.cache.get(channelId) ||
    (await guild.channels.fetch(channelId).catch(() => null))
  );
}

/** Convenience: get the configured log channel for a guild (text-based) or null. */
async function getLogChannel(guild, key = "logs") {
  const cfg = await get(guild.id);
  const channel = await resolveChannel(guild, cfg[key]);
  return channel && channel.isTextBased() ? channel : null;
}

/** True if member has the configured staff role. False if none configured. */
async function isStaff(member, key = "staffRole") {
  if (!member?.guild) return false;
  const cfg = await get(member.guild.id);
  return Boolean(cfg[key] && member.roles.cache.has(cfg[key]));
}

module.exports = {
  SETTINGS,
  get,
  set,
  setInternal,
  unset,
  invalidate,
  peek,
  isStaffSync,
  listConfiguredGuildIds,
  resolveChannel,
  getLogChannel,
  isStaff
};
