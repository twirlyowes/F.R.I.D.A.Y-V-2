/**
 * Anti-Nuke: stops a compromised or rogue admin from wrecking the server.
 *
 *   <prefix>antinuke                  opens the control panel (SERVER OWNER only)
 *   <prefix>antinuke trust <@user>    add/remove a trusted user (SERVER OWNER only)
 *
 * It watches the audit log for mass channel/role deletion or creation, mass
 * bans and kicks, webhook creation, unapproved bots and role-permission grabs.
 * When someone who is not trusted crosses the threshold they are punished
 * (roles stripped, kicked or banned) and what they destroyed is put back.
 *
 * Never acted on: the server owner, this bot, and anyone on the trusted list.
 * Add your other bots (ticket bots, security bots, ...) to the trusted list.
 *
 * The bot needs "View Audit Log" for any of this to work. Keep the bot's role
 * ABOVE the roles it needs to manage, or punishments will fail.
 */
const {
  ActionRowBuilder,
  AuditLogEvent,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  UserSelectMenuBuilder
} = require("discord.js");

const guildConfig = require("./lib/guildConfig");
const quarantine = require("./lib/quarantine");
const protection = require("./lib/protection");
const owners = require("./lib/owners");
const serverOwners = require("./lib/serverOwners");
const { parseCommand } = require("./lib/prefix");
const { COLORS, createCard } = require("./lib/pixelVillaUI");
const {
  DANGEROUS_MEMBER_ROLE_PERMISSIONS: DANGEROUS,
  addedRoleIds: getAddedRoleIds,
  hasDangerousPermissions,
  isPermissionlessRole,
  missingQuarantineDenies
} = require("./lib/antinukeSecurity");

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------
const FEATURES = {
  channelDelete: { label: "Channel delete" },
  channelCreate: { label: "Channel create" },
  roleDelete: { label: "Role delete" },
  roleCreate: { label: "Role create" },
  ban: { label: "Bans" },
  kick: { label: "Kicks" },
  webhook: { label: "Webhooks" },
  botAdd: { label: "Bot add" },
  rolePerms: { label: "Role perms" },
  roleAssign: { label: "Role escalation" }
};

const PUNISHMENTS = ["strip", "kick", "ban"];
const PUNISHMENT_TEXT = { strip: "Strip roles", kick: "Kick", ban: "Ban" };
const THRESHOLDS = [3, 5, 10];

const ROLE_PERMS_LIMIT = 2; // permission grabs in the window before punishment
const PUNISH_COOLDOWN_MS = 60 * 1000;
const BOOK_KEEP_MS = 2 * 60 * 1000;
const BOOK_MAX = 200;
const AUDIT_AGE_MS = 15 * 1000;
const AUDIT_RETRY_MS = Number(process.env.ANTINUKE_AUDIT_RETRY_MS) || 1200;
const REASON = "F.R.I.D.A.Y Anti-Nuke";
const WATCHDOG_INTERVAL_MS = Math.max(60_000, Number(process.env.ANTINUKE_WATCHDOG_INTERVAL_MS) || 5 * 60 * 1000);

const BOT_PERMISSIONS = [
  ["ViewAuditLog", "View Audit Log"],
  ["ManageRoles", "Manage Roles"],
  ["ManageChannels", "Manage Channels"],
  ["KickMembers", "Kick Members"],
  ["BanMembers", "Ban Members"],
  ["ManageWebhooks", "Manage Webhooks"]
];

// ---------------------------------------------------------------------------
// In-memory tracking (never saved)
// ---------------------------------------------------------------------------
const hits = new Map(); // "guild:user:kind" -> [timestamps]
const book = new Map(); // "guild:user" -> what they deleted / created recently
const lastPunished = new Map(); // "guild:user" -> time
const seenEntries = new Set(); // audit entries already handled (webhooks)
const handledQuarantineAuditEntries = new Map(); // audit entry ID -> handling timestamp
const quarantineRoleRepairInFlight = new Set();
const quarantineChannelRepairInFlight = new Set();
const lastQuarantineChannelRepair = new Map();
const watchdogAlertState = new Map(); // guild ID -> last issue signature

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function cleanup() {
  const now = Date.now();

  for (const [key, list] of hits) {
    const fresh = list.filter(t => now - t < 5 * 60 * 1000);
    if (fresh.length) hits.set(key, fresh);
    else hits.delete(key);
  }

  for (const [key, entry] of book) {
    entry.channels = entry.channels.filter(e => now - e.ts < BOOK_KEEP_MS);
    entry.roles = entry.roles.filter(e => now - e.ts < BOOK_KEEP_MS);
    entry.createdChannels = entry.createdChannels.filter(e => now - e.ts < BOOK_KEEP_MS);
    entry.createdRoles = entry.createdRoles.filter(e => now - e.ts < BOOK_KEEP_MS);

    if (!entry.channels.length && !entry.roles.length && !entry.createdChannels.length && !entry.createdRoles.length) {
      book.delete(key);
    }
  }

  for (const [key, ts] of lastPunished) if (now - ts > PUNISH_COOLDOWN_MS * 5) lastPunished.delete(key);
  for (const [id, ts] of handledQuarantineAuditEntries) {
    if (now - ts > 60 * 1000) handledQuarantineAuditEntries.delete(id);
  }
  for (const [key, ts] of lastQuarantineChannelRepair) {
    if (now - ts > 60 * 1000) lastQuarantineChannelRepair.delete(key);
  }
  if (seenEntries.size > 500) seenEntries.clear();
}

function bookOf(guildId, userId) {
  const key = `${guildId}:${userId}`;

  if (!book.has(key)) {
    book.set(key, { channels: [], roles: [], createdChannels: [], createdRoles: [] });
  }

  return book.get(key);
}

function remember(list, item) {
  list.push({ ts: Date.now(), ...item });
  if (list.length > BOOK_MAX) list.shift();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function isTrusted(guild, cfg, userId) {
  return (
    userId === guild.ownerId ||
    userId === guild.client.user.id ||
    owners.isOwner(userId) ||
    await serverOwners.isOwner(guild.id, userId) ||
    cfg.trusted.includes(userId)
  );
}

/** Server owners and locally delegated owners can manage only this server. */
async function canManage(guild, userId) {
  return userId === guild.ownerId || owners.isOwner(userId) || await serverOwners.isOwner(guild.id, userId);
}

async function enabledFor(guild, kind) {
  const cfg = await protection.getAntinuke(guild.id);
  return cfg.enabled && cfg.protections[kind] ? cfg : null;
}

function avatarOf(client) {
  return client.user.displayAvatarURL({ extension: "png", size: 128 });
}

function who(user) {
  return `<@${user.id}> (\`${user.tag || user.username || user.id}\`)`;
}

/** Audit-log entries lag a little behind the event, so try twice. */
async function findAuditEntry(guild, type, targetId) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const logs = await guild.fetchAuditLogs({ type, limit: 6 });

      const entry = logs.entries.find(
        e => (e.targetId ?? e.target?.id) === targetId && Date.now() - e.createdTimestamp < AUDIT_AGE_MS
      );

      if (entry) return entry;
    } catch {
      return null; // no "View Audit Log" permission
    }

    if (attempt === 0) await sleep(AUDIT_RETRY_MS);
  }

  return null;
}

async function findRemovalEntry(guild, userId) {
  const types = [AuditLogEvent.MemberKick, AuditLogEvent.MemberBanAdd];

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const logs = await guild.fetchAuditLogs({ limit: 10 });

      const entry = logs.entries.find(
        e =>
          types.includes(e.action) &&
          (e.targetId ?? e.target?.id) === userId &&
          Date.now() - e.createdTimestamp < AUDIT_AGE_MS
      );

      if (entry) return entry;
    } catch {
      return null;
    }

    if (attempt === 0) await sleep(AUDIT_RETRY_MS);
  }

  return null;
}

function snapshotChannel(channel) {
  return {
    name: channel.name,
    type: channel.type,
    parentId: channel.parentId ?? null,
    topic: channel.topic ?? undefined,
    nsfw: channel.nsfw ?? undefined,
    rateLimitPerUser: channel.rateLimitPerUser ?? undefined,
    bitrate: channel.bitrate ?? undefined,
    userLimit: channel.userLimit ?? undefined,
    overwrites: channel.permissionOverwrites
      ? [...channel.permissionOverwrites.cache.values()].map(o => ({
          id: o.id,
          type: o.type,
          allow: o.allow.bitfield,
          deny: o.deny.bitfield
        }))
      : []
  };
}

function snapshotRole(role) {
  return {
    name: role.name,
    color: role.color,
    hoist: role.hoist,
    mentionable: role.mentionable,
    permissions: role.permissions.bitfield
  };
}

// ---------------------------------------------------------------------------
// Quarantine guard, permission escalation, configuration repair, and health
// ---------------------------------------------------------------------------

/**
 * Match the exact member-role audit entry to the changed role IDs. The target
 * and role IDs must agree; we never guess an actor from a recent unrelated edit.
 */
async function findMemberRoleAuditEntry(guild, targetId, addedIds, quarantineRemoved, quarantineRoleId) {
  const expectedAdds = new Set(addedIds);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const logs = await guild.fetchAuditLogs({
        type: AuditLogEvent.MemberRoleUpdate,
        limit: 10
      });
      const candidates = [...logs.entries.values()]
        .filter(entry =>
          (entry.targetId ?? entry.target?.id) === targetId &&
          Date.now() - entry.createdTimestamp < AUDIT_AGE_MS
        )
        .sort((a, b) => b.createdTimestamp - a.createdTimestamp);

      for (const entry of candidates) {
        const roleIdsFor = key => {
          const change = (entry.changes || []).find(item => item.key === key);
          if (!change) return [];
          const values = [change.new, change.old]
            .flatMap(value => Array.isArray(value) ? value : value == null ? [] : [value]);
          return values
            .map(value => typeof value === "string" ? value : value?.id)
            .filter(id => typeof id === "string" && /^\d{17,20}$/.test(id));
        };

        const addedInLog = roleIdsFor("$add");
        const removedInLog = roleIdsFor("$remove");
        const matchingAdd = addedInLog.some(id => expectedAdds.has(id));
        const matchingQuarantineRemoval =
          quarantineRemoved && removedInLog.includes(quarantineRoleId);

        if (matchingAdd || matchingQuarantineRemoval) return entry;
      }
    } catch (error) {
      console.warn("[AntiNuke] Could not read member-role audit logs:", error.message);
      return null;
    }

    if (attempt === 0) await sleep(AUDIT_RETRY_MS);
  }

  return null;
}

