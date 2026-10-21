const {
  ActionRowBuilder, AuditLogEvent, ButtonBuilder, ButtonStyle, MessageFlags
} = require("discord.js");
const db = require("./firebase");
const protection = require("./lib/protection");
const owners = require("./lib/owners");
const { parseCommand } = require("./lib/prefix");
const { COLORS, createCard } = require("./lib/pixelVillaUI");

const cache = new Map();
const docFor = guildId => db.collection("antibot_configs").doc(guildId);

async function getConfig(guildId) {
  if (cache.has(guildId)) return cache.get(guildId);
  try {
    const doc = await docFor(guildId).get();
    const cfg = { enabled: doc.exists ? doc.data()?.enabled === true : false };
    cache.set(guildId, cfg);
    return cfg;
  } catch (error) {
    console.error("[AntiBot] Config read failed:", error.message);
    return { enabled: false };
  }
}

async function setEnabled(guildId, enabled) {
  await docFor(guildId).set({ enabled }, { merge: true });
  const cfg = { enabled };
  cache.set(guildId, cfg);
  return cfg;
}

function canManage(guild, userId) {
  return userId === guild.ownerId || owners.isOwner(userId) || owners.isExtraOwner(userId);
}

function card(guild, color, content) {
  return createCard({
    color, content,
    avatarURL: guild.client.user.displayAvatarURL({ extension: "png", size: 128 }),
    avatarDescription: "F.R.I.D.A.Y"
  });
}

async function buildPanel(guild, userId, note = "") {
  const cfg = await getConfig(guild.id);
  const panel = card(guild, cfg.enabled ? COLORS.GREEN : COLORS.SKY_BLUE,
    `# AntiBot Protection\n\n` +
    (note ? `${note}\n\n` : "") +
    `**Status:** ${cfg.enabled ? "🟢 ON" : "🔴 OFF"}\n\n` +
    `When enabled, FRIDAY checks who invited each new bot. Bots added by the server owner, bot owner, extra owners, or AntiNuke trusted users are allowed. If the inviter cannot be verified from the audit log, FRIDAY will alert rather than automatically kick a potentially legitimate bot.\n\n` +
    `**Required permissions:** View Audit Log, Kick Members\n\n-# F.R.I.D.A.Y • AntiBot`);
  const button = new ButtonBuilder()
    .setCustomId(`ab:toggle:${userId}`)
    .setLabel(cfg.enabled ? "AntiBot: ON" : "AntiBot: OFF")
    .setStyle(cfg.enabled ? ButtonStyle.Success : ButtonStyle.Danger);
  return {
    components: [panel, new ActionRowBuilder().addComponents(button)],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] }
  };
}

async function findBotAdd(guild, botId) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.BotAdd, limit: 8 });
      const entry = logs.entries.find(e =>
        (e.targetId ?? e.target?.id) === botId &&
        Date.now() - e.createdTimestamp < 20000
      );
      if (entry) return entry;
    } catch (error) {
      console.warn("[AntiBot] Cannot read audit log:", error.message);
      return null;
    }
    if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 1200));
  }
  return null;
}

module.exports = client => {
  client.once("clientReady", () => owners.resolve(client));
  client.once("ready", () => owners.resolve(client));

  client.on("messageCreate", async message => {
    if (message.author.bot || !message.guild) return;
    const parsed = await parseCommand(message);
    if (!parsed || parsed.command !== "antibot") return;

    if (!canManage(message.guild, message.author.id)) {
      return message.reply({
        content: "Only the server owner, bot owner, or an extra owner can manage AntiBot.",
        allowedMentions: { parse: [] }
      });
    }
    try {
      return message.reply(await buildPanel(message.guild, message.author.id));
    } catch (error) {
      console.error("[AntiBot] Panel error:", error);
      return message.reply({ content: "Could not open AntiBot settings.", allowedMentions: { parse: [] } });
    }
  });

  client.on("interactionCreate", async interaction => {
    if (!interaction.customId?.startsWith("ab:")) return;
    try {
      const [, action, panelOwnerId] = interaction.customId.split(":");
      if (!interaction.guild || interaction.user.id !== panelOwnerId) {
        return interaction.reply({ content: "This AntiBot panel belongs to someone else.", flags: MessageFlags.Ephemeral });
      }
      if (!canManage(interaction.guild, interaction.user.id)) {
        return interaction.reply({ content: "You cannot manage AntiBot in this server.", flags: MessageFlags.Ephemeral });
      }
      if (action !== "toggle" || !interaction.isButton()) return interaction.deferUpdate();
      const current = await getConfig(interaction.guild.id);
      const next = await setEnabled(interaction.guild.id, !current.enabled);
      return interaction.update(await buildPanel(interaction.guild, panelOwnerId,
        `AntiBot protection is now **${next.enabled ? "ON" : "OFF"}**.`));
    } catch (error) {
      console.error("[AntiBot] Button error:", error);
      if (!interaction.replied && !interaction.deferred) {
        return interaction.reply({ content: "AntiBot could not process that button.", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  });

  client.on("guildMemberAdd", async member => {
    if (!member.user.bot) return;
    try {
      const cfg = await getConfig(member.guild.id);
      if (!cfg.enabled) return;

      // Anti-Nuke already handles this same event when its bot-add protection is on.
      // Avoid racing it with a second kick and duplicate log messages.
      const antinuke = await protection.getAntinuke(member.guild.id);
      if (antinuke.enabled && antinuke.protections.botAdd) return;

      const entry = await findBotAdd(member.guild, member.id);
      if (!entry?.executor) {
        const channel = await require("./lib/guildConfig").getLogChannel(member.guild).catch(() => null);
        if (channel) await channel.send({
          components: [card(member.guild, COLORS.SKY_BLUE,
            `# AntiBot: inviter unverified\n\n**Bot:** <@${member.id}>\nFRIDAY could not verify the inviter from the audit log, so it did not automatically remove the bot. Check the server audit log.\n\n-# F.R.I.D.A.Y • AntiBot`)],
          flags: MessageFlags.IsComponentsV2,
          allowedMentions: { parse: [] }
        }).catch(() => {});
        return;
      }

      const inviterId = entry.executor.id;
      const trusted = inviterId === member.guild.ownerId ||
        owners.isOwner(inviterId) ||
        owners.isExtraOwner(inviterId) ||
        antinuke.trusted.includes(inviterId);

      if (trusted) return;

      let removed = false;
      try {
        if (member.kickable) {
          await member.kick("F.R.I.D.A.Y AntiBot: bot added by an untrusted inviter");
          removed = true;
        }
      } catch (error) {
        console.error("[AntiBot] Could not remove bot:", error.message);
      }

      const channel = await require("./lib/guildConfig").getLogChannel(member.guild).catch(() => null);
      if (channel) await channel.send({
        components: [card(member.guild, COLORS.RED,
          `# AntiBot triggered\n\n**Bot:** <@${member.id}> (` + "`" + `${member.id}` + "`" + `)\n**Invited by:** <@${inviterId}>\n**Result:** ${removed ? "Bot removed" : "Could not remove bot — check my role and Kick Members permission."}\n\n-# F.R.I.D.A.Y • AntiBot`)],
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: { parse: [] }
      }).catch(() => {});
    } catch (error) {
      console.error("[AntiBot] guildMemberAdd error:", error);
    }
  });
};
