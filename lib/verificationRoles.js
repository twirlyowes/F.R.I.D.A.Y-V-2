const { ChannelType, PermissionFlagsBits, PermissionsBitField } = require("discord.js");

const TRACKING_KEY = "__unverifiedRoleSnapshot";
const REASON = "F.R.I.D.A.Y verification role access rules";

const LOCKED_OVERWRITES = Object.freeze({
  ViewChannel: false,
  SendMessages: false,
  Connect: false,
  Speak: false,
  AddReactions: false,
  SendMessagesInThreads: false,
  CreatePublicThreads: false,
  CreatePrivateThreads: false
});

// Unverified members can see the verification panel but cannot chat in that channel.
const VERIFICATION_OVERWRITES = Object.freeze({
  ViewChannel: true,
  ReadMessageHistory: true,
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

function serializeOverwrite(overwrite) {
  if (!overwrite) return null;
  return {
    allow: overwrite.allow.bitfield.toString(),
    deny: overwrite.deny.bitfield.toString()
  };
}

function getConfigModule(options = {}) {
  // Lazy-loaded to keep this helper unit-testable without a production Firebase key.
  return options.guildConfig || require("./guildConfig");
}

async function resolveRole(guild, roleOrId) {
  const id = typeof roleOrId === "string" ? roleOrId : roleOrId?.id;
  if (!id) return null;
  return (guild.roles.cache.get(id) || await guild.roles.fetch(id).catch(() => null));
}

async function resolveChannel(guild, channelId) {
  if (!channelId) return null;
  return (guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null));
}

async function replaceOverwrite(channel, roleOrId, saved, reason = REASON) {
  const roleId = typeof roleOrId === "string" ? roleOrId : roleOrId.id;
  if (channel.permissionOverwrites.cache.get(roleId)) {
    await channel.permissionOverwrites.delete(roleOrId, reason);
  }
  if (!saved) return;

  const allow = new PermissionsBitField(BigInt(saved.allow || "0")).toArray();
  const deny = new PermissionsBitField(BigInt(saved.deny || "0")).toArray();
  if (!allow.length && !deny.length) return;

  await channel.permissionOverwrites.create(roleOrId, { allow, deny }, reason);
}

/**
 * Enforces the verification-gate preset on the Unverified role only.
 *
 * Existing role permissions and per-channel overwrites are snapshotted once,
 * allowing Setup Clear / Clear All to restore the role to its previous state.
 * The Verified role and @everyone are never edited by this helper.
 */
async function configureUnverifiedRole(guild, roleOrId, verificationChannelId = null, options = {}) {
  const guildConfig = getConfigModule(options);
  if (!guild) throw new Error("A Discord server is required.");

  const cfg = await guildConfig.get(guild.id);
  const role = await resolveRole(guild, roleOrId);
  if (!role || role.guild?.id !== guild.id) throw new Error("I couldn't find the Unverified role in this server.");
  if (role.id === guild.id || role.managed) throw new Error("Unverified must be a normal server role, not @everyone or a managed integration role.");
  if (role.id === cfg.verifiedRole) throw new Error("Verified and Unverified must be different roles. The Verified role will be left unchanged.");
  if (role.id === cfg.quarantineRole) throw new Error("Unverified cannot also be the Anti-Nuke Quarantine role.");

  const verifyId = verificationChannelId || cfg.verifyChannel;
  const verifyChannel = await resolveChannel(guild, verifyId);
  if (!verifyChannel || !verifyChannel.isTextBased?.() || verifyChannel.isThread?.()) {
    throw new Error("Configure a valid text verification channel first. Unverified members must retain access to the verification panel.");
  }

  const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    throw new Error("I need **Manage Roles** to remove server-wide permissions from Unverified.");
  }
  if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
    throw new Error("I need **Manage Channels** to restrict Unverified in server channels.");
  }
  if (!role.editable) {
    throw new Error("FRIDAY's highest role must be above the Unverified role. Move FRIDAY's role higher and try again.");
  }

  try {
    await guild.channels.fetch();
  } catch (error) {
    throw new Error("I couldn't load the server's channels to apply the Unverified restrictions: " + String(error.message || "Discord request failed"));
  }

  const channels = [...guild.channels.cache.values()].filter(isOverwritable);
  if (!channels.some(channel => channel.id === verifyChannel.id)) channels.push(verifyChannel);

  const previousSnapshot = cfg[TRACKING_KEY]?.roleId === role.id
    ? cfg[TRACKING_KEY]
    : null;
  const snapshot = {
    roleId: role.id,
    rolePermissions: previousSnapshot?.rolePermissions ?? role.permissions.bitfield.toString(),
    channelOverwrites: { ...(previousSnapshot?.channelOverwrites || {}) }
  };

  // Capture the original overwrite for newly encountered channels without replacing
  // the baseline on subsequent reconfigurations.
  const rollbackState = new Map();
  for (const channel of channels) {
    rollbackState.set(channel.id, serializeOverwrite(channel.permissionOverwrites.cache.get(role.id)));
    if (!Object.prototype.hasOwnProperty.call(snapshot.channelOverwrites, channel.id)) {
      snapshot.channelOverwrites[channel.id] = serializeOverwrite(channel.permissionOverwrites.cache.get(role.id));
    }
  }

  const rolePermissionsBefore = role.permissions.bitfield.toString();
  const changedChannels = [];
  await guildConfig.setInternal(guild.id, TRACKING_KEY, snapshot);

  try {
    if (role.permissions.bitfield !== 0n) {
      await role.setPermissions(0n, REASON + ": remove server-wide permissions");
    }

    for (const channel of channels) {
      changedChannels.push(channel);
      const overwrite = channel.id === verifyChannel.id ? VERIFICATION_OVERWRITES : LOCKED_OVERWRITES;
      await channel.permissionOverwrites.edit(role, overwrite, { reason: REASON + (channel.id === verifyChannel.id
        ? ": allow viewing the verification panel only"
        : ": deny access outside verification") });
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const channel of changedChannels.reverse()) {
      try {
        await replaceOverwrite(channel, role, rollbackState.get(channel.id), REASON + ": roll back incomplete setup");
      } catch (rollbackError) {
        rollbackErrors.push((channel.name || channel.id) + ": " + String(rollbackError.message || "rollback failed"));
      }
    }
    try {
      if (role.permissions.bitfield.toString() !== rolePermissionsBefore) {
        await role.setPermissions(BigInt(rolePermissionsBefore), REASON + ": roll back incomplete setup");
      }
    } catch (rollbackError) {
      rollbackErrors.push("role permissions: " + String(rollbackError.message || "rollback failed"));
    }
    await guildConfig.setInternal(guild.id, TRACKING_KEY, previousSnapshot || null).catch(rollbackError => {
      rollbackErrors.push("snapshot: " + String(rollbackError.message || "rollback failed"));
    });

    const suffix = rollbackErrors.length
      ? " Rollback was incomplete: " + rollbackErrors.slice(0, 4).join("; ") + ". Check FRIDAY's permissions before retrying."
      : " Previous permissions were restored.";
    throw new Error("Could not safely configure Unverified: " + String(error.message || "Discord request failed") + "." + suffix);
  }

  return { role, configuredChannels: channels.length, verificationChannel: verifyChannel };
}