/**
 * A quarantined member cannot be given any other role or released without
 * checking the exact actor. If attribution is unavailable, containment is
 * restored, but FRIDAY does not punish an unidentified person.
 */
async function guardQuarantineRole(oldMember, newMember) {
  const guild = newMember.guild;
  if (!guild || oldMember.id !== newMember.id) return false;

  const serverCfg = await guildConfig.get(guild.id);
  const quarantineRoleId = serverCfg.quarantineRole;
  if (!quarantineRoleId) return false;

  // Suppress only role deltas explicitly expected from .uq; unexpected role
  // assignments during release still pass through the Anti-Nuke guard.
  if (require("./lib/quarantineActions").isExpectedRoleChange(
    guild.id, newMember.id, oldMember, newMember, quarantineRoleId
  )) return true;

  const previouslyQuarantined = oldMember.roles.cache.has(quarantineRoleId);
  const currentlyQuarantined = newMember.roles.cache.has(quarantineRoleId);
  const quarantineRemoved = previouslyQuarantined && !currentlyQuarantined;
  const addedIds = getAddedRoleIds(
    oldMember.roles.cache.keys(),
    newMember.roles.cache.keys(),
    [guild.id, quarantineRoleId]
  );

  const tamperingDetected = quarantineRemoved ||
    ((previouslyQuarantined || currentlyQuarantined) && addedIds.length > 0);
  if (!tamperingDetected) return false;

  const entry = await findMemberRoleAuditEntry(
    guild,
    newMember.id,
    addedIds,
    quarantineRemoved,
    quarantineRoleId
  );

  if (entry?.id && handledQuarantineAuditEntries.has(entry.id)) return true;

  const cfg = await protection.getAntinuke(guild.id);
  const actor = entry?.executor || null;

  if (actor && await isTrusted(guild, cfg, actor.id)) {
    if (entry?.id) handledQuarantineAuditEntries.set(entry.id, Date.now());
    return true;
  }

  if (entry?.id) handledQuarantineAuditEntries.set(entry.id, Date.now());

  const targetResult = await quarantine.quarantineMember(guild, newMember.id, quarantineRoleId);
  let actorResult = {
    ok: false,
    text: actor ? "Not attempted." : "Not attempted because the audit-log actor could not be verified."
  };

  if (actor) {
    actorResult = await quarantine.quarantineMember(guild, actor.id, quarantineRoleId);
  }

  const attribution = actor
    ? "**Actor:** " + who(actor)
    : "**Actor:** Unknown — audit-log attribution was unavailable or did not match the changed role IDs.";
  const targetText = targetResult.ok
    ? "<:success_g:1562810067642884177> Target containment verified."
    : "<:warning_g:1562810073733136506> Target quarantine incomplete: " + targetResult.text;
  const actorText = actor
    ? (actorResult.ok
      ? "<:success_g:1562810067642884177> The unauthorized actor was quarantined."
      : "<:warning_g:1562810073733136506> Actor quarantine failed: " + actorResult.text)
    : "<:warning_g:1562810073733136506> No one was punished because FRIDAY could not safely identify the actor.";

  await sendLog(
    guild,
    COLORS.RED,
    "# Anti-Nuke: Quarantine tampering detected\n\n" +
      "**Target:** " + who(newMember.user) + "\n" +
      attribution + "\n" +
      "**Attempt:** " + (quarantineRemoved ? "Quarantine role removed" : "Role assigned to a quarantined member") + "\n\n" +
      targetText + "\n" + actorText + "\n\n" +
      "**Target result:** " + targetResult.text + "\n" +
      (actor ? "**Actor result:** " + actorResult.text + "\n" : "") +
      "\n-# F.R.I.D.A.Y • Automatic Quarantine Guard"
  );

  if (!actor || !targetResult.ok || (actor && !actorResult.ok)) {
    await dmOwner(
      guild,
      "[FRIDAY Anti-Nuke] Quarantine tampering in " + guild.name + " (" + guild.id + "). " +
      "Target: " + newMember.user.tag + " (" + newMember.id + "). " +
      "Actor: " + (actor ? (actor.tag || actor.username) + " (" + actor.id + ")" : "unknown; audit log did not provide a safe match") + ". " +
      "Target result: " + targetResult.text + ". Actor result: " + actorResult.text + ". " +
      "Check FRIDAY's View Audit Log, Manage Roles, and role hierarchy permissions."
    );
  }

  return true;
}

/**
 * Immediate containment for a newly assigned role that grants dangerous
 * permissions. The dangerous assignment is removed even when audit attribution
 * is unavailable; an unknown actor is never punished based on a guess.
 */
async function guardDangerousRoleAssignment(oldMember, newMember) {
  const guild = newMember.guild;
  if (!guild || oldMember.id !== newMember.id) return;

  const serverCfg = await guildConfig.get(guild.id);
  const quarantineRoleId = serverCfg.quarantineRole;
  if (quarantineRoleId &&
      (oldMember.roles.cache.has(quarantineRoleId) || newMember.roles.cache.has(quarantineRoleId))) {
    return; // the stronger quarantine guard handles all role changes for these members
  }

  const cfg = await enabledFor(guild, "roleAssign");
  if (!cfg) return;

  const addedIds = getAddedRoleIds(
    oldMember.roles.cache.keys(),
    newMember.roles.cache.keys(),
    [guild.id]
  );
  const dangerousRoles = addedIds
    .map(id => guild.roles.cache.get(id))
    .filter(role => role && hasDangerousPermissions(role));
  if (!dangerousRoles.length) return;

  const entry = await findMemberRoleAuditEntry(
    guild,
    newMember.id,
    dangerousRoles.map(role => role.id),
    false,
    quarantineRoleId
  );
  const actor = entry?.executor || null;
  if (actor && await isTrusted(guild, cfg, actor.id)) return;

  let removalError = null;
  try {
    await newMember.roles.remove(
      dangerousRoles.map(role => role.id),
      REASON + ": reverse a dangerous role assignment by an untrusted or unattributed actor"
    );
  } catch (error) {
    removalError = error;
  }

  const refreshedTarget = await guild.members.fetch({ user: newMember.id, force: true }).catch(() => newMember);
  const remaining = dangerousRoles.filter(role => refreshedTarget.roles.cache.has(role.id));
  const removedText = remaining.length
    ? "<:warning_g:1562810073733136506> " + remaining.length + " dangerous role assignment(s) could not be removed."
    : "<:success_g:1562810067642884177> The dangerous role assignment was removed.";

  let actorResult = {
    ok: false,
    text: actor ? "Not attempted." : "Not attempted because the audit-log actor could not be verified."
  };

  if (actor) {
    if (serverCfg.quarantineRole) {
      actorResult = await quarantine.quarantineMember(guild, actor.id, serverCfg.quarantineRole);
    } else {
      actorResult = await punish(guild, actor, cfg);
    }
  }

  await sendLog(
    guild,
    remaining.length || !actor ? COLORS.RED : COLORS.GREEN,
    "# Anti-Nuke: Permission escalation detected\n\n" +
      "**Target:** " + who(newMember.user) + "\n" +
      "**New dangerous role(s):** " + dangerousRoles.map(role => role.name).join(", ") + "\n" +
      "**Actor:** " + (actor ? who(actor) : "Unknown — no exact audit-log match") + "\n\n" +
      removedText + "\n" +
      (actor
        ? (actorResult.ok
          ? "<:success_g:1562810067642884177> Actor containment: " + actorResult.text
          : "<:warning_g:1562810073733136506> Actor containment incomplete: " + actorResult.text)
        : "<:warning_g:1562810073733136506> No actor was punished because attribution was unavailable.") +
      (removalError ? "\n**API detail:** " + removalError.message : "") +
      "\n\n-# F.R.I.D.A.Y • Permission Escalation Guard"
  );

  if (!actor || remaining.length || !actorResult.ok) {
    await dmOwner(
      guild,
      "[FRIDAY Anti-Nuke] Permission escalation in " + guild.name + " (" + guild.id + "). " +
      "Target: " + newMember.user.tag + " (" + newMember.id + "). " +
      "New roles: " + dangerousRoles.map(role => role.name).join(", ") + ". " +
      "Actor: " + (actor ? (actor.tag || actor.username) + " (" + actor.id + ")" : "unknown") + ". " +
      removedText + " Actor result: " + actorResult.text
    );
  }
}

/**
 * A role created with Administrator/other dangerous permissions is an
 * escalation attempt even before it is assigned. Remove only the dangerous
 * bits, verify the result, and contain a non-trusted creator when attributable.
 */
