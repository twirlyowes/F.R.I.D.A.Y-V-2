/**
 * AutoMod: automatic message rules, configured with buttons.
 *
 *   <prefix>automod     opens the control panel (needs Manage Server)
 *
 * Rules: spam, repeated messages, mass mentions, emoji spam, invite links,
 * links, excessive caps and the server's bad-word list (badwords.js).
 *
 * Everything starts OFF. Recommended: switch it on with the action set to
 * "Log only", watch the log channel for a day, then switch to "Delete".
 *
 * Never checked: bots, members with Administrator / Manage Messages, the
 * server's staff role, and anything inside ignored channels / roles.
 */
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  MessageFlags,
  PermissionsBitField,
  RoleSelectMenuBuilder
} = require("discord.js");

const guildConfig = require("./lib/guildConfig");
const protection = require("./lib/protection");
const { parseCommand } = require("./lib/prefix");
const { COLORS, createCard } = require("./lib/pixelVillaUI");

// ---------------------------------------------------------------------------
// Rule definitions and limits
// ---------------------------------------------------------------------------
const SPAM_SECONDS = 5;
const SPAM_LIMITS = { low: 15, medium: 8, high: 5 }; // "more than N messages in 5s"
const DUPLICATE_COUNT = 3; // the same message this many times...
const DUPLICATE_SECONDS = 30; // ...within this many seconds
const MENTION_MAX = 5; // more than this many users/roles in one message
const EMOJI_MAX = 8; // more than this many emojis in one message
const CAPS_MAX_RATIO = 0.7;
const CAPS_MIN_LETTERS = 12;

const RULES = {
  spam: {
    label: "Spam",
    desc: cfg => `more than ${SPAM_LIMITS[cfg.spamSensitivity]} messages in ${SPAM_SECONDS} seconds`
  },
  duplicates: { label: "Repeats", desc: () => `the same message ${DUPLICATE_COUNT}+ times in ${DUPLICATE_SECONDS}s` },
  mentions: { label: "Mentions", desc: () => `more than ${MENTION_MAX} users/roles in one message` },
  emojis: { label: "Emojis", desc: () => `more than ${EMOJI_MAX} emojis in one message` },
  invites: { label: "Invites", desc: () => "Discord invite links" },
  links: { label: "Links", desc: () => "any link (GIF sites and Discord links are allowed)" },
  caps: { label: "Caps", desc: () => `over ${Math.round(CAPS_MAX_RATIO * 100)}% capital letters` },
  badwords: { label: "Bad words", desc: () => "your server's word list (works even when the master switch is off)" }
};

const ACTIONS = ["log", "delete", "timeout"];
const ACTION_TEXT = {
  log: "Log only",
  delete: "Delete",
  timeout: "Delete + timeout"
};
const ACTION_HELP = {
  log: "Rule hits are only reported in the log channel. Nothing is deleted.",
  delete: "The message is deleted and the hit is logged.",
  timeout: "The message is deleted, the member is timed out, and the hit is logged."
};
const TIMEOUT_CHOICES = [2, 5, 10, 30, 60];
const SENSITIVITIES = ["low", "medium", "high"];

const INVITE_REGEX = /(?:discord\.gg|discord(?:app)?\.com\/invite)\/[a-z0-9-]+/i;
const URL_REGEX = /https?:\/\/[^\s<>]+/gi;
const EMOJI_REGEX = /<a?:\w+:\d+>|\p{Extended_Pictographic}/gu;
const SAFE_HOSTS = ["tenor.com", "giphy.com", "discord.com", "discordapp.com", "discordapp.net"];

// ---------------------------------------------------------------------------
// Short-lived, in-memory tracking (never saved)
// ---------------------------------------------------------------------------
const spamLog = new Map(); // "guild:user" -> [{ ts, id, channelId }]
const duplicateLog = new Map(); // "guild:user" -> [{ ts, text, id, channelId }]
const noticeAt = new Map(); // "guild:user" -> last time we posted a notice
const loggedAt = new Map(); // "guild:user:rule" -> last time we logged it