async function applyToChannel(guild, channel, roleId = null, options = {}) {
  const guildConfig = getConfigModule(options);
  if (!guild || !channel || !isOverwritable(channel) || channel.isThread?.()) return false;
  const cfg = await guildConfig.get(guild.id);
  const id = roleId || cfg.unverifiedRole;
  if (!id || !cfg.verifyChannel) return false;

  const role = await resolveRole(guild, id);
  if (!role || role.id === guild.id || role.managed) return false;
  const overwrite = channel.id === cfg.verifyChannel ? VERIFICATION_OVERWRITES : LOCKED_OVERWRITES;
  await channel.permissionOverwrites.edit(role, overwrite, {
    reason: REASON + (channel.id === cfg.verifyChannel
      ? ": keep verification accessible to Unverified members"
      : ": restrict newly created channel")
  });
  return true;
}

/**
 * Restores the original role permissions and channel overwrites captured by
 * configureUnverifiedRole. A missing snapshot is a no-op for older configs.
 */
async function restoreUnverifiedRole(guild, roleId = null, options = {}) {
  const guildConfig = getConfigModule(options);
  if (!guild) throw new Error("A Discord server is required.");
  const cfg = await guildConfig.get(guild.id);
  const snapshot = cfg[TRACKING_KEY];
  if (!snapshot?.roleId || (roleId && snapshot.roleId !== String(roleId))) {
    return { restored: false, restoredChannels: 0 };
  }

  const role = await resolveRole(guild, snapshot.roleId);
  try {
    await guild.channels.fetch();
  } catch (error) {
    throw new Error("I couldn't load channels to restore Unverified's previous permissions: " + String(error.message || "Discord request failed"));
  }

  const failures = [];
  let restoredChannels = 0;
  for (const [channelId, original] of Object.entries(snapshot.channelOverwrites || {})) {
    const channel = guild.channels.cache.get(channelId);
    if (!channel || !isOverwritable(channel)) continue;
    try {
      await replaceOverwrite(channel, role || snapshot.roleId, original, REASON + ": restore previous Unverified access");
      restoredChannels++;
    } catch (error) {
      failures.push((channel.name || channelId) + ": " + String(error.message || "restore failed"));
    }
  }

  if (failures.length) {
    throw new Error("Could not restore Unverified permissions in " + failures.length + " channel(s): " + failures.slice(0, 4).join("; ") + ". The restore snapshot was kept so this can be retried.");
  }

  if (role && snapshot.rolePermissions !== undefined && role.editable) {
    await role.setPermissions(BigInt(snapshot.rolePermissions), REASON + ": restore original server-wide permissions");
  }
  await guildConfig.setInternal(guild.id, TRACKING_KEY, null);
  return { restored: true, restoredChannels };
}