async function guardDangerousRoleCreation(role) {
  const guild = role.guild;
  if (!guild || role.managed) return;

  const cfg = await enabledFor(guild, "rolePerms");
  if (!cfg || !hasDangerousPermissions(role)) return;

  const entry = await findAuditEntry(guild, AuditLogEvent.RoleCreate, role.id);
  const actor = entry?.executor || null;
  if (actor && await isTrusted(guild, cfg, actor.id)) return;

  let rollbackError = null;
  try {
    await role.setPermissions(
      role.permissions.remove(...DANGEROUS),
      REASON + ": remove dangerous permissions from a newly created role"
    );
  } catch (error) {
    rollbackError = error;
  }

  const verifiedRole = await guild.roles.fetch(role.id, { force: true }).catch(() => null);
  const permissionEscalationRemains = hasDangerousPermissions(verifiedRole);
  let actorResult = {
    ok: false,
    text: actor ? "Not attempted." : "Not attempted because the audit-log actor could not be verified."
  };

  if (actor) {
    const serverCfg = await guildConfig.get(guild.id);
    if (serverCfg.quarantineRole) {
      actorResult = await quarantine.quarantineMember(guild, actor.id, serverCfg.quarantineRole);
    } else {
      actorResult = await punish(guild, actor, cfg);
    }
  }

  const roleResult = permissionEscalationRemains
    ? "<:warning_g:1562810073733136506> Dangerous permissions remain on the new role."
    : "<:success_g:1562810067642884177> Dangerous permissions were removed from the new role.";

  await sendLog(
    guild,
    permissionEscalationRemains || !actor ? COLORS.RED : COLORS.GREEN,
    "# Anti-Nuke: Dangerous role creation\n\n" +
      "**Role:** " + role.name + " (" + role.id + ")\n" +
      "**Creator:** " + (actor ? who(actor) : "Unknown — audit-log attribution unavailable") + "\n" +
      roleResult +
      (rollbackError ? "\n**Rollback error:** " + rollbackError.message : "") +
      (actor ? "\n**Creator containment:** " + actorResult.text : "") +
      "\n\n-# F.R.I.D.A.Y • Permission Escalation Guard"
  );

  if (!actor || permissionEscalationRemains || !actorResult.ok) {
    await dmOwner(
      guild,
      "[FRIDAY Anti-Nuke] Dangerous role creation in " + guild.name + " (" + guild.id + "). " +
      "Role: " + role.name + " (" + role.id + "). Creator: " +
      (actor ? (actor.tag || actor.username) + " (" + actor.id + ")" : "unknown") + ". " +
      roleResult + (rollbackError ? " Rollback error: " + rollbackError.message : "") +
      (actor ? " Creator containment: " + actorResult.text : "")
    );
  }
}

/**
 * If someone changes the configured Quarantine role, force it back to zero
 * permissions and FRIDAY's role hierarchy position. The guard remains active
 * even when the Anti-Nuke master switch is off.
 */
async function guardQuarantineRoleUpdate(oldRole, newRole) {
  const guild = newRole.guild;
  const serverCfg = await guildConfig.get(guild.id);
  if (!serverCfg.quarantineRole || serverCfg.quarantineRole !== newRole.id) return false;

  const me = guild.members.me;
  const targetPosition = me?.roles.highest?.position - 1;
  const unsafePermissions = !isPermissionlessRole(newRole);
  const unsafePosition = Number.isInteger(targetPosition) &&
    targetPosition >= 1 && newRole.position !== targetPosition;
  if (!unsafePermissions && !unsafePosition) return false;

  const repairKey = guild.id + ":" + newRole.id;
  if (quarantineRoleRepairInFlight.has(repairKey)) return true;
  quarantineRoleRepairInFlight.add(repairKey);

  try {
    const entry = await findAuditEntry(guild, AuditLogEvent.RoleUpdate, newRole.id);
    const cfg = await protection.getAntinuke(guild.id);
    const actor = entry?.executor || null;
    const actorTrusted = actor ? await isTrusted(guild, cfg, actor.id) : false;
    const failures = [];

    let currentRole = await guild.roles.fetch(newRole.id, { force: true }).catch(() => newRole);
    let currentBot = guild.members.me || await guild.members.fetchMe().catch(() => null);

    if (!currentBot?.permissions.has(PermissionFlagsBits.ManageRoles)) {
      failures.push("FRIDAY is missing Manage Roles.");
    } else if (!currentRole.editable) {
      failures.push("The Quarantine role is at or above FRIDAY's highest role and cannot be repaired.");
    } else {
      if (!isPermissionlessRole(currentRole)) {
        try {
          await currentRole.setPermissions(0n, REASON + ": restore the Quarantine role's zero-permission preset");
        } catch (error) {
          failures.push("Could not remove Quarantine role permissions: " + error.message);
        }
      }

      currentRole = await guild.roles.fetch(newRole.id, { force: true }).catch(() => currentRole);
      currentBot = guild.members.me || await guild.members.fetchMe().catch(() => currentBot);
      const requiredPosition = currentBot?.roles.highest?.position - 1;

      if (!Number.isInteger(requiredPosition) || requiredPosition < 1) {
        failures.push("FRIDAY does not have a valid role position for Quarantine.");
      } else if (currentRole.position !== requiredPosition) {
        if (!currentRole.editable) {
          failures.push("Quarantine cannot be moved below FRIDAY because its hierarchy is too high.");
        } else {
          try {
            await currentRole.setPosition(requiredPosition, {
              reason: REASON + ": restore the Quarantine role's protected hierarchy position"
            });
          } catch (error) {
            failures.push("Could not restore the Quarantine role's position: " + error.message);
          }
        }
      }
    }

    const verifiedRole = await guild.roles.fetch(newRole.id, { force: true }).catch(() => null);
    currentBot = guild.members.me || await guild.members.fetchMe().catch(() => null);
    if (!isPermissionlessRole(verifiedRole)) failures.push("Verification failed: Quarantine still has server permissions.");
    if (verifiedRole && currentBot && verifiedRole.position >= currentBot.roles.highest.position) {
      failures.push("Verification failed: Quarantine is not below FRIDAY's highest role.");
    }

    let actorResult = null;
    if (actor && !actorTrusted) {
      if (isPermissionlessRole(verifiedRole) && verifiedRole?.editable) {
        actorResult = await quarantine.quarantineMember(guild, actor.id, verifiedRole.id);
      } else {
        actorResult = await punish(guild, actor, cfg);
      }
    }

    const resultText = failures.length
      ? "<:warning_g:1562810073733136506> Repair incomplete: " + failures.join(" ")
      : "<:success_g:1562810067642884177> Quarantine role security settings were restored and verified.";

    await sendLog(
      guild,
      failures.length ? COLORS.RED : COLORS.GREEN,
      "# Anti-Nuke: Quarantine configuration guard\n\n" +
        "**Role:** <@&" + newRole.id + ">\n" +
        "**Change actor:** " + (actor ? who(actor) : "Unknown — audit-log attribution unavailable") + "\n" +
        resultText +
        (actorResult ? "\n**Actor containment:** " + actorResult.text : "") +
        "\n\n-# F.R.I.D.A.Y • Security Configuration Guard"
    );

    if (!actor || failures.length || (actorResult && !actorResult.ok)) {
      await dmOwner(
        guild,
        "[FRIDAY Anti-Nuke] Quarantine-role configuration change in " + guild.name + " (" + guild.id + "). " +
        "Actor: " + (actor ? (actor.tag || actor.username) + " (" + actor.id + ")" : "unknown") + ". " +
        resultText + (actorResult ? " Actor containment: " + actorResult.text : "")
      );
    }
  } catch (error) {
    console.error("[AntiNuke] Quarantine role security repair failed:", error);
    await dmOwner(guild, "[FRIDAY Anti-Nuke] Could not verify the Quarantine role after a configuration change in " +
      guild.name + " (" + guild.id + "): " + error.message);
  } finally {
    quarantineRoleRepairInFlight.delete(repairKey);
  }

  return true;
}

/**
 * Restore a deleted configured Quarantine role even when mass-action protection
 * is disabled. The new role receives zero permissions and fresh channel denies.
 */
async function restoreDeletedQuarantineRole(deletedRole) {
  const guild = deletedRole.guild;
  const serverCfg = await guildConfig.get(guild.id);
  if (!serverCfg.quarantineRole || serverCfg.quarantineRole !== deletedRole.id) return false;

  const entry = await findAuditEntry(guild, AuditLogEvent.RoleDelete, deletedRole.id);
  const actor = entry?.executor || null;
  const cfg = await protection.getAntinuke(guild.id);
  const actorTrusted = actor ? await isTrusted(guild, cfg, actor.id) : false;
  let restoredRole = null;
  let recoveryText = "";

  try {
    restoredRole = await guild.roles.create({
      name: deletedRole.name === "Quarantine" ? "Quarantine" : deletedRole.name,
      color: deletedRole.color,
      hoist: deletedRole.hoist,
      mentionable: false,
      permissions: 0n,
      reason: REASON + ": restore the configured Quarantine role after deletion"
    });
    await guildConfig.set(guild.id, "quarantineRole", restoredRole.id);
    const configured = await quarantine.configureRole(guild, restoredRole);
    recoveryText = "Recreated <@&" + configured.role.id + "> with zero permissions and " +
      configured.configuredChannels + " channel restriction(s).";
  } catch (error) {
    recoveryText = "Role restoration/configuration failed: " + error.message;
  }

  let actorResult = null;
  if (actor && !actorTrusted) {
    if (restoredRole && restoredRole.editable) {
      actorResult = await quarantine.quarantineMember(guild, actor.id, restoredRole.id);
    } else {
      actorResult = await punish(guild, actor, cfg);
    }
  }

  await sendLog(
    guild,
    restoredRole ? COLORS.GREEN : COLORS.RED,
    "# Anti-Nuke: Quarantine role recovery\n\n" +
      "**Deleted role:** " + deletedRole.name + " (" + deletedRole.id + ")\n" +
      "**Actor:** " + (actor ? who(actor) : "Unknown — audit-log attribution unavailable") + "\n" +
      recoveryText +
      (actorResult ? "\n**Actor containment:** " + actorResult.text : "") +
      "\n\n-# F.R.I.D.A.Y • Automatic Recovery"
  );

  if (!restoredRole || !actor || (actorResult && !actorResult.ok)) {
    await dmOwner(
      guild,
      "[FRIDAY Anti-Nuke] Quarantine-role deletion/recovery in " + guild.name + " (" + guild.id + "). " +
      "Actor: " + (actor ? (actor.tag || actor.username) + " (" + actor.id + ")" : "unknown") + ". " +
      recoveryText + (actorResult ? " Actor containment: " + actorResult.text : "")
    );
  }

  return true;
}

/**
 * Repair the configured Quarantine overwrite if someone removes its channel
 * denies. This only calls Discord on a channel event; the watchdog is read-only.
 */
