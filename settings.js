const {
  ChannelType,
  MessageFlags,
  PermissionsBitField
} = require("discord.js");

const guildConfig = require("./lib/guildConfig");
const { COLORS, createCard } = require("./lib/pixelVillaUI");

const { parseCommand, getPrefix, DEFAULT_PREFIX, MAX_PREFIX_LENGTH } = require("./lib/prefix");
const { SETTINGS } = guildConfig;

function reply(message, color, content) {
  return message.reply({
    components: [
      createCard({
        color,
        content,
        avatarURL: message.client.user.displayAvatarURL({
          extension: "png",
          size: 128
        }),
        avatarDescription: "F.R.I.D.A.Y"
      })
    ],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] }
  });
}

function canManage(member) {
  return (
    member.permissions.has(PermissionsBitField.Flags.Administrator) ||
    member.permissions.has(PermissionsBitField.Flags.ManageGuild)
  );
}

function validatePrefix(value) {
  if (!value || value.length > MAX_PREFIX_LENGTH) {
    return `The prefix must be 1-${MAX_PREFIX_LENGTH} characters.`;
  }
  if (/\s/.test(value)) return "The prefix can't contain spaces.";
  if (value.includes("`") || value.startsWith("<@")) {
    return "That prefix isn't allowed.";
  }
  return null;
}

function mention(type, id) {
  if (type === "role") return `<@&${id}>`;
  if (type === "string") return `\`${id}\``;
  return `<#${id}>`;
}

