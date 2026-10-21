/**
 * Shared quarantine helpers for setup, normal configuration, and Anti-Nuke.
 * The selected role receives no server-wide permissions and is denied channel access.
 */
const { PermissionFlagsBits, ChannelType } = require("discord.js");
const guildConfig = require("./guildConfig");

const REASON = "F.R.I.D.A.Y Anti-Nuke Quarantine";
const QUARANTINE_OVERWRITES = Object.freeze({
  ViewChannel: false,
  SendMessages: false,
  Connect: false,
  Speak: false,
  AddReactions: false,
  SendMessagesInThreads: false,
  CreatePublicThreads: false,
  CreatePrivateThreads: false
});

function isOverwritable(channel) {
  if (!channel || channel.isThread?.() || !channel.permissionOverwrites?.edit) return false;
  return channel.type === ChannelType.GuildCategory ||
    channel.isTextBased?.() === true ||
    channel.isVoiceBased?.() === true;
}

async function applyToChannel(guild, channel, roleId = null) {
  const id = roleId || (await guildConfig.get(guild.id)).quarantineRole;
  if (!id || !isOverwritable(channel)) return false;

  const role = guild.roles.cache.get(id) || await guild.roles.fetch(id).catch(() => null);
  if (!role) return false;

  await channel.permissionOverwrites.edit(role, QUARANTINE_OVERWRITES, {
    reason: REASON + ": keep quarantined members out of channels"
  });
  return true;
}

async function configureRole(guild, roleOrId) {
  const role = typeof roleOrId === "string"
    ? (guild.roles.cache.get(roleOrId) || await guild.roles.fetch(roleOrId).catch(() => null))
    : roleOrId;

  if (!role || role.guild.id !== guild.id) throw new Error("I couldn't find that role in this server.");
  if (role.id === guild.id || role.managed) throw new Error("The quarantine role must be a normal, manageable server role.");

  const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    throw new Error("I need **Manage Roles** to configure the Quarantine role.");
  }
  if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
    throw new Error("I need **Manage Channels** to restrict the Quarantine role in existing channels.");
  }
  if (!role.editable) {
    throw new Error("My highest role must be above the selected Quarantine role. Move FRIDAY's role higher and try again.");
  }

  // Existing roles are changed only after the admin explicitly chooses this preset.
  await role.setPermissions(0n, REASON + ": remove server-wide permissions");

  await guild.channels.fetch().catch(() => null);
  const channels = [...guild.channels.cache.values()].filter(isOverwritable);
  let configured = 0;
  const failures = [];

  for (const channel of channels) {
    try {
      await channel.permissionOverwrites.edit(role, QUARANTINE_OVERWRITES, {
        reason: REASON + ": restrict channel access"
      });
      configured++;
    } catch (error) {
      failures.push(channel.name || channel.id);
      console.warn("[Quarantine] Could not restrict #" + (channel.name || channel.id) + ":", error.message);
    }
  }

  if (failures.length) {
    throw new Error(
      "The role has no server-wide permissions, but I could restrict only " +
      configured + "/" + channels.length + " channels. Check my **Manage Channels** permission and channel-specific restrictions, then run setup again."
    );
  }

  return { role, configuredChannels: configured };
}

async function quarantineMember(guild, userId, roleId = null) {
  try {
    const cfg = await guildConfig.get(guild.id);
    const id = roleId || cfg.quarantineRole;
    if (!id) return { ok: false, text: "No Quarantine role is configured." };

    const role = guild.roles.cache.get(id) || await guild.roles.fetch(id).catch(() => null);
    if (!role) return { ok: false, text: "The configured Quarantine role no longer exists." };
    if (role.managed || !role.editable) {
      return { ok: false, text: "The Quarantine role is managed or above my highest role." };
    }

    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return { ok: false, text: "The nuke attempter is no longer in the server." };
    if (member.id === guild.ownerId) return { ok: false, text: "The server owner cannot be quarantined." };

    const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
    if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
      return { ok: false, text: "I am missing **Manage Roles**." };
    }
    if (!member.manageable) {
      return { ok: false, text: "The attempter's highest role is at or above my highest role." };
    }

    const removable = member.roles.cache.filter(
      roleItem => roleItem.id !== guild.id && roleItem.id !== role.id &&
        !roleItem.managed && roleItem.editable
    );
    if (removable.size) {
      await member.roles.remove([...removable.keys()], REASON + ": remove previous access and permissions");
    }

    if (!member.roles.cache.has(role.id)) {
      await member.roles.add(role, REASON);
    }

    const managedLeft = member.roles.cache.filter(
      roleItem => roleItem.id !== guild.id && roleItem.id !== role.id && roleItem.managed
    ).size;

    return {
      ok: true,
      text: "Quarantined with <@&" + role.id + ">; removed " + removable.size + " manageable role(s)" +
        (managedLeft ? "; " + managedLeft + " managed integration role(s) could not be removed" : "")
    };
  } catch (error) {
    console.error("[Quarantine] Failed to quarantine member:", error);
    return { ok: false, text: "Quarantine failed (" + error.message + ")" };
  }
}

module.exports = {
  QUARANTINE_OVERWRITES,
  configureRole,
  applyToChannel,
  quarantineMember
};