async function guardQuarantineChannel(channel) {
  const guild = channel.guild;
  if (!guild || channel.isThread?.() || !channel.permissionOverwrites?.cache) return;

  const serverCfg = await guildConfig.get(guild.id);
  const roleId = serverCfg.quarantineRole;
  if (!roleId) return;

  const missing = missingQuarantineDenies(channel, roleId);
  if (!missing.length) return;

  const repairKey = guild.id + ":" + channel.id;
  if (quarantineChannelRepairInFlight.has(repairKey)) return;
  const last = lastQuarantineChannelRepair.get(repairKey) || 0;
  if (Date.now() - last < 5000) return;

  quarantineChannelRepairInFlight.add(repairKey);
  lastQuarantineChannelRepair.set(repairKey, Date.now());
  try {
    let repairError = null;
    try {
      const applied = await quarantine.applyToChannel(guild, channel, roleId);
      if (!applied) repairError = new Error("The configured Quarantine role or an editable channel was unavailable.");
    } catch (error) {
      repairError = error;
    }

    const freshChannel = await guild.channels.fetch(channel.id, { force: true }).catch(() => channel);
    const stillMissing = missingQuarantineDenies(freshChannel, roleId);
    const ok = !repairError && stillMissing.length === 0;

    await sendLog(
      guild,
      ok ? COLORS.GREEN : COLORS.RED,
      "# Anti-Nuke: Quarantine channel guard\n\n" +
        "**Channel:** <#" + channel.id + ">\n" +
        (ok
          ? "<:success_g:1562810067642884177> Quarantine access-deny overwrites were restored."
          : "<:warning_g:1562810073733136506> Could not restore all quarantine denies (" +
            stillMissing.length + " permission overwrite(s) remain missing)." +
            (repairError ? "\n**Error:** " + repairError.message : "")) +
        "\n\n-# F.R.I.D.A.Y • Security Configuration Guard"
    );

    if (!ok) {
      await dmOwner(
        guild,
        "[FRIDAY Anti-Nuke] Quarantine overwrite repair failed in " + guild.name + " (" + guild.id + "), channel " +
        channel.name + " (" + channel.id + "). Check Manage Channels and channel/category permissions."
      );
    }
  } catch (error) {
    console.error("[AntiNuke] Quarantine channel guard failed:", error);
  } finally {
    quarantineChannelRepairInFlight.delete(repairKey);
  }
}

function evaluateSecurityHealth(guild, cfg, serverCfg, probeAudit = false) {
  const issues = [];
  const rows = [];
  const me = guild.members.me;
  const required = new Map();

  const requirePermission = (key, reason) => {
    if (!required.has(key)) required.set(key, []);
    required.get(key).push(reason);
  };

  if (cfg.enabled) {
    requirePermission("ViewAuditLog", "identify the actor in audit logs");
    if (cfg.protections.roleDelete || cfg.protections.roleCreate ||
        cfg.protections.rolePerms || cfg.protections.roleAssign) {
      requirePermission("ManageRoles", "reverse role and permission escalation");
    }
    if (cfg.restore && (cfg.protections.channelDelete || cfg.protections.channelCreate)) {
      requirePermission("ManageChannels", "recover channel changes and secure new channels");
    }
    if (cfg.protections.webhook) requirePermission("ManageWebhooks", "remove unauthorized webhooks");
    if (cfg.punishment === "kick") requirePermission("KickMembers", "apply the configured kick response");
    if (cfg.punishment === "ban") requirePermission("BanMembers", "apply the configured ban response");
    if (cfg.punishment === "strip") requirePermission("KickMembers", "fallback when dangerous roles cannot be stripped");
  }

  if (serverCfg.quarantineRole) {
    requirePermission("ManageRoles", "assign and restore the Quarantine role");
    requirePermission("ManageChannels", "restore Quarantine channel denies");
    requirePermission("ViewAuditLog", "identify who tampers with Quarantine");
  } else if (cfg.enabled) {
    issues.push("No Quarantine role is configured; Anti-Nuke must rely on its fallback punishment.");
  }

  for (const [key, reasons] of required) {
    const ok = Boolean(me?.permissions.has(PermissionFlagsBits[key]));
    rows.push({
      ok,
      label: key,
      detail: ok ? "available" : "missing — required to " + reasons.join(", ")
    });
    if (!ok) issues.push("Missing bot permission " + key + " (" + reasons.join(", ") + ").");
  }

  rows.push({
    ok: cfg.enabled,
    label: "Anti-Nuke master switch",
    detail: cfg.enabled ? "enabled" : "disabled",
    critical: false
  });

  if (serverCfg.quarantineRole) {
    const role = guild.roles.cache.get(serverCfg.quarantineRole);
    if (!role) {
      rows.push({ ok: false, label: "Quarantine role", detail: "configured role is missing" });
      issues.push("The configured Quarantine role is missing.");
    } else {
      const safe = isPermissionlessRole(role);
      rows.push({
        ok: safe,
        label: "Quarantine permissions",
        detail: safe ? "zero server-wide permissions" : "UNSAFE — the role has server-wide permissions"
      });
      if (!safe) issues.push("The Quarantine role has server-wide permissions.");

      const targetPosition = me?.roles.highest?.position - 1;
      const positioned = Number.isInteger(targetPosition) && targetPosition >= 1 &&
        role.position === targetPosition && role.position < (me?.roles.highest?.position || 0);
      rows.push({
        ok: positioned,
        label: "Quarantine hierarchy",
        detail: positioned
          ? "directly below FRIDAY's highest role"
          : "not in the required position below FRIDAY's highest role"
      });
      if (!positioned) issues.push("The Quarantine role is not directly below FRIDAY's highest role.");

      let missingOverwriteCount = 0;
      let checkedChannels = 0;
      for (const channel of guild.channels.cache.values()) {
        if (channel.isThread?.() || !channel.permissionOverwrites?.cache) continue;
        checkedChannels++;
        if (missingQuarantineDenies(channel, role.id).length) missingOverwriteCount++;
      }
      const overwritesSafe = missingOverwriteCount === 0;
      rows.push({
        ok: overwritesSafe,
        label: "Quarantine channel denies",
        detail: overwritesSafe
          ? "configured on " + checkedChannels + " cached channel(s)"
          : missingOverwriteCount + " of " + checkedChannels + " cached channel(s) need repair"
      });
      if (!overwritesSafe) issues.push(missingOverwriteCount + " cached channel(s) lack required Quarantine deny overwrites.");
    }
  }

  if (probeAudit) {
    if (!me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
      rows.push({ ok: false, label: "Audit-log probe", detail: "not attempted because View Audit Log is missing" });
    } else {
      rows.push({ ok: true, label: "Audit-log probe", detail: "permission is present; fetching a recent page..." });
    }
  }

  return { issues: [...new Set(issues)], rows };
}

async function runSecurityCheck(guild, options = {}) {
  const cfg = options.cfg || await protection.getAntinuke(guild.id);
  const serverCfg = options.serverCfg || await guildConfig.get(guild.id);
  const report = evaluateSecurityHealth(guild, cfg, serverCfg, Boolean(options.probeAudit));

  if (options.probeAudit && guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
    try {
      await guild.fetchAuditLogs({ limit: 1 });
    } catch (error) {
      report.rows.push({ ok: false, label: "Audit-log probe", detail: "Discord denied the request: " + error.message });
      report.issues.push("Discord rejected the audit-log request.");
    }
  }

  if (options.simulation) {
    report.rows.push({
      ok: cfg.enabled && cfg.protections.rolePerms,
      label: "Simulated permission escalation",
      detail: cfg.enabled && cfg.protections.rolePerms
        ? "would roll back newly granted dangerous role permissions and count the incident"
        : "would not run because Anti-Nuke or role-permission protection is off",
      critical: false
    });
    report.rows.push({
      ok: cfg.enabled && cfg.protections.roleAssign,
      label: "Simulated dangerous role assignment",
      detail: cfg.enabled && cfg.protections.roleAssign
        ? "would remove a newly assigned dangerous role; quarantine an identified untrusted actor"
        : "would not run because Anti-Nuke or role-escalation protection is off",
      critical: false
    });
    report.rows.push({
      ok: Boolean(serverCfg.quarantineRole),
      label: "Simulated Quarantine tampering",
      detail: serverCfg.quarantineRole
        ? "the member guard would restore containment; an exact untrusted actor would also be quarantined"
        : "no Quarantine role is configured, so this guard cannot contain the target",
      critical: false
    });
    report.rows.push({
      ok: cfg.restore,
      label: "Simulated recovery",
      detail: cfg.restore
        ? "recent in-memory channel/role snapshots can be restored; created attack resources can be removed"
        : "automatic channel/role recovery is switched off",
      critical: false
    });
    report.rows.push({
      ok: true,
      label: "Simulation safety",
      detail: "dry run only — no roles, members, channels, settings, or punishments were changed"
    });
  }

  return { ...report, cfg, serverCfg };
}

function formatSecurityCheck(guild, report, simulation = false) {
  const lines = report.rows.map(row =>
    (row.ok ? "<:success_g:1562810067642884177>" : "<:warning_g:1562810073733136506>") +
    " **" + row.label + ":** " + row.detail
  );

  const issueSummary = report.issues.length
    ? "\n\n**Issues needing attention:**\n" + report.issues.slice(0, 8).map(item => "• " + item).join("\n")
    : "\n\n<:success_g:1562810067642884177> No blocking configuration issues were found in the checks performed.";

  const header = simulation ? "# Anti-Nuke Attack Simulation (Dry Run)" : "# Anti-Nuke Watchdog Report";
  const safetyNote = simulation
    ? "\n\n**Simulation only:** FRIDAY did not perform a real attack, remove roles, quarantine anyone, or alter server settings."
    : "";
  return header + "\n\n" +
    "**Server:** " + guild.name + "\n" +
    "**Anti-Nuke:** " + (report.cfg.enabled ? "ON" : "OFF") + "\n\n" +
    lines.join("\n") + issueSummary + safetyNote +
    "\n\n-# F.R.I.D.A.Y • Security Diagnostics";
}

