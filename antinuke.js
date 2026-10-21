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
const protection = require("./lib/protection");
const owners = require("./lib/owners");
const { parseCommand } = require("./lib/prefix");
const { extractSnowflake } = require("./lib/commandArgs");
const { COLORS, createCard } = require("./lib/pixelVillaUI");

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------
const FEATURES = {
  channelDelete: { label: "Channel delete", desc: "mass channel deletion" },
  channelCreate: { label: "Channel create", desc: "mass channel creation" },
  roleDelete: { label: "Role delete", desc: "mass role deletion" },
  roleCreate: { label: "Role create", desc: "mass role creation" },
  ban: { label: "Bans", desc: "mass banning" },
  kick: { label: "Kicks", desc: "mass kicking" },
  webhook: { label: "Webhooks", desc: "new webhooks are deleted" },
  botAdd: { label: "Anti-Bot", desc: "blocks bots added by untrusted users" },
  rolePerms: { label: "Role perms", desc: "dangerous permissions given to a role are reverted" }
};

const PUNISHMENTS = ["strip", "kick", "ban"];
const PUNISHMENT_TEXT = { strip: "Strip roles", kick: "Kick", ban: "Ban" };
const PUNISHMENT_HELP = {
  strip: "Removes their roles that have dangerous permissions (the gentlest option).",
  kick: "Kicks them from the server.",
  ban: "Bans them from the server."
};
const THRESHOLDS = [3, 5, 10];

// Permissions that make a role "dangerous" to hand out or keep
const DANGEROUS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ManageWebhooks
];

const ROLE_PERMS_LIMIT = 2; // permission grabs in the window before punishment
const PUNISH_COOLDOWN_MS = 60 * 1000;
const BOOK_KEEP_MS = 2 * 60 * 1000;
const BOOK_MAX = 200;
const AUDIT_AGE_MS = 15 * 1000;
const AUDIT_RETRY_MS = Number(process.env.ANTINUKE_AUDIT_RETRY_MS) || 1200;
const REASON = "F.R.I.D.A.Y Anti-Nuke";

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
function isTrusted(guild, cfg, userId) {
  return (
    userId === guild.ownerId ||
    userId === guild.client.user.id ||
    cfg.trusted.includes(userId)
  );
}

/** Only the server owner (or the bot owner) may change Anti-Nuke. */
function canManage(guild, userId) {
  return userId === guild.ownerId || owners.canManageSecurity(userId);
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

    return {
      ok: stuck === 0,
      text:
        `Stripped ${removable.size} role(s): ${removable.map(r => r.name).join(", ")}` +
        (stuck ? `. ${stuck} role(s) above mine could not be removed` : "")
    };
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
      await guild.roles.create({ ...item.snap, reason: `${REASON}: restoring a deleted role` });
      out.restoredRoles++;
    } catch {
      out.failed++;
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

  // Stop the damage first...
  const punishment = await punish(guild, user, cfg);

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
    `**Response:** ${punishment.ok ? "<:success_g:1561271843346714777>" : "<:warning_g:1561271566233501797>"} ${punishment.text}\n` +
    `**Recovery:** ${recoveryText}`;

  await sendLog(
    guild,
    COLORS.RED,
    `# 🚨 Anti-Nuke triggered\n\n${summary}\n\n` +
      `${punishment.ok ? "" : "<:warning_g:1561271566233501797> The punishment did not fully work. Move my role to the top of the role list and check the audit log.\n\n"}` +
      `-# F.R.I.D.A.Y • Anti-Nuke`
  );

  await dmOwner(
    guild,
    `🚨 Anti-Nuke triggered in **${guild.name}**\n` +
      `${user.tag || user.username || user.id} (${user.id}) did ${total}× ${FEATURES[kind].label.toLowerCase()} within ${cfg.windowSeconds}s.\n` +
      `${punishment.ok ? "<:success_g:1561271843346714777>" : "<:warning_g:1561271566233501797>"} ${punishment.text}\n${recoveryText}`
  );
}

// ---------------------------------------------------------------------------
// Control panel (buttons), owner only
// ---------------------------------------------------------------------------
const flag = on => (on ? "<:success_g:1561271843346714777>" : "⬜");

function toggleButton(id, label, on) {
  return new ButtonBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setStyle(on ? ButtonStyle.Success : ButtonStyle.Secondary);
}

