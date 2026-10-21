/**
 * Per-server configuration, stored in Firestore: guild_configs/{guildId}
 *
 * Every module reads its channels/roles from here instead of hardcoded IDs.
 * Server admins set values with the `.config` command (see settings.js).
 */
const db = require("../firebase");

const COLLECTION = "guild_configs";

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
    label: "Ticket Category",
    description: "Category where support ticket channels are created"
  },
  ticketLogs: {
    type: "text",
    label: "Ticket Logs",
    description: "Where ticket transcripts/logs are sent"
  },
  supportMinecraft: {
    type: "role",
    label: "Minecraft Support Role",
    description: "Staff role for Minecraft tickets"
  },
  supportDiscord: {
    type: "role",
    label: "Discord Support Role",
    description: "Staff role for Discord tickets"
  },
  supportOthers: {
    type: "role",
    label: "Other Support Role",
    description: "Staff role for 'Others' tickets"
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

async function get(guildId) {
  if (!guildId) return {};
  if (cache.has(guildId)) return cache.get(guildId);

  let data = {};
  try {
    const doc = await db.collection(COLLECTION).doc(guildId).get();
    if (doc.exists) data = doc.data() || {};
  } catch (error) {
    console.error(`[GuildConfig] Failed to load ${guildId}:`, error);
    return {};
  }

  cache.set(guildId, data);
  return data;
}

async function set(guildId, key, value) {
  if (!SETTINGS[key]) throw new Error(`Unknown setting: ${key}`);
  const current = await get(guildId);
  const next = { ...current, [key]: value };
  await db.collection(COLLECTION).doc(guildId).set(next, { merge: true });
  cache.set(guildId, next);
  return next;
}

async function unset(guildId, key) {
  if (!SETTINGS[key]) throw new Error(`Unknown setting: ${key}`);
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
  unset,
  invalidate,
  peek,
  isStaffSync,
  listConfiguredGuildIds,
  resolveChannel,
  getLogChannel,
  isStaff
};