async function watchdogTick(client) {
  for (const guild of client.guilds.cache.values()) {
    const cfg = protection.peekAntinuke(guild.id);
    const serverCfg = guildConfig.peek(guild.id);
    if (!cfg || !serverCfg) continue;

    // The watchdog is part of Anti-Nuke's optional monitoring. When the
    // server's master Anti-Nuke switch is OFF, suppress periodic health alerts
    // and clear the remembered signature so re-enabling it can report current
    // issues afresh. The independent quarantine-tampering guard remains wired
    // separately and continues protecting quarantined members.
    if (!cfg.enabled) {
      watchdogAlertState.delete(guild.id);
      continue;
    }

    const report = evaluateSecurityHealth(guild, cfg, serverCfg, false);
    const signature = report.issues.slice().sort().join("|");
    const previous = watchdogAlertState.get(guild.id);
    watchdogAlertState.set(guild.id, signature);

    if (!signature || signature === previous) continue;

    const content = "# Anti-Nuke Watchdog Alert\n\n" +
      "**Server:** " + guild.name + "\n" +
      report.issues.slice(0, 8).map(item => "• " + item).join("\n") +
      "\n\nThe watchdog is checking cached configuration and Discord state; it does not poll Firestore.\n\n" +
      "-# F.R.I.D.A.Y • Security Watchdog";
    await sendLog(guild, COLORS.RED, content);
    await dmOwner(guild, "[FRIDAY Anti-Nuke Watchdog] Security issue(s) in " + guild.name +
      " (" + guild.id + "): " + report.issues.join(" "));
  }
}

async function recoverMissingQuarantineRole(guild, serverCfg) {
  const roleId = serverCfg?.quarantineRole;
  if (!roleId || guild.roles.cache.has(roleId)) return false;

  let errorCode = null;
  try {
    const fetched = await guild.roles.fetch(roleId);
    if (fetched) return false;
  } catch (error) {
    errorCode = error.code ?? error.rawError?.code ?? null;
    // Only recreate when Discord explicitly says the stored role ID no longer exists.
    if (String(errorCode) !== "10011") {
      console.warn("[AntiNuke] Could not verify configured Quarantine role:", error.message);
      return false;
    }
  }

  let created = null;
  try {
    created = await guild.roles.create({
      name: "Quarantine",
      permissions: 0n,
      reason: REASON + ": restore a missing configured Quarantine role"
    });
    await guildConfig.set(guild.id, "quarantineRole", created.id);
    const configured = await quarantine.configureRole(guild, created);
    await sendLog(
      guild,
      COLORS.GREEN,
      "# Anti-Nuke: missing Quarantine role restored\n\n" +
        "FRIDAY recreated <@&" + configured.role.id + "> with zero permissions and restored channel restrictions.\n\n" +
        "-# F.R.I.D.A.Y • Automatic Recovery"
    );
    await dmOwner(guild, "[FRIDAY Anti-Nuke] The configured Quarantine role was missing in " +
      guild.name + " (" + guild.id + "). FRIDAY recreated it and reapplied its safe preset.");
    return true;
  } catch (error) {
    await sendLog(
      guild,
      COLORS.RED,
      "# Anti-Nuke: Quarantine recovery failed\n\n" +
        "The stored Quarantine role is missing and could not be recreated: " + error.message + "\n\n" +
        "-# F.R.I.D.A.Y • Automatic Recovery"
    );
    await dmOwner(guild, "[FRIDAY Anti-Nuke] Could not recreate the missing Quarantine role in " +
      guild.name + " (" + guild.id + "): " + error.message);
    return false;
  }
}

// Alerts
// ---------------------------------------------------------------------------
async function sendLog(guild, color, content) {
  try {
    const channel = await guildConfig.getLogChannel(guild);
    if (!channel) return;

    await channel.send({
      components: [
        createCard({
          color,
          content,
          avatarURL: avatarOf(guild.client),
          avatarDescription: "F.R.I.D.A.Y"
        })
      ],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] }
    });
  } catch (error) {
    console.error("[AntiNuke] Failed to send log:", error);
  }
}

async function dmOwner(guild, text) {
  try {
    const owner = await guild.fetchOwner();
    await owner.send({ content: text, allowedMentions: { parse: [] } });
  } catch {
    // DMs closed: the log channel still has the alert
  }
}

// ---------------------------------------------------------------------------
// Punishment and recovery
// ---------------------------------------------------------------------------
/**
 * A bot's integration role can retain Administrator even after the member is
 * given Quarantine. Attempt to remove dangerous bits directly from each managed
 * role the offender has, then fetch the role again to verify what Discord kept.
 * If Discord blocks the edit, the caller must escalate to kick/ban.
 */
async function stripManagedDangerousPermissions(guild, userId) {
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return { ok: true, changed: 0, text: "" };

  const candidates = [...member.roles.cache.values()].filter(
    role => role.id !== guild.id && role.managed &&
      DANGEROUS.some(permission => role.permissions.has(permission))
  );

  if (!candidates.length) return { ok: true, changed: 0, text: "" };

  const stripped = [];
  const unresolved = [];

  for (const role of candidates) {
    try {
      await role.setPermissions(
        role.permissions.remove(...DANGEROUS),
        `${REASON}: neutralize dangerous permissions on a nuke attempter's managed role`
      );
    } catch (error) {
      // Managed integration roles may be locked by Discord. Still fetch and
      // verify: the edit may have succeeded despite a transient API error.
      console.warn(`[AntiNuke] Could not edit managed role "${role.name}":`, error.message);
    }

    const current = await guild.roles.fetch(role.id, { force: true }).catch(
      () => guild.roles.cache.get(role.id) || role
    );
    const remaining = DANGEROUS.filter(permission => current.permissions.has(permission));

    if (remaining.length) {
      unresolved.push(`${current.name} (${remaining.length} dangerous permission(s) remain)`);
    } else {
      stripped.push(current.name);
    }
  }

  const parts = [];
  if (stripped.length) {
    parts.push(`removed dangerous permissions from ${stripped.length} managed role(s): ${stripped.join(", ")}`);
  }
  if (unresolved.length) {
    parts.push(`could not neutralize ${unresolved.length} managed role(s): ${unresolved.join(", ")}`);
  }

  return { ok: unresolved.length === 0, changed: stripped.length, text: parts.join("; ") };
}

async function punish(guild, user, cfg) {
  const member = await guild.members.fetch(user.id).catch(() => null);

  try {
    if (cfg.punishment === "ban") {
      // works even if they already left the server
      await guild.members.ban(user.id, { reason: REASON });
      return { ok: true, text: "Banned" };
    }

    if (!member) return { ok: false, text: "They had already left the server" };

    const kick = async fallback => {
      if (member.kickable === false) {
        return { ok: false, text: `Could not kick them (their role is above mine)${fallback ? " after stripping failed" : ""}` };
      }

      await member.kick(REASON);
      return { ok: true, text: fallback ? "Kicked (no roles could be stripped)" : "Kicked" };
    };

    if (cfg.punishment === "kick" || user.bot) return await kick(false);

    // "strip": take away every role with dangerous permissions that I am allowed to manage
    const dangerous = member.roles.cache.filter(
      role => role.id !== guild.id && DANGEROUS.some(permission => role.permissions.has(permission))
    );

    const removable = dangerous.filter(role => !role.managed && role.editable !== false);

    if (!removable.size) return await kick(true);

    await member.roles.remove([...removable.keys()], REASON);

    const stuck = dangerous.size - removable.size;
    const strippedText = `Stripped ${removable.size} role(s): ${removable.map(r => r.name).join(", ")}`;

    // If dangerous roles remain, do not leave the offender active just because
    // at least one role was stripped. Escalate to a kick when possible.
    if (stuck) {
      const result = await kick(true);
      return {
        ok: result.ok,
        text: `${strippedText}. ${stuck} dangerous role(s) could not be removed. ${result.text}`
      };
    }

    return { ok: true, text: strippedText };
  } catch (error) {
    console.error("[AntiNuke] Punishment failed:", error.message);
    return { ok: false, text: `Punishment failed (${error.message})` };
  }
}

function channelOptions(guild, snap) {
  const exists = id => guild.roles.cache.has(id) || guild.members.cache.has(id);

  const options = {
    name: snap.name,
    type: snap.type,
    permissionOverwrites: snap.overwrites.filter(o => exists(o.id)),
    reason: `${REASON}: restoring a deleted channel`
  };

  if (snap.parentId && guild.channels.cache.has(snap.parentId)) options.parent = snap.parentId;

  for (const key of ["topic", "nsfw", "rateLimitPerUser", "bitrate", "userLimit"]) {
    if (snap[key] !== undefined && snap[key] !== null) options[key] = snap[key];
  }

  return options;
}

async function recover(guild, userId) {
  const key = `${guild.id}:${userId}`;
  const entry = book.get(key);
  const now = Date.now();
  const out = { removedChannels: 0, removedRoles: 0, restoredChannels: 0, restoredRoles: 0, failed: 0 };

  if (!entry) return out;

  const fresh = list => list.filter(e => now - e.ts < BOOK_KEEP_MS);

  // 1) remove what they created in bulk
  for (const item of fresh(entry.createdChannels)) {
    const channel = guild.channels.cache.get(item.id);
    if (!channel) continue;

    try {
      await channel.delete(`${REASON}: removing a channel created during an attack`);
      out.removedChannels++;
    } catch {
      out.failed++;
    }
  }

  for (const item of fresh(entry.createdRoles)) {
    const role = guild.roles.cache.get(item.id);
    if (!role) continue;

    try {
      await role.delete(`${REASON}: removing a role created during an attack`);
      out.removedRoles++;
    } catch {
      out.failed++;
    }
  }

  // 2) put back what they deleted (categories first)
  const channels = fresh(entry.channels)
    .map(e => e.snap)
    .sort((a, b) => Number(b.type === ChannelType.GuildCategory) - Number(a.type === ChannelType.GuildCategory));

  for (const snap of channels) {
    try {
      await guild.channels.create(channelOptions(guild, snap));
      out.restoredChannels++;
    } catch {
      out.failed++;
    }
  }

  for (const item of fresh(entry.roles)) {
    try {
      const restoredRole = await guild.roles.create({ ...item.snap, reason: `${REASON}: restoring a deleted role` });
      out.restoredRoles++;

      // Role IDs change when Discord recreates a deleted role. Keep the saved
      // quarantine setting pointing at the restored role, then reapply its safe preset.
      const serverCfg = await guildConfig.get(guild.id);
      if (item.id && serverCfg.quarantineRole === item.id) {
        await guildConfig.set(guild.id, "quarantineRole", restoredRole.id);
        try {
          await quarantine.configureRole(guild, restoredRole);
        } catch (error) {
          out.failed++;
          console.error("[AntiNuke] Restored the Quarantine role but could not fully reapply its preset:", error.message);
        }
      }
    } catch (error) {
      out.failed++;
      console.error("[AntiNuke] Could not restore role:", error.message);
    }
  }

  book.delete(key);
  return out;
}