/**
 * Saves verification settings while preserving the invariant that Unverified
 * can reach the verification channel and Verified retains its normal permissions.
 * Returns true if this helper handled the setting; false otherwise.
 */
async function saveVerificationSetting(guild, key, value, options = {}) {
  if (!["verifyChannel", "verifiedRole", "unverifiedRole"].includes(key)) return false;
  const guildConfig = getConfigModule(options);
  const id = typeof value === "string" ? value : value?.id;
  if (!id) throw new Error("Select a valid Discord resource first.");

  const cfg = await guildConfig.get(guild.id);

  if (key === "verifiedRole") {
    if (id === cfg.unverifiedRole) throw new Error("Verified and Unverified must be different roles. The Unverified role is already configured.");
    if (id === cfg.quarantineRole) throw new Error("The Verified role cannot be the Anti-Nuke Quarantine role.");
    // Intentionally do not change role permissions or channel overwrites for Verified.
    await guildConfig.set(guild.id, key, id);
    return true;
  }

  if (key === "verifyChannel") {
    if (cfg.unverifiedRole) {
      await configureUnverifiedRole(guild, cfg.unverifiedRole, id, options);
      try {
        await guildConfig.set(guild.id, key, id);
      } catch (error) {
        await configureUnverifiedRole(guild, cfg.unverifiedRole, cfg.verifyChannel, options).catch(rollbackError => {
          console.error("[Verification Roles] Could not restore the previous verification channel:", rollbackError);
        });
        throw error;
      }
    } else {
      await guildConfig.set(guild.id, key, id);
    }
    return true;
  }

  if (id === cfg.verifiedRole) throw new Error("Verified and Unverified must be different roles.");
  if (id === cfg.quarantineRole) throw new Error("Unverified cannot also be the Anti-Nuke Quarantine role.");

  const previousRoleId = cfg.unverifiedRole && cfg.unverifiedRole !== id ? String(cfg.unverifiedRole) : null;
  if (previousRoleId) await restoreUnverifiedRole(guild, previousRoleId, options);

  try {
    await configureUnverifiedRole(guild, id, cfg.verifyChannel, options);
    await guildConfig.set(guild.id, key, id);
    return true;
  } catch (error) {
    await restoreUnverifiedRole(guild, id, options).catch(rollbackError => {
      console.error("[Verification Roles] Could not restore the new Unverified role after a failed save:", rollbackError);
    });
    if (previousRoleId && cfg.verifyChannel) {
      await configureUnverifiedRole(guild, previousRoleId, cfg.verifyChannel, options).catch(rollbackError => {
        console.error("[Verification Roles] Could not re-apply the previous Unverified role:", rollbackError);
      });
    }
    throw error;
  }
}

module.exports = {
  LOCKED_OVERWRITES,
  VERIFICATION_OVERWRITES,
  configureUnverifiedRole,
  applyToChannel,
  restoreUnverifiedRole,
  saveVerificationSetting
};