async function buildPanel(guild, userId, note = null) {
  const cfg = await protection.getAntinuke(guild.id);
  const me = guild.members.me;

  const permissionLine = BOT_PERMISSIONS.map(
    ([key, label]) => `${me?.permissions.has(PermissionFlagsBits[key]) ? "<:success_g:1561271843346714777>" : "<:error_g:1561271715164721245>"} ${label}`
  ).join(" • ");

  const auditMissing = !me?.permissions.has(PermissionFlagsBits.ViewAuditLog);

  const featureLines = Object.entries(FEATURES).map(
    ([key, def]) => `${flag(cfg.protections[key])} **${def.label}** — ${def.desc}`
  );

  const trusted = cfg.trusted.length
    ? cfg.trusted.slice(0, 20).map(id => `<@${id}>`).join(" ")
    : "*nobody yet*";

  const card = createCard({
    color: cfg.enabled ? COLORS.GREEN : COLORS.SKY_BLUE,
    content:
      `# Anti-Nuke\n\n${note ? `${note}\n\n` : ""}` +
      `**Master switch:** ${cfg.enabled ? "🟢 ON" : "🔴 OFF"}\n` +
      `**Punishment:** ${PUNISHMENT_TEXT[cfg.punishment]}\n> ${PUNISHMENT_HELP[cfg.punishment]}\n` +
      `**Trigger:** ${cfg.threshold} mass actions within ${cfg.windowSeconds} seconds\n` +
      `**Auto-restore:** ${cfg.restore ? "on" : "off"} (puts back channels/roles the offender deleted)\n\n` +
      `${featureLines.join("\n")}\n\n` +
      `**Trusted (never punished):** ${trusted}\n` +
      `-# The server owner and this bot are always trusted. Add your other bots here (ticket bots, security bots).\n\n` +
      `**My permissions:** ${permissionLine}\n` +
      `${auditMissing ? "<:error_g:1561271715164721245> I need **View Audit Log**, or Anti-Nuke cannot see who did something.\n" : ""}\n` +
      `-# F.R.I.D.A.Y • Anti-Nuke`,
    avatarURL: avatarOf(guild.client),
    avatarDescription: "F.R.I.D.A.Y"
  });

  const toggle = key => toggleButton(`an:tog:${key}:${userId}`, FEATURES[key].label, cfg.protections[key]);

  const row1 = new ActionRowBuilder().addComponents(
    ["channelDelete", "channelCreate", "roleDelete", "roleCreate", "ban"].map(toggle)
  );

  const row2 = new ActionRowBuilder().addComponents(
    ...["kick", "webhook", "botAdd", "rolePerms"].map(toggle),
    new ButtonBuilder()
      .setCustomId(`an:untrust:${userId}`)
      .setLabel("Clear trusted")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!cfg.trusted.length)
  );

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`an:master:${userId}`)
      .setLabel(cfg.enabled ? "Anti-Nuke: ON" : "Anti-Nuke: OFF")
      .setStyle(cfg.enabled ? ButtonStyle.Success : ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`an:pun:${userId}`)
      .setLabel(`Punish: ${PUNISHMENT_TEXT[cfg.punishment]}`)
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

  const trustMenu = new UserSelectMenuBuilder()
    .setCustomId(`an:trust:${userId}`)
    .setPlaceholder("Add trusted users or bots (they are never punished)")
    .setMinValues(1)
    .setMaxValues(10);

  return {
    components: [card, row1, row2, row3, new ActionRowBuilder().addComponents(trustMenu)],
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
    return interaction.reply({
      content: "This Anti-Nuke panel belongs to someone else.",
      flags: MessageFlags.Ephemeral
    });
  }

  if (!interaction.guild || !canManage(interaction.guild, interaction.user.id)) {
    return interaction.reply({
      content: "Only the server owner, bot owner, or an authorized extra owner can change Anti-Nuke.",
      flags: MessageFlags.Ephemeral
    });
  }

  const guild = interaction.guild;
  const refresh = async note => interaction.update(await buildPanel(guild, userId, note));

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
        (cfg.enabled && auditMissing ? "\n<:error_g:1561271715164721245> It can't work until I have **View Audit Log**." : "")
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

  // ----- command -----
  client.on("messageCreate", async message => {
    if (message.author.bot || !message.guild) return;

    try {
      const parsed = await parseCommand(message);
      if (!parsed || parsed.command !== "antinuke") return;

      const guild = message.guild;

      if (!canManage(guild, message.author.id)) {
        return message.reply({
          content: "Only the server owner, bot owner, or an authorized extra owner can manage Anti-Nuke.",
          allowedMentions: { parse: [] }
        });
      }

      if ((parsed.args[0] || "").toLowerCase() === "trust") {
        if (parsed.args.length !== 2) return message.reply({ content: `Usage: ${parsed.prefix}antinuke trust <@user | id>`, allowedMentions: { parse: [] } });
        const id = extractSnowflake(parsed.args[1]);

        if (!id) {
          return message.reply({
            content: `Tell me who: \`${parsed.prefix}antinuke trust <@user | id>\``,
            allowedMentions: { parse: [] }
          });
        }

        const current = await protection.getAntinuke(guild.id);
        const wasTrusted = current.trusted.includes(id);

        await protection.updateAntinuke(guild.id, c => {
          c.trusted = wasTrusted ? c.trusted.filter(t => t !== id) : [...c.trusted, id].slice(0, 50);
        });

        return message.reply({
          content: wasTrusted ? `<@${id}> is no longer trusted.` : `<@${id}> is now trusted by Anti-Nuke.`,
          allowedMentions: { parse: [] }
        });
      }

      if (parsed.args.length) return message.reply({ content: `Usage: ${parsed.prefix}antinuke or ${parsed.prefix}antinuke trust <@user | id>`, allowedMentions: { parse: [] } });
      return message.reply(await buildPanel(guild, message.author.id));
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

  // ----- channels -----
  client.on("channelDelete", async channel => {
    try {
      const guild = channel.guild;
      if (!guild) return;

      const cfg = await enabledFor(guild, "channelDelete");
      if (!cfg) return;

      const snap = snapshotChannel(channel);
      const entry = await findAuditEntry(guild, AuditLogEvent.ChannelDelete, channel.id);
      if (!entry?.executor || isTrusted(guild, cfg, entry.executor.id)) return;

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

      const cfg = await enabledFor(guild, "channelCreate");
      if (!cfg) return;

      const entry = await findAuditEntry(guild, AuditLogEvent.ChannelCreate, channel.id);
      if (!entry?.executor || isTrusted(guild, cfg, entry.executor.id)) return;

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

      const cfg = await enabledFor(guild, "roleDelete");
      if (!cfg) return;

      const snap = snapshotRole(role);
      const entry = await findAuditEntry(guild, AuditLogEvent.RoleDelete, role.id);
      if (!entry?.executor || isTrusted(guild, cfg, entry.executor.id)) return;

      remember(bookOf(guild.id, entry.executor.id).roles, { snap });
      await registerHit(guild, cfg, entry.executor, "roleDelete");
    } catch (error) {
      console.error("[AntiNuke] roleDelete:", error);
    }
  });

  client.on("roleCreate", async role => {
    try {
      const guild = role.guild;
      if (role.managed) return; // bots/integrations get a managed role automatically

      const cfg = await enabledFor(guild, "roleCreate");
      if (!cfg) return;

      const entry = await findAuditEntry(guild, AuditLogEvent.RoleCreate, role.id);
      if (!entry?.executor || isTrusted(guild, cfg, entry.executor.id)) return;

      remember(bookOf(guild.id, entry.executor.id).createdRoles, { id: role.id });
      await registerHit(guild, cfg, entry.executor, "roleCreate");
    } catch (error) {
      console.error("[AntiNuke] roleCreate:", error);
    }
  });

  client.on("roleUpdate", async (oldRole, newRole) => {
    try {
      const guild = newRole.guild;

      const cfg = await enabledFor(guild, "rolePerms");
      if (!cfg) return;

      const gained = DANGEROUS.filter(p => newRole.permissions.has(p) && !oldRole.permissions.has(p));
      if (!gained.length) return;

      const entry = await findAuditEntry(guild, AuditLogEvent.RoleUpdate, newRole.id);
      if (!entry?.executor || isTrusted(guild, cfg, entry.executor.id)) return;

      let reverted = true;

      try {
        await newRole.setPermissions(oldRole.permissions, `${REASON}: dangerous permissions were added by someone untrusted`);
      } catch {
        reverted = false;
      }

      await sendLog(
        guild,
        COLORS.RED,
        `# 🛡️ Anti-Nuke: role permissions\n\n` +
          `**Who:** ${who(entry.executor)}\n` +
          `**Role:** ${newRole.name}\n` +
          `**Result:** ${reverted ? "<:success_g:1561271843346714777> Dangerous permissions were removed again" : "<:warning_g:1561271566233501797> Could not revert (my role is too low)"}\n\n` +
          `-# F.R.I.D.A.Y • Anti-Nuke`
      );

      await registerHit(guild, cfg, entry.executor, "rolePerms");
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
      if (!cfg.protections[kind] || isTrusted(guild, cfg, entry.executor.id)) return;

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

        if (!entry.executor || isTrusted(guild, cfg, entry.executor.id)) continue;

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
      if (!cfg || isTrusted(guild, cfg, member.id)) return;

      const entry = await findAuditEntry(guild, AuditLogEvent.BotAdd, member.id);
      if (!entry?.executor || isTrusted(guild, cfg, entry.executor.id)) return;

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
          `**Result:** ${removed ? "<:success_g:1561271843346714777> The bot was removed" : "<:warning_g:1561271566233501797> Could not remove it (my role is too low)"}\n\n` +
          `Bots must be added by the server owner or a trusted user (or be on the trusted list themselves).\n\n` +
          `-# F.R.I.D.A.Y • Anti-Nuke`
      );
    } catch (error) {
      console.error("[AntiNuke] guildMemberAdd:", error);
    }
  });
};