// ---------------------------------------------------------------------------
// Counting and triggering
// ---------------------------------------------------------------------------
function count(guildId, userId, kind, windowMs) {
  const key = `${guildId}:${userId}:${kind}`;
  const now = Date.now();
  const list = (hits.get(key) || []).filter(t => now - t < windowMs);

  list.push(now);
  hits.set(key, list);

  return list.length;
}

async function registerHit(guild, cfg, user, kind) {
  const limit = kind === "rolePerms" ? ROLE_PERMS_LIMIT : cfg.threshold;
  const total = count(guild.id, user.id, kind, cfg.windowSeconds * 1000);

  if (total >= limit) await trigger(guild, user, kind, total, cfg);
}

async function trigger(guild, user, kind, total, cfg) {
  const key = `${guild.id}:${user.id}`;
  const last = lastPunished.get(key);

  // One response per offender per minute, so a continuing attack can't loop us
  if (last && Date.now() - last < PUNISH_COOLDOWN_MS) return;
  lastPunished.set(key, Date.now());

  // First try to strip dangerous permissions from the offender's managed
  // integration role (for example, a bot role that already has Administrator).
  // Quarantine overwrites alone cannot stop Administrator.
  const managedStrip = await stripManagedDangerousPermissions(guild, user.id);
  const managedNote = managedStrip.text ? managedStrip.text + ". " : "";
  const serverCfg = await guildConfig.get(guild.id);
  let punishment;

  if (serverCfg.quarantineRole) {
    const result = await quarantine.quarantineMember(guild, user.id, serverCfg.quarantineRole);

    // A successful role assignment is not enough if a managed role still grants
    // Administrator. Escalate instead of reporting quarantine as complete.
    if (result.ok && managedStrip.ok) {
      punishment = {
        ok: true,
        text: (managedNote ? managedNote : "") + result.text
      };
    } else {
      const fallback = await punish(guild, user, cfg);
      const reasons = [];
      if (!managedStrip.ok) reasons.push("Managed-role permission stripping incomplete: " + managedStrip.text);
      if (!result.ok) reasons.push("Quarantine incomplete: " + result.text);
      punishment = {
        ok: fallback.ok,
        text: (reasons.length ? reasons.join(". ") + ". " : "") + "Fallback punishment: " + fallback.text
      };
    }
  } else {
    punishment = await punish(guild, user, cfg);
    if (managedNote) punishment = { ...punishment, text: managedNote + punishment.text };
  }

  // ...then repair it
  const recovery = cfg.restore ? await recover(guild, user.id) : null;

  for (const k of Object.keys(FEATURES)) hits.delete(`${key}:${k}`);

  const recoveryText = recovery
    ? `Restored ${recovery.restoredChannels} channel(s) and ${recovery.restoredRoles} role(s); ` +
      `removed ${recovery.removedChannels} channel(s) and ${recovery.removedRoles} role(s) they created` +
      (recovery.failed ? `; ${recovery.failed} step(s) failed` : "")
    : "Auto-restore is off";

  const summary =
    `**Who:** ${who(user)}\n` +
    `**What:** ${total}× ${FEATURES[kind].label.toLowerCase()} within ${cfg.windowSeconds}s\n` +
    `**Response:** ${punishment.ok ? "<:success_g:1562810067642884177>" : "<:warning_g:1562810073733136506>"} ${punishment.text}\n` +
    `**Recovery:** ${recoveryText}`;

  await sendLog(
    guild,
    COLORS.RED,
    `# 🚨 Anti-Nuke triggered\n\n${summary}\n\n` +
      `${punishment.ok ? "" : "<:warning_g:1562810073733136506> The punishment did not fully work. Move my role to the top of the role list and check the audit log.\n\n"}` +
      `-# F.R.I.D.A.Y • Anti-Nuke`
  );

  await dmOwner(
    guild,
    `🚨 Anti-Nuke triggered in **${guild.name}**\n` +
      `${user.tag || user.username || user.id} (${user.id}) did ${total}× ${FEATURES[kind].label.toLowerCase()} within ${cfg.windowSeconds}s.\n` +
      `${punishment.ok ? "<:success_g:1562810067642884177>" : "<:warning_g:1562810073733136506>"} ${punishment.text}\n${recoveryText}`
  );
}

// ---------------------------------------------------------------------------
// Control panel (buttons), owner only
// ---------------------------------------------------------------------------
const flag = on => (on ? "<:success_g:1562810067642884177>" : "⬜");

function toggleButton(id, label, on) {
  return new ButtonBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setStyle(on ? ButtonStyle.Success : ButtonStyle.Secondary);
}

async function buildPanel(guild, userId, note = null) {
  const cfg = await protection.getAntinuke(guild.id);
  const serverCfg = await guildConfig.get(guild.id);
  const savedQuarantineRole = serverCfg.quarantineRole ? guild.roles.cache.get(serverCfg.quarantineRole) : null;
  const quarantineLine = savedQuarantineRole ? "<@&" + savedQuarantineRole.id + ">" : "not set";
  const me = guild.members.me;

  const permissionLine = BOT_PERMISSIONS.map(
    ([key, label]) => `${me?.permissions.has(PermissionFlagsBits[key]) ? "<:success_g:1562810067642884177>" : "<:error_g:1562810019454386196>"} ${label}`
  ).join(" • ");

  const auditMissing = !me?.permissions.has(PermissionFlagsBits.ViewAuditLog);

  const featureLines = Object.entries(FEATURES).map(
    ([key, def]) => `${flag(cfg.protections[key])} **${def.label}**`
  );

  const trusted = cfg.trusted.length
    ? cfg.trusted.slice(0, 20).map(id => `<@${id}>`).join(" ")
    : "*nobody yet*";

  const card = createCard({
    color: cfg.enabled ? COLORS.GREEN : COLORS.SKY_BLUE,
    content:
      `# <:FRIDAY:1564865373583581266> Anti-Nuke\n\n${note ? `${note}\n\n` : ""}` +
      `**Status:** ${cfg.enabled ? "🟢 ON" : "🔴 OFF"}\n` +
      `**Quarantine:** ${quarantineLine}\n` +
      `**Punishment:** ${PUNISHMENT_TEXT[cfg.punishment]}\n` +
      `**Trigger:** ${cfg.threshold} actions in ${cfg.windowSeconds}s\n` +
      `**Auto-restore:** ${cfg.restore ? "on" : "off"}\n\n` +
      `${featureLines.join("\n")}\n\n` +
      `**Trusted (exempt):** ${trusted}\n` +
      `-# Server owner, bot owner and owners delegated in this server are trusted automatically; use wl to exempt others here.\n\n` +
      `**My permissions:** ${permissionLine}\n` +
      `${auditMissing ? "<:error_g:1562810019454386196> Missing **View Audit Log** — Anti-Nuke cannot identify offenders.\n" : ""}\n` +
      `-# F.R.I.D.A.Y • Anti-Nuke`,
    avatarURL: avatarOf(guild.client),
    avatarDescription: "F.R.I.D.A.Y"
  });

  const toggle = key => toggleButton(`an:tog:${key}:${userId}`, FEATURES[key].label, cfg.protections[key]);

  const row1 = new ActionRowBuilder().addComponents(
    ["channelDelete", "channelCreate", "roleDelete", "roleCreate", "roleAssign"].map(toggle)
  );

  const row2 = new ActionRowBuilder().addComponents(
    ["ban", "kick", "webhook", "botAdd", "rolePerms"].map(toggle)
  );

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`an:master:${userId}`)
      .setLabel(cfg.enabled ? "Anti-Nuke: ON" : "Anti-Nuke: OFF")
      .setStyle(cfg.enabled ? ButtonStyle.Success : ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`an:pun:${userId}`)
      .setLabel(`Fallback: ${PUNISHMENT_TEXT[cfg.punishment]}`)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`an:thr:${userId}`)
      .setLabel(`Trigger: ${cfg.threshold}`)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`an:rest:${userId}`)
      .setLabel(`Restore: ${cfg.restore ? "on" : "off"}`)
      .setStyle(cfg.restore ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`an:done:${userId}`)
      .setLabel("Done")
      .setStyle(ButtonStyle.Success)
  );

  const row4 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`an:untrust:${userId}`)
      .setLabel("Clear trusted")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!cfg.trusted.length),
    new ButtonBuilder()
      .setCustomId(`an:sim:${userId}`)
      .setLabel("Attack simulation")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`an:check:${userId}`)
      .setLabel("Run watchdog check")
      .setStyle(ButtonStyle.Secondary)
  );

  const trustMenu = new UserSelectMenuBuilder()
    .setCustomId(`an:trust:${userId}`)
    .setPlaceholder("Add trusted users or bots (they are never punished)")
    .setMinValues(1)
    .setMaxValues(10);

  return {
    components: [card, row1, row2, row3, row4, new ActionRowBuilder().addComponents(trustMenu)],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] }
  };
}