/** Accepts a mention, raw ID, or (fallback) an exact name. */
function resolveTarget(guild, type, raw) {
  const text = raw.trim();
  const id = text.replace(/[<>#@&!]/g, "");
  const isId = /^\d{17,20}$/.test(id);

  if (type === "role") {
    const role = isId
      ? guild.roles.cache.get(id)
      : guild.roles.cache.find(r => r.name.toLowerCase() === text.toLowerCase());
    if (!role) return { error: "I couldn't find that role." };
    if (role.id === guild.id) return { error: "You can't use @everyone here." };
    return { value: role.id };
  }

  const channel = isId
    ? guild.channels.cache.get(id)
    : guild.channels.cache.find(c => c.name.toLowerCase() === text.toLowerCase().replace(/^#/, ""));
  if (!channel) return { error: "I couldn't find that channel." };

  if (type === "text") {
    if (!channel.isTextBased() || channel.isVoiceBased()) {
      return { error: "That needs to be a **text** channel." };
    }
  } else if (type === "voice") {
    if (channel.type !== ChannelType.GuildVoice) {
      return { error: "That needs to be a **voice** channel." };
    }
  } else if (type === "category") {
    if (channel.type !== ChannelType.GuildCategory) {
      return { error: "That needs to be a **category**." };
    }
  }
  return { value: channel.id };
}

async function showAll(message, PREFIX) {
  const cfg = await guildConfig.get(message.guild.id);

  const lines = Object.entries(SETTINGS).map(([key, def]) => {
    const value = cfg[key] ? mention(def.type, cfg[key]) : "*not set*";
    return `**${def.label}** (\`${key}\`)\n${value}`;
  });

  return reply(
    message,
    COLORS.SKY_BLUE,
    `# Server Configuration\n\n${lines.join("\n\n")}\n\n` +
      `**Set:** \`${PREFIX}config set <key> <#channel | @role | id>\`\n` +
      `**Clear:** \`${PREFIX}config clear <key>\`\n` +
      `**Details:** \`${PREFIX}config keys\`\n\n` +
      `-# F.R.I.D.A.Y • Configuration`
  );
}

function showKeys(message) {
  const lines = Object.entries(SETTINGS).map(
    ([key, def]) => `\`${key}\` — ${def.description} *(${def.type})*`
  );
  return reply(
    message,
    COLORS.SKY_BLUE,
    `# Configuration Keys\n\n${lines.join("\n")}\n\n-# F.R.I.D.A.Y • Configuration`
  );
}

module.exports = client => {
  client.on("messageCreate", async message => {
    if (message.author.bot || !message.guild || !message.member) return;

    // A bare @mention always tells you the prefix (so nobody gets locked out).
    const bare = message.content.trim();
    if (bare === `<@${client.user.id}>` || bare === `<@!${client.user.id}>`) {
      const current = await getPrefix(message.guild.id);
      return reply(
        message,
        COLORS.SKY_BLUE,
        `My prefix in this server is \`${current}\`\n\nTry \`${current}help\` to see every command.`
      ).catch(() => {});
    }

    const parsed = await parseCommand(message);
    if (!parsed) return;

    const { command, prefix: PREFIX } = parsed;
    const args = [...parsed.args];

    // ---------------------------------------------------------
    // PREFIX COMMAND: anyone can view it, Manage Server can change it
    // ---------------------------------------------------------
    if (command === "prefix") {
      try {
        const wanted = args[0];

        if (!wanted) {
          return reply(
            message,
            COLORS.SKY_BLUE,
            `My prefix in this server is \`${PREFIX}\`\n\nChange it with \`${PREFIX}prefix <new prefix>\` (needs **Manage Server**).`
          );
        }

        if (!canManage(message.member)) {
          return reply(
            message,
            COLORS.RED,
            "You need the **Manage Server** permission to change the prefix."
          );
        }

        if (args.length > 1) {
          return reply(message, COLORS.RED, "The prefix can't contain spaces.");
        }

        if (["reset", "default"].includes(wanted.toLowerCase())) {
          await guildConfig.unset(message.guild.id, "prefix");
          return reply(
            message,
            COLORS.GREEN,
            `The prefix has been reset to \`${DEFAULT_PREFIX}\`.`
          );
        }

        const problem = validatePrefix(wanted);
        if (problem) return reply(message, COLORS.RED, problem);

        await guildConfig.set(message.guild.id, "prefix", wanted);
        return reply(
          message,
          COLORS.GREEN,
          `The prefix is now \`${wanted}\`. Try \`${wanted}help\`.`
        );
      } catch (error) {
        console.error("[Settings] Prefix error:", error);
        return;
      }
    }

    if (!["config", "settings"].includes(command)) return;

    try {
      if (!canManage(message.member)) {
        return reply(
          message,
          COLORS.RED,
          "You need the **Manage Server** permission to change the configuration."
        );
      }

      const sub = (args.shift() || "view").toLowerCase();

      if (sub === "view" || sub === "list" || sub === "show") {
        return showAll(message, PREFIX);
      }

      if (sub === "keys" || sub === "help") {
        return showKeys(message);
      }

      if (sub === "set") {
        const keyRaw = args.shift();
        const key = Object.keys(SETTINGS).find(
          k => k.toLowerCase() === (keyRaw || "").toLowerCase()
        );
        const raw = args.join(" ");

        if (!key || !raw) {
          return reply(
            message,
            COLORS.RED,
            `**Usage:** \`${PREFIX}config set <key> <#channel | @role | id>\`\n\nSee \`${PREFIX}config keys\` for every key.`
          );
        }

        const def = SETTINGS[key];
        let value;

        if (def.type === "string") {
          value = raw.trim();

          if (key === "prefix") {
            const problem = validatePrefix(value);
            if (problem) return reply(message, COLORS.RED, problem);
          }

          if (key === "youtubeUrl" && !/^https?:\/\/(www\.)?youtube\.com\//i.test(value)) {
            return reply(
              message,
              COLORS.RED,
              "That doesn't look like a YouTube channel URL (e.g. `https://www.youtube.com/@name`)."
            );
          }
        } else {
          const result = resolveTarget(message.guild, def.type, raw);
          if (result.error) {
            return reply(message, COLORS.RED, result.error);
          }
          value = result.value;
        }

        await guildConfig.set(message.guild.id, key, value);

        return reply(
          message,
          COLORS.GREEN,
          `**${def.label}** is now ${mention(def.type, value)}.`
        );
      }

      if (sub === "clear" || sub === "reset" || sub === "unset") {
        const keyRaw = args.shift();
        const key = Object.keys(SETTINGS).find(
          k => k.toLowerCase() === (keyRaw || "").toLowerCase()
        );

        if (!key) {
          return reply(
            message,
            COLORS.RED,
            `**Usage:** \`${PREFIX}config clear <key>\``
          );
        }

        await guildConfig.unset(message.guild.id, key);
        return reply(message, COLORS.GREEN, `**${SETTINGS[key].label}** has been cleared.`);
      }

      return reply(
        message,
        COLORS.RED,
        `Unknown option. Try \`${PREFIX}config\`, \`${PREFIX}config set\`, \`${PREFIX}config clear\` or \`${PREFIX}config keys\`.`
      );
    } catch (error) {
      console.error("[Settings] Command error:", error);
      reply(message, COLORS.RED, "Something went wrong while updating the configuration.").catch(() => {});
    }
  });
};