function cleanup() {
  const now = Date.now();
  const prune = (map, maxAge) => {
    for (const [key, list] of map) {
      const fresh = list.filter(e => now - e.ts < maxAge);
      if (fresh.length) map.set(key, fresh);
      else map.delete(key);
    }
  };

  prune(spamLog, SPAM_SECONDS * 1000);
  prune(duplicateLog, DUPLICATE_SECONDS * 1000);

  for (const [key, ts] of noticeAt) if (now - ts > 60000) noticeAt.delete(key);
  for (const [key, ts] of loggedAt) if (now - ts > 60000) loggedAt.delete(key);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function canManage(member) {
  return (
    member.permissions.has(PermissionsBitField.Flags.Administrator) ||
    member.permissions.has(PermissionsBitField.Flags.ManageGuild)
  );
}

function avatarOf(client) {
  return client.user.displayAvatarURL({ extension: "png", size: 128 });
}

function shorten(text, max = 200) {
  const clean = String(text || "").replace(/`/g, "'").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean || "*no text*";
}

function hostIsSafe(host) {
  return SAFE_HOSTS.some(safe => host === safe || host.endsWith(`.${safe}`));
}

function hasUnsafeLink(content) {
  const urls = content.match(URL_REGEX) || [];

  return urls.some(raw => {
    try {
      return !hostIsSafe(new URL(raw).hostname.replace(/^www\./, "").toLowerCase());
    } catch {
      return true;
    }
  });
}

async function isExempt(message, cfg) {
  const member = message.member;
  if (!member) return true;

  if (
    member.permissions.has(PermissionsBitField.Flags.Administrator) ||
    member.permissions.has(PermissionsBitField.Flags.ManageMessages)
  ) {
    return true;
  }

  if (await guildConfig.isStaff(member)) return true;

  if (cfg.ignoredRoles.length && member.roles.cache.some(role => cfg.ignoredRoles.includes(role.id))) {
    return true;
  }

  const channel = message.channel;

  return (
    cfg.ignoredChannels.includes(message.channelId) ||
    Boolean(channel?.parentId && cfg.ignoredChannels.includes(channel.parentId))
  );
}

// ---------------------------------------------------------------------------
// Rule engine
// ---------------------------------------------------------------------------

/**
 * Returns { rule, ids } for the first rule the message breaks, or null.
 * `stateless` skips the rules that depend on earlier messages (used for edits).
 */
function evaluate(message, cfg, { stateless = false } = {}) {
  const content = message.content || "";
  const key = `${message.guild.id}:${message.author.id}`;
  const now = Date.now();
  const hits = {};

  // Stateful rules first, so their counters stay correct even if another rule also matches
  if (!stateless && cfg.rules.spam) {
    const list = (spamLog.get(key) || []).filter(e => now - e.ts < SPAM_SECONDS * 1000);
    list.push({ ts: now, id: message.id, channelId: message.channelId });
    spamLog.set(key, list);

    if (list.length > SPAM_LIMITS[cfg.spamSensitivity]) {
      hits.spam = list.filter(e => e.channelId === message.channelId).map(e => e.id);
      spamLog.delete(key);
    }
  }

  if (!stateless && cfg.rules.duplicates) {
    const text = content.trim().toLowerCase().replace(/\s+/g, " ");

    if (text.length >= 3) {
      const list = (duplicateLog.get(key) || []).filter(e => now - e.ts < DUPLICATE_SECONDS * 1000);
      list.push({ ts: now, text, id: message.id, channelId: message.channelId });
      duplicateLog.set(key, list);

      const same = list.filter(e => e.text === text);

      if (same.length >= DUPLICATE_COUNT) {
        hits.duplicates = same.filter(e => e.channelId === message.channelId).map(e => e.id);
        duplicateLog.delete(key);
      }
    }
  }

  if (cfg.rules.invites && INVITE_REGEX.test(content)) hits.invites = [message.id];

  if (cfg.rules.mentions) {
    const unique = message.mentions.users.size + message.mentions.roles.size;
    if (unique > MENTION_MAX) hits.mentions = [message.id];
  }

  if (cfg.rules.emojis && (content.match(EMOJI_REGEX) || []).length > EMOJI_MAX) {
    hits.emojis = [message.id];
  }

  if (cfg.rules.links && hasUnsafeLink(content)) hits.links = [message.id];

  if (cfg.rules.caps) {
    const letters = content.replace(/[^A-Za-z]/g, "");

    if (letters.length >= CAPS_MIN_LETTERS) {
      const upper = letters.replace(/[^A-Z]/g, "").length;
      if (upper / letters.length > CAPS_MAX_RATIO) hits.caps = [message.id];
    }
  }

  for (const rule of ["invites", "mentions", "links", "emojis", "caps", "duplicates", "spam"]) {
    if (hits[rule]) return { rule, ids: hits[rule] };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Taking action
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
    console.error("[AutoMod] Failed to send log:", error);
  }
}

async function removeMessages(message, ids) {
  const unique = [...new Set(ids)];

  if (unique.length > 1 && typeof message.channel.bulkDelete === "function") {
    try {
      await message.channel.bulkDelete(unique, true);
      return;
    } catch {
      // fall through to deleting just this message
    }
  }

  await message.delete().catch(() => {});
}

async function handleViolation(message, cfg, result) {
  const guild = message.guild;
  const member = message.member;
  const label = RULES[result.rule].label;
  const key = `${guild.id}:${message.author.id}`;
  const now = Date.now();

  let outcome = ACTION_TEXT.log + " (nothing deleted)";

  if (cfg.action !== "log") {
    await removeMessages(message, result.ids);
    outcome = "Message deleted";

    if (!noticeAt.has(key) || now - noticeAt.get(key) > 5000) {
      noticeAt.set(key, now);

      message.channel
        .send({
          content: `<:warning_g:1561271566233501797> <@${message.author.id}>, your message was removed by AutoMod (${label}).`,
          allowedMentions: { parse: [] }
        })
        .then(notice => setTimeout(() => notice.delete().catch(() => {}), 6000).unref?.())
        .catch(() => {});
    }

    if (cfg.action === "timeout") {
      try {
        if (member.moderatable === false) {
          outcome += ", could not time out (my role is too low)";
        } else {
          await member.timeout(cfg.timeoutMinutes * 60 * 1000, `AutoMod: ${label}`);
          outcome += `, timed out for ${cfg.timeoutMinutes} min`;
        }
      } catch (error) {
        outcome += ", timeout failed";
        console.error("[AutoMod] Timeout failed:", error.message);
      }
    }
  }

  // One log line per member and rule every 10 seconds, so a burst can't flood the log channel
  const logKey = `${key}:${result.rule}`;

  if (!loggedAt.has(logKey) || now - loggedAt.get(logKey) > 10000) {
    loggedAt.set(logKey, now);

    await sendLog(
      guild,
      cfg.action === "log" ? COLORS.SKY_BLUE : COLORS.RED,
      `# 🛡️ AutoMod\n\n` +
        `**Rule:** ${label}\n` +
        `**Member:** <@${message.author.id}> (\`${message.author.id}\`)\n` +
        `**Channel:** <#${message.channelId}>\n` +
        `**Result:** ${outcome}\n\n` +
        `> ${shorten(message.content)}\n\n` +
        `-# F.R.I.D.A.Y • AutoMod`
    );
  }
}