function next(list, current) {
  return list[(list.indexOf(current) + 1) % list.length];
}

async function handlePanel(interaction) {
  const parts = interaction.customId.split(":"); // an:<action>:...:<userId>
  const action = parts[1];
  const userId = parts[parts.length - 1];

  if (interaction.user.id !== userId) {
    return await interaction.reply({
      content: "This Anti-Nuke panel belongs to someone else.",
      flags: MessageFlags.Ephemeral
    });
  }

  if (!interaction.guild || !(await canManage(interaction.guild, interaction.user.id))) {
    return await interaction.reply({
      content: "Only the server owner, main bot owner, or an owner delegated in this server can change Anti-Nuke.",
      flags: MessageFlags.Ephemeral
    });
  }

  const guild = interaction.guild;
  const refresh = async note => interaction.update(await buildPanel(guild, userId, note));

  if (action === "sim" && interaction.isButton()) {
    const report = await runSecurityCheck(guild, { probeAudit: true, simulation: true });
    return refresh(formatSecurityCheck(guild, report, true));
  }

  if (action === "check" && interaction.isButton()) {
    const report = await runSecurityCheck(guild, { probeAudit: true });
    return refresh(formatSecurityCheck(guild, report, false));
  }

  if (action === "tog" && interaction.isButton()) {
    const kind = parts[2];
    if (!FEATURES[kind]) return interaction.deferUpdate();

    const cfg = await protection.updateAntinuke(guild.id, c => {
      c.protections[kind] = !c.protections[kind];
    });

    return refresh(`${flag(cfg.protections[kind])} **${FEATURES[kind].label}** is now ${cfg.protections[kind] ? "on" : "off"}.`);
  }

  if (action === "master" && interaction.isButton()) {
    const cfg = await protection.updateAntinuke(guild.id, c => {
      c.enabled = !c.enabled;
    });

    const auditMissing = !guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog);

    return refresh(
      `Anti-Nuke is now **${cfg.enabled ? "ON" : "OFF"}**.` +
        (cfg.enabled && auditMissing ? "\n<:error_g:1562810019454386196> It can't work until I have **View Audit Log**." : "")
    );
  }

  if (action === "pun" && interaction.isButton()) {
    const cfg = await protection.updateAntinuke(guild.id, c => {
      c.punishment = next(PUNISHMENTS, c.punishment);
    });

    return refresh(`Punishment is now **${PUNISHMENT_TEXT[cfg.punishment]}**.`);
  }

  if (action === "thr" && interaction.isButton()) {
    const cfg = await protection.updateAntinuke(guild.id, c => {
      c.threshold = next(THRESHOLDS, THRESHOLDS.includes(c.threshold) ? c.threshold : THRESHOLDS[0]);
    });

    return refresh(`It now triggers after **${cfg.threshold}** mass actions within ${cfg.windowSeconds} seconds.`);
  }

  if (action === "rest" && interaction.isButton()) {
    const cfg = await protection.updateAntinuke(guild.id, c => {
      c.restore = !c.restore;
    });

    return refresh(`Auto-restore is now **${cfg.restore ? "on" : "off"}**.`);
  }

  if (action === "trust" && interaction.isUserSelectMenu()) {
    const cfg = await protection.updateAntinuke(guild.id, c => {
      c.trusted = [...new Set([...c.trusted, ...interaction.values])].slice(0, 50);
    });

    return refresh(`Trusted list updated (${cfg.trusted.length}).`);
  }

  if (action === "untrust" && interaction.isButton()) {
    await protection.updateAntinuke(guild.id, c => {
      c.trusted = [];
    });

    return refresh("🧹 The trusted list was cleared.");
  }

  if (action === "done" && interaction.isButton()) {
    return interaction.update({
      components: [
        createCard({
          color: COLORS.GREEN,
          content: "# Anti-Nuke saved\n\nYour Anti-Nuke settings are saved. Run the antinuke command again any time to change them.\n\n-# F.R.I.D.A.Y • Anti-Nuke",
          avatarURL: avatarOf(guild.client),
          avatarDescription: "F.R.I.D.A.Y"
        })
      ],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] }
    });
  }

  return interaction.deferUpdate();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
