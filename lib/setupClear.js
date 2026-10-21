const { ChannelType } = require("discord.js");
const guildConfig = require("./guildConfig");

const CREATED_KEY = "__setupCreated";

async function trackCreatedResource(guild, key, resource) {
  if (!guild || !key || !resource?.id || !guildConfig.SETTINGS[key]) return false;

  const cfg = await guildConfig.get(guild.id);
  const created = { ...(cfg[CREATED_KEY] || {}) };
  created[key] = {
    id: resource.id,
    type: guildConfig.SETTINGS[key].type,
    createdAt: Date.now()
  };
  await guildConfig.setInternal(guild.id, CREATED_KEY, created);
  return true;
}

async function untrackCreatedResource(guild, key) {
  const cfg = await guildConfig.get(guild.id);
  const created = { ...(cfg[CREATED_KEY] || {}) };
  if (!created[key]) return false;
  delete created[key];
  await guildConfig.setInternal(guild.id, CREATED_KEY, created);
  return true;
}

async function resolveResource(guild, key, id) {
  const type = guildConfig.SETTINGS[key]?.type;
  if (!id || !type) return null;

  if (type === "role") {
    return guild.roles.cache.get(String(id)) ||
      await guild.roles.fetch(String(id)).catch(() => null);
  }

  return guild.channels.cache.get(String(id)) ||
    await guild.channels.fetch(String(id)).catch(() => null);
}

async function deleteTrackedResource(guild, key, tracked) {
  if (!tracked?.id) return { deleted: false, reason: "No setup-created resource was recorded." };

  const resource = await resolveResource(guild, key, tracked.id);
  if (!resource) return { deleted: true, name: tracked.type === "role" ? "role" : "channel", alreadyMissing: true };

  try {
    if (tracked.type === "role") {
      await resource.delete("F.R.I.D.A.Y setup configuration cleared");
      return { deleted: true, name: "role" };
    }

    if (resource.type === ChannelType.GuildCategory) {
      await guild.channels.fetch().catch(() => null);
      const children = guild.channels.cache.filter(channel => channel.parentId === resource.id);
      if (children.size) {
        const examples = [...children.values()].slice(0, 3).map(channel => "`" + channel.name + "`");
        return {
          deleted: false,
          reason: "the category still contains " + children.size + " channel(s)" +
            (examples.length ? " (" + examples.join(", ") + ")" : "") + ". Empty it, then press Clear again to delete it."
        };
      }
    }

    if (resource.type === ChannelType.GuildVoice && resource.members?.size > 0) {
      return {
        deleted: false,
        reason: "people are still connected to the voice channel. They won't be disconnected; press Clear again once it is empty."
      };
    }

    await resource.delete("F.R.I.D.A.Y setup configuration cleared");
    return { deleted: true, name: "channel" };
  } catch (error) {
    return {
      deleted: false,
      reason: "Discord wouldn't let me delete the setup-created resource: " +
        String(error.message || "unknown error").slice(0, 250)
    };
  }
}

/**
 * Clears a setting and removes its Discord resource only when FRIDAY's setup
 * metadata proves the resource was created by the setup wizard.
 */
async function clearSetting(guild, key, options = {}) {
  const def = guildConfig.SETTINGS[key];
  if (!guild || !def) throw new Error("Unknown configuration setting: " + key);

  let cfg = await guildConfig.get(guild.id);
  let value = cfg[key];
  let tracked = cfg[CREATED_KEY]?.[key];
  const notes = [];

  // A configured voice category and its Join-to-Create channel are a pair.
  // Disable/clean the trigger channel first, never delete arbitrary category children.
  if (!options.skipVoiceCategoryCascade && key === "voiceCategory" && value && cfg.voiceCreate) {
    const trigger = await resolveResource(guild, "voiceCreate", cfg.voiceCreate);
    if (trigger?.parentId === String(value)) {
      const dependency = await clearSetting(guild, "voiceCreate", { skipVoiceCategoryCascade: true });
      notes.push(dependency.message);
      cfg = await guildConfig.get(guild.id);
      value = cfg[key];
      tracked = cfg[CREATED_KEY]?.[key];
    }
  }

  let cleanup = null;
  const valueMatchesTracked = tracked && (!value || String(value) === String(tracked.id));
  if (valueMatchesTracked) {
    cleanup = await deleteTrackedResource(guild, key, tracked);
    if (cleanup.deleted) {
      await untrackCreatedResource(guild, key);
    }
  } else if (tracked && value && String(value) !== String(tracked.id)) {
    // The configured resource was replaced manually; don't ever delete it
    // or confuse it with an older resource created by the wizard.
    await untrackCreatedResource(guild, key);
  }

  if (value) await guildConfig.unset(guild.id, key);

  const lines = [];
  if (value) {
    lines.push("Cleared the saved configuration for **" + def.label + "**.");
  } else if (tracked) {
    lines.push("**" + def.label + "** was already unconfigured; checking its previously setup-created resource.");
  } else {
    lines.push("**" + def.label + "** is already clear.");
  }

  if (cleanup?.deleted) {
    lines.push(cleanup.alreadyMissing
      ? "The setup-created resource was already missing."
      : "Deleted the setup-created " + cleanup.name + ".");
  } else if (cleanup?.reason) {
    lines.push("The saved configuration was cleared, but the setup-created resource was kept because " + cleanup.reason);
  } else if (value && !tracked) {
    if (def.type === "role" || ["text", "voice", "category"].includes(def.type)) {
      lines.push("The selected resource was left in place because FRIDAY cannot verify that the setup wizard created it.");
    }
  }

  if (notes.length) lines.push(...notes);
  return {
    cleared: true,
    deleted: Boolean(cleanup?.deleted),
    retained: Boolean(cleanup?.reason),
    message: lines.join("\n")
  };
}

module.exports = {
  trackCreatedResource,
  untrackCreatedResource,
  clearSetting
};