// ---------------------------------------------------------------------------
// Control panel (buttons), stateless: state lives in the customIds + Firestore
// ---------------------------------------------------------------------------
function flag(on) {
  return on ? "<:success_g:1561271843346714777>" : "⬜";
}

function toggleButton(id, label, on) {
  return new ButtonBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setStyle(on ? ButtonStyle.Success : ButtonStyle.Secondary);
}

async function buildPanel(guild, userId, note = null) {
  const cfg = await protection.getAutomod(guild.id);

  const ruleLines = Object.entries(RULES).map(
    ([key, def]) => `${flag(cfg.rules[key])} **${def.label}** — ${def.desc(cfg)}`
  );

  const list = (ids, wrap) => (ids.length ? ids.slice(0, 15).map(wrap).join(" ") : "*none*");

  const logWarning = (await guildConfig.getLogChannel(guild))
    ? ""
    : "\n<:warning_g:1561271566233501797> No log channel is set, so hits won't be reported. Set one with the config command (`logs`).\n";

  const card = createCard({
    color: cfg.enabled ? COLORS.GREEN : COLORS.SKY_BLUE,
    content:
      `# AutoMod\n\n${note ? `${note}\n\n` : ""}` +
      `**Master switch:** ${cfg.enabled ? "🟢 ON" : "🔴 OFF"}\n` +
      `**Action:** ${ACTION_TEXT[cfg.action]}${cfg.action === "timeout" ? ` (${cfg.timeoutMinutes} min)` : ""}\n` +
      `> ${ACTION_HELP[cfg.action]}\n${logWarning}\n` +
      `${ruleLines.join("\n")}\n\n` +
      `**Ignored channels:** ${list(cfg.ignoredChannels, id => `<#${id}>`)}\n` +
      `**Ignored roles:** ${list(cfg.ignoredRoles, id => `<@&${id}>`)}\n\n` +
      `-# Staff, admins and members with Manage Messages are never checked.\n` +
      `-# F.R.I.D.A.Y • AutoMod`,
    avatarURL: avatarOf(guild.client),
    avatarDescription: "F.R.I.D.A.Y"
  });

  const toggle = key => toggleButton(`am:tog:${key}:${userId}`, RULES[key].label, cfg.rules[key]);

  const row1 = new ActionRowBuilder().addComponents(
    ["spam", "duplicates", "mentions", "emojis", "invites"].map(toggle)
  );

  const row2 = new ActionRowBuilder().addComponents(
    ...["links", "caps", "badwords"].map(toggle),
    new ButtonBuilder()
      .setCustomId(`am:reset:${userId}`)
      .setLabel("Reset")
      .setStyle(ButtonStyle.Danger)
  );

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`am:master:${userId}`)
      .setLabel(cfg.enabled ? "AutoMod: ON" : "AutoMod: OFF")
      .setStyle(cfg.enabled ? ButtonStyle.Success : ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`am:action:${userId}`)
      .setLabel(`Action: ${ACTION_TEXT[cfg.action]}`)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`am:time:${userId}`)
      .setLabel(`Timeout: ${cfg.timeoutMinutes}m`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(cfg.action !== "timeout"),
    new ButtonBuilder()
      .setCustomId(`am:sens:${userId}`)
      .setLabel(`Spam: ${cfg.spamSensitivity[0].toUpperCase()}${cfg.spamSensitivity.slice(1)}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!cfg.rules.spam),
    new ButtonBuilder()
      .setCustomId(`am:done:${userId}`)
      .setLabel("Done")
      .setStyle(ButtonStyle.Success)
  );

  const channelMenu = new ChannelSelectMenuBuilder()
    .setCustomId(`am:chan:${userId}`)
    .setPlaceholder("Ignored channels (AutoMod skips these)")
    .setChannelTypes([
      ChannelType.GuildText,
      ChannelType.GuildAnnouncement,
      ChannelType.GuildVoice,
      ChannelType.GuildCategory,
      ChannelType.GuildForum
    ])
    .setMinValues(0)
    .setMaxValues(25);

  const channelDefaults = cfg.ignoredChannels.filter(id => guild.channels.cache.has(id)).slice(0, 25);
  if (channelDefaults.length) channelMenu.setDefaultChannels(...channelDefaults);

  const roleMenu = new RoleSelectMenuBuilder()
    .setCustomId(`am:role:${userId}`)
    .setPlaceholder("Ignored roles (AutoMod skips these)")
    .setMinValues(0)
    .setMaxValues(25);

  const roleDefaults = cfg.ignoredRoles.filter(id => guild.roles.cache.has(id)).slice(0, 25);
  if (roleDefaults.length) roleMenu.setDefaultRoles(...roleDefaults);

  return {
    components: [
      card,
      row1,
      row2,
      row3,
      new ActionRowBuilder().addComponents(channelMenu),
      new ActionRowBuilder().addComponents(roleMenu)
    ],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] }
  };
}

function next(list, current) {
  return list[(list.indexOf(current) + 1) % list.length];
}

async function handlePanel(interaction) {
  const parts = interaction.customId.split(":"); // am:<action>:...:<userId>
  const action = parts[1];
  const userId = parts[parts.length - 1];

  if (interaction.user.id !== userId) {
    return interaction.reply({
      content: "This AutoMod panel belongs to someone else. Run the automod command yourself to open your own.",
      flags: MessageFlags.Ephemeral
    });
  }

  if (!interaction.guild || !interaction.member || !canManage(interaction.member)) {
    return interaction.reply({
      content: "You need the **Manage Server** permission to change AutoMod.",
      flags: MessageFlags.Ephemeral
    });
  }

  const guild = interaction.guild;
  const refresh = async note => interaction.update(await buildPanel(guild, userId, note));

  if (action === "tog" && interaction.isButton()) {
    const rule = parts[2];
    if (!RULES[rule]) return interaction.deferUpdate();

    const cfg = await protection.updateAutomod(guild.id, c => {
      c.rules[rule] = !c.rules[rule];
    });

    return refresh(`${cfg.rules[rule] ? "<:success_g:1561271843346714777>" : "⬜"} **${RULES[rule].label}** is now ${cfg.rules[rule] ? "on" : "off"}.`);
  }

  if (action === "master" && interaction.isButton()) {
    const cfg = await protection.updateAutomod(guild.id, c => {
      c.enabled = !c.enabled;
    });

    return refresh(`AutoMod is now **${cfg.enabled ? "ON" : "OFF"}**.`);
  }

  if (action === "action" && interaction.isButton()) {
    const cfg = await protection.updateAutomod(guild.id, c => {
      c.action = next(ACTIONS, c.action);
    });

    return refresh(`Action changed to **${ACTION_TEXT[cfg.action]}**.`);
  }

  if (action === "time" && interaction.isButton()) {
    const cfg = await protection.updateAutomod(guild.id, c => {
      c.timeoutMinutes = next(TIMEOUT_CHOICES, c.timeoutMinutes);
    });

    return refresh(`Timeout length is now **${cfg.timeoutMinutes} minutes**.`);
  }

  if (action === "sens" && interaction.isButton()) {
    const cfg = await protection.updateAutomod(guild.id, c => {
      c.spamSensitivity = next(SENSITIVITIES, c.spamSensitivity);
    });

    return refresh(`Spam sensitivity is now **${cfg.spamSensitivity}** (more than ${SPAM_LIMITS[cfg.spamSensitivity]} messages in ${SPAM_SECONDS}s).`);
  }

  if (action === "reset" && interaction.isButton()) {
    await protection.updateAutomod(guild.id, () => protection.clone(protection.AUTOMOD_DEFAULTS));
    return refresh("🧹 AutoMod was reset to its defaults (and switched off).");
  }

  if (action === "chan" && interaction.isChannelSelectMenu()) {
    const cfg = await protection.updateAutomod(guild.id, c => {
      c.ignoredChannels = interaction.values.slice(0, 25);
    });

    return refresh(`Ignored channels updated (${cfg.ignoredChannels.length}).`);
  }

  if (action === "role" && interaction.isRoleSelectMenu()) {
    const cfg = await protection.updateAutomod(guild.id, c => {
      c.ignoredRoles = interaction.values.filter(id => id !== guild.id).slice(0, 25);
    });

    return refresh(`Ignored roles updated (${cfg.ignoredRoles.length}).`);
  }

  if (action === "done" && interaction.isButton()) {
    return interaction.update({
      components: [
        createCard({
          color: COLORS.GREEN,
          content: "# AutoMod saved\n\nYour AutoMod settings are saved. Run the automod command again any time to change them.\n\n-# F.R.I.D.A.Y • AutoMod",
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

  client.on("messageCreate", async message => {
    if (message.author.bot || !message.guild || !message.member) return;

    try {
      const parsed = await parseCommand(message);

      if (parsed && parsed.command === "automod") {
        if (parsed.args.length) return message.reply({ content: "Usage: " + parsed.prefix + "automod (open the configuration panel).", allowedMentions: { parse: [] } });
        if (!canManage(message.member)) {
          return message.reply({
            content: "You need the **Manage Server** permission to change AutoMod.",
            allowedMentions: { parse: [] }
          });
        }

        return message.reply(await buildPanel(message.guild, message.author.id));
      }

      const cfg = await protection.getAutomod(message.guild.id);
      if (!cfg.enabled) return;

      if (await isExempt(message, cfg)) return;

      const result = evaluate(message, cfg);
      if (result) await handleViolation(message, cfg, result);
    } catch (error) {
      console.error("[AutoMod] Error:", error);
    }
  });

  // Catch rule-breaking edits (for example adding a link after posting)
  client.on("messageUpdate", async (oldMessage, newMessage) => {
    try {
      if (newMessage.partial || !newMessage.guild || !newMessage.member) return;
      if (newMessage.author?.bot) return;
      if (oldMessage.content === newMessage.content) return;

      const cfg = await protection.getAutomod(newMessage.guild.id);
      if (!cfg.enabled) return;
      if (await isExempt(newMessage, cfg)) return;

      const result = evaluate(newMessage, cfg, { stateless: true });
      if (result) await handleViolation(newMessage, cfg, result);
    } catch (error) {
      console.error("[AutoMod] Edit check error:", error);
    }
  });

  client.on("interactionCreate", async interaction => {
    if (!interaction.customId?.startsWith("am:")) return;

    try {
      await handlePanel(interaction);
    } catch (error) {
      console.error("[AutoMod] Panel error:", error);

      if (!interaction.replied && !interaction.deferred) {
        interaction
          .reply({ content: "Something went wrong. Please run the automod command again.", flags: MessageFlags.Ephemeral })
          .catch(() => {});
      }
    }
  });
};