module.exports = client => {
  setInterval(cleanup, 5 * 60 * 1000).unref();
  setInterval(() => watchdogTick(client).catch(error => console.error("[AntiNuke] Watchdog tick failed:", error)), WATCHDOG_INTERVAL_MS).unref();
  client.once("clientReady", async () => {
    // Warm the per-guild config cache once; periodic watchdog checks use only
    // cached config and Discord gateway state, never a Firestore polling loop.
    for (const guild of client.guilds.cache.values()) {
      try {
        await protection.getAntinuke(guild.id);
        const serverCfg = await guildConfig.get(guild.id);
        if (serverCfg.quarantineRole) await recoverMissingQuarantineRole(guild, serverCfg);
      } catch (error) {
        console.warn("[AntiNuke] Watchdog startup check failed for " + guild.id + ":", error.message);
      }
    }
    await watchdogTick(client).catch(error => console.error("[AntiNuke] Initial watchdog check failed:", error));
  });

  // ----- command -----
  client.on("messageCreate", async message => {
    if (message.author.bot || !message.guild) return;

    try {
      const parsed = await parseCommand(message);
      if (!parsed || !["antinuke", "wl", "whitelist"].includes(parsed.command)) return;

      const guild = message.guild;

      if (!(await canManage(guild, message.author.id))) {
        return await message.reply({
          content: "Only the server owner, bot owner, or an extra owner can manage Anti-Nuke.",
          allowedMentions: { parse: [] }
        });
      }

      const subcommand = (parsed.args[0] || "").toLowerCase();

      if (["simulate", "simulation", "test"].includes(subcommand)) {
        const report = await runSecurityCheck(guild, { probeAudit: true, simulation: true });
        return await message.reply({
          components: [createCard({
            color: report.issues.length ? COLORS.RED : COLORS.GREEN,
            content: formatSecurityCheck(guild, report, true),
            avatarURL: avatarOf(client),
            avatarDescription: "F.R.I.D.A.Y"
          })],
          flags: MessageFlags.IsComponentsV2,
          allowedMentions: { parse: [] }
        });
      }

      if (["watchdog", "check", "status"].includes(subcommand)) {
        const report = await runSecurityCheck(guild, { probeAudit: true });
        return await message.reply({
          components: [createCard({
            color: report.issues.length ? COLORS.RED : COLORS.GREEN,
            content: formatSecurityCheck(guild, report, false),
            avatarURL: avatarOf(client),
            avatarDescription: "F.R.I.D.A.Y"
          })],
          flags: MessageFlags.IsComponentsV2,
          allowedMentions: { parse: [] }
        });
      }

      // ----- wl / whitelist: add a user to the trusted list and reopen the panel -----
      if (["wl", "whitelist"].includes(parsed.command)) {
        const target = message.mentions.users.first()
          || message.guild.members.cache.get((parsed.args[0] || "").replace(/\D/g, ""))?.user;

        if (!target || !/^\d{17,20}$/.test(target.id)) {
          return await message.reply({
            components: [
              createCard({
                color: COLORS.RED,
                content: "# Whitelist a user\n\n**Usage:** `" + parsed.prefix + "wl <@user | user ID>`\nMention a server member or provide their user ID.\n\n-# F.R.I.D.A.Y • Anti-Nuke",
                avatarURL: avatarOf(client),
                avatarDescription: "F.R.I.D.A.Y"
              })
            ],
            flags: MessageFlags.IsComponentsV2,
            allowedMentions: { parse: [] }
          });
        }

        const current = await protection.getAntinuke(guild.id);
        if (current.trusted.includes(target.id)) {
          return await message.reply(await buildPanel(
            guild,
            message.author.id,
            `<:success_g:1562810067642884177> **${target.tag || target.username}** is already on the Anti-Nuke whitelist.`
          ));
        }

        if (current.trusted.length >= 50) {
          return await message.reply({
            components: [
              createCard({
                color: COLORS.RED,
                content: "# Whitelist is full\n\nThe Anti-Nuke trusted list is limited to 50 users. Remove someone from the trusted list before adding another.\n\n-# F.R.I.D.A.Y • Anti-Nuke",
                avatarURL: avatarOf(client),
                avatarDescription: "F.R.I.D.A.Y"
              })
            ],
            flags: MessageFlags.IsComponentsV2,
            allowedMentions: { parse: [] }
          });
        }

        await protection.updateAntinuke(guild.id, c => {
          c.trusted = [...new Set([...c.trusted, target.id])].slice(0, 50);
        });

        return await message.reply(await buildPanel(
          guild,
          message.author.id,
          `<:success_g:1562810067642884177> **${target.tag || target.username}** has been added to this server\'s Anti-Nuke whitelist. They will be skipped by Anti-Nuke punishment checks in this server only.`
        ));
      }

      if ((parsed.args[0] || "").toLowerCase() === "trust") {
        const id = (parsed.args[1] || message.mentions.users.first()?.id || "").replace(/\D/g, "");

        if (!/^\d{17,20}$/.test(id)) {
          return await message.reply({
            content: `Tell me who: \`${parsed.prefix}antinuke trust <@user | id>\``,
            allowedMentions: { parse: [] }
          });
        }

        const current = await protection.getAntinuke(guild.id);
        const wasTrusted = current.trusted.includes(id);

        await protection.updateAntinuke(guild.id, c => {
          c.trusted = wasTrusted ? c.trusted.filter(t => t !== id) : [...c.trusted, id].slice(0, 50);
        });

        return await message.reply({
          content: wasTrusted ? `<@${id}> is no longer trusted.` : `<@${id}> is now trusted by Anti-Nuke.`,
          allowedMentions: { parse: [] }
        });
      }

      return await message.reply(await buildPanel(guild, message.author.id));
    } catch (error) {
      console.error("[AntiNuke] Command error:", error);
    }
  });

  // ----- panel buttons -----
  client.on("interactionCreate", async interaction => {
    if (!interaction.customId?.startsWith("an:")) return;

    try {
      await handlePanel(interaction);
    } catch (error) {
      console.error("[AntiNuke] Panel error:", error);

      if (!interaction.replied && !interaction.deferred) {
        interaction
          .reply({ content: "Something went wrong. Please run the antinuke command again.", flags: MessageFlags.Ephemeral })
          .catch(() => {});
      }
    }
  });

  // ----- quarantine role guard -----
  // The containment guard is independent from the Anti-Nuke master switch.
  client.on("guildMemberUpdate", async (oldMember, newMember) => {
    try {
      const quarantineGuardHandled = await guardQuarantineRole(oldMember, newMember);
      if (!quarantineGuardHandled) await guardDangerousRoleAssignment(oldMember, newMember);
    } catch (error) {
      console.error("[AntiNuke] Member security guard:", error);
    }
  });

  client.on("channelUpdate", async (_oldChannel, newChannel) => {
    try {
      await guardQuarantineChannel(newChannel);
    } catch (error) {
      console.error("[AntiNuke] Quarantine channel overwrite guard:", error);
    }
  });

  // ----- channels -----
  client.on("channelDelete", async channel => {
    try {
      const guild = channel.guild;
      if (!guild) return;

      const cfg = await enabledFor(guild, "channelDelete");
      if (!cfg) return;

      const snap = snapshotChannel(channel);
      const entry = await findAuditEntry(guild, AuditLogEvent.ChannelDelete, channel.id);
      if (!entry?.executor || await isTrusted(guild, cfg, entry.executor.id)) return;

      remember(bookOf(guild.id, entry.executor.id).channels, { snap });
      await registerHit(guild, cfg, entry.executor, "channelDelete");
    } catch (error) {
      console.error("[AntiNuke] channelDelete:", error);
    }
  });

  client.on("channelCreate", async channel => {
    try {
      const guild = channel.guild;
      if (!guild) return;

      // Keep new channels inaccessible to Quarantine even if channel-create protection is off.
      const serverCfg = await guildConfig.get(guild.id);
      if (serverCfg.quarantineRole) {
        await quarantine.applyToChannel(guild, channel, serverCfg.quarantineRole).catch(error => {
          console.warn("[AntiNuke] Could not apply quarantine overwrite to a new channel:", error.message);
        });
      }

      const cfg = await enabledFor(guild, "channelCreate");
      if (!cfg) return;

      const entry = await findAuditEntry(guild, AuditLogEvent.ChannelCreate, channel.id);
      if (!entry?.executor || await isTrusted(guild, cfg, entry.executor.id)) return;

      remember(bookOf(guild.id, entry.executor.id).createdChannels, { id: channel.id });
      await registerHit(guild, cfg, entry.executor, "channelCreate");
    } catch (error) {
      console.error("[AntiNuke] channelCreate:", error);
    }
  });

  // ----- roles -----
  client.on("roleDelete", async role => {
    try {
      const guild = role.guild;
      if (role.managed) return;
      if (await restoreDeletedQuarantineRole(role)) return;

      const cfg = await enabledFor(guild, "roleDelete");
      if (!cfg) return;

      const snap = snapshotRole(role);
      const entry = await findAuditEntry(guild, AuditLogEvent.RoleDelete, role.id);
      if (!entry?.executor || await isTrusted(guild, cfg, entry.executor.id)) return;

      remember(bookOf(guild.id, entry.executor.id).roles, { id: role.id, snap });
      await registerHit(guild, cfg, entry.executor, "roleDelete");
    } catch (error) {
      console.error("[AntiNuke] roleDelete:", error);
    }
  });

  client.on("roleCreate", async role => {
    try {
      const guild = role.guild;
      if (role.managed) return; // bots/integrations get a managed role automatically
      try {
        await guardDangerousRoleCreation(role);
      } catch (error) {
        console.error("[AntiNuke] Dangerous role creation guard:", error);
      }

      const cfg = await enabledFor(guild, "roleCreate");
      if (!cfg) return;

      const entry = await findAuditEntry(guild, AuditLogEvent.RoleCreate, role.id);
      if (!entry?.executor || await isTrusted(guild, cfg, entry.executor.id)) return;

      remember(bookOf(guild.id, entry.executor.id).createdRoles, { id: role.id });
      await registerHit(guild, cfg, entry.executor, "roleCreate");
    } catch (error) {
      console.error("[AntiNuke] roleCreate:", error);
    }
  });

  client.on("roleUpdate", async (oldRole, newRole) => {
    try {
      const guild = newRole.guild;
      const quarantineConfigHandled = await guardQuarantineRoleUpdate(oldRole, newRole);
      if (quarantineConfigHandled) return;

      const cfg = await enabledFor(guild, "rolePerms");
      if (!cfg) return;

      const gained = DANGEROUS.filter(p => newRole.permissions.has(p) && !oldRole.permissions.has(p));
      if (!gained.length) return;

      const entry = await findAuditEntry(guild, AuditLogEvent.RoleUpdate, newRole.id);
      const actor = entry?.executor || null;
      if (actor && await isTrusted(guild, cfg, actor.id)) return;

      let reverted = true;

      try {
        await newRole.setPermissions(oldRole.permissions, `${REASON}: dangerous permissions were added by someone untrusted`);
      } catch {
        reverted = false;
      }

      // Verify against Discord's current role state instead of assuming that a
      // resolved edit means the dangerous permissions are gone.
      const verifiedRole = await guild.roles.fetch(newRole.id, { force: true }).catch(() => null);
      reverted = Boolean(
        reverted &&
        verifiedRole &&
        verifiedRole.permissions.bitfield === oldRole.permissions.bitfield
      );

      await sendLog(
        guild,
        COLORS.RED,
        `# 🛡️ Anti-Nuke: role permissions\n\n` +
          `**Who:** ${actor ? who(actor) : "Unknown — audit-log attribution unavailable"}\n` +
          `**Role:** ${newRole.name}\n` +
          `**Result:** ${reverted ? "<:success_g:1562810067642884177> Dangerous permissions were removed again" : "<:warning_g:1562810073733136506> Could not revert (my role is too low)"}\n\n` +
          `-# F.R.I.D.A.Y • Anti-Nuke`
      );

      if (actor) {
        await registerHit(guild, cfg, actor, "rolePerms");
      } else {
        await dmOwner(guild,
          "[FRIDAY Anti-Nuke] A role gained dangerous permissions in " + guild.name + " (" + guild.id +
          "), but audit-log attribution was unavailable. Rollback " + (reverted ? "succeeded." : "FAILED; immediate review is required.")
        );
      }
    } catch (error) {
      console.error("[AntiNuke] roleUpdate:", error);
    }
  });

  // ----- bans / kicks (a ban or kick shows up as the member being removed) -----
  client.on("guildMemberRemove", async member => {
    try {
      const guild = member.guild;

      const cfg = await protection.getAntinuke(guild.id);
      if (!cfg.enabled || (!cfg.protections.ban && !cfg.protections.kick)) return;

      const entry = await findRemovalEntry(guild, member.id);
      if (!entry?.executor) return;

      const kind = entry.action === AuditLogEvent.MemberBanAdd ? "ban" : "kick";
      if (!cfg.protections[kind] || await isTrusted(guild, cfg, entry.executor.id)) return;

      await registerHit(guild, cfg, entry.executor, kind);
    } catch (error) {
      console.error("[AntiNuke] guildMemberRemove:", error);
    }
  });

  // ----- webhooks -----
  client.on("webhooksUpdate", async channel => {
    try {
      const guild = channel.guild;
      if (!guild) return;

      const cfg = await enabledFor(guild, "webhook");
      if (!cfg) return;

      let entries = [];

      for (let attempt = 0; attempt < 2 && !entries.length; attempt++) {
        try {
          const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.WebhookCreate, limit: 5 });

          entries = [...logs.entries.values()].filter(
            e => !seenEntries.has(e.id) && Date.now() - e.createdTimestamp < AUDIT_AGE_MS
          );
        } catch {
          return;
        }

        if (!entries.length && attempt === 0) await sleep(AUDIT_RETRY_MS);
      }

      for (const entry of entries) {
        seenEntries.add(entry.id);

        if (!entry.executor || await isTrusted(guild, cfg, entry.executor.id)) continue;

        const hooks = await guild.fetchWebhooks().catch(() => null);
        const hook = hooks?.get(entry.targetId ?? entry.target?.id);

        if (hook) await hook.delete(`${REASON}: webhook created by someone untrusted`).catch(() => {});

        await registerHit(guild, cfg, entry.executor, "webhook");
      }
    } catch (error) {
      console.error("[AntiNuke] webhooksUpdate:", error);
    }
  });

  // ----- unapproved bots -----
  client.on("guildMemberAdd", async member => {
    try {
      if (!member.user.bot) return;

      const guild = member.guild;

      const cfg = await enabledFor(guild, "botAdd");
      if (!cfg || await isTrusted(guild, cfg, member.id)) return;

      const entry = await findAuditEntry(guild, AuditLogEvent.BotAdd, member.id);
      if (!entry?.executor || await isTrusted(guild, cfg, entry.executor.id)) return;

      let removed = true;

      try {
        if (member.kickable === false) throw new Error("not kickable");
        await member.kick(`${REASON}: bot added by someone untrusted`);
      } catch {
        removed = false;
      }

      await sendLog(
        guild,
        COLORS.RED,
        `# 🛡️ Anti-Nuke: bot added\n\n` +
          `**Bot:** ${who(member.user)}\n` +
          `**Added by:** ${who(entry.executor)}\n` +
          `**Result:** ${removed ? "<:success_g:1562810067642884177> The bot was removed" : "<:warning_g:1562810073733136506> Could not remove it (my role is too low)"}\n\n` +
          `Bots must be added by the server owner or a trusted user (or be on the trusted list themselves).\n\n` +
          `-# F.R.I.D.A.Y • Anti-Nuke`
      );
    } catch (error) {
      console.error("[AntiNuke] guildMemberAdd:", error);
    }
  });
};
