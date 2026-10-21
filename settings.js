const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  MessageFlags,
  ModalBuilder,
  PermissionsBitField,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle
} = require("discord.js");

const guildConfig = require("./lib/guildConfig");
const quarantine = require("./lib/quarantine");
const { COLORS, createCard } = require("./lib/pixelVillaUI");
const { clearSetting } = require("./lib/setupClear");

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
      `**Easiest:** \`${PREFIX}config\` opens a menu where you just pick channels and roles.\n` +
      `**Or type it:** \`${PREFIX}config set <key> <#channel | @role>\`\n` +
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

// ---------------------------------------------------------------------------
// Interactive setup panel: pick settings from dropdowns, no IDs needed.
// Stateless: everything it needs is inside the component customIds
// ("cfg:<action>:...:<userId>"), so it keeps working after a restart.
// ---------------------------------------------------------------------------
const CHANNEL_TYPES = {
  text: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
  voice: [ChannelType.GuildVoice],
  category: [ChannelType.GuildCategory]
};

const STRING_INPUTS = {
  prefix: { max: MAX_PREFIX_LENGTH, style: TextInputStyle.Short },
  ipMessage: { max: 500, style: TextInputStyle.Paragraph },
  youtubeUrl: { max: 200, style: TextInputStyle.Short }
};

const YOUTUBE_URL = /^https?:\/\/(www\.)?youtube\.com\//i;
const YOUTUBE_PROBLEM =
  "That doesn't look like a YouTube channel URL (e.g. `https://www.youtube.com/@name`).";

/** Short, safe text for showing a stored value inside the panel card. */
function display(type, value) {
  if (type !== "string") return mention(type, value);

  const clean = String(value).replace(/`/g, "'").replace(/\s+/g, " ");
  return `\`${clean.length > 60 ? clean.slice(0, 57) + "…" : clean}\``;
}

async function buildPanel(guild, userId, selectedKey = null, note = null) {
  const cfg = await guildConfig.get(guild.id);

  const lines = Object.entries(SETTINGS).map(([key, def]) => {
    const value = cfg[key] ? display(def.type, cfg[key]) : "*not set*";
    return `${cfg[key] ? "<:success_g:1561271843346714777>" : "⚪"} **${def.label}** — ${value}`;
  });

  const intro = selectedKey
    ? `**Editing: ${SETTINGS[selectedKey].label}**\n${SETTINGS[selectedKey].description}`
    : "Pick a setting from the menu below to change it.";

  const card = createCard({
    color: COLORS.SKY_BLUE,
    content:
      `# Server Setup\n\n${note ? `${note}\n\n` : ""}${lines.join("\n")}\n\n${intro}\n\n` +
      `-# F.R.I.D.A.Y • Setup`,
    avatarURL: guild.client.user.displayAvatarURL({ extension: "png", size: 128 }),
    avatarDescription: "F.R.I.D.A.Y"
  });

  const keyMenu = new StringSelectMenuBuilder()
    .setCustomId(`cfg:key:${userId}`)
    .setPlaceholder("Choose a setting to change")
    .addOptions(
      Object.entries(SETTINGS).map(([key, def]) => ({
        label: def.label.slice(0, 100),
        emoji: cfg[key]
          ? { id: "1561271843346714777", name: "success_g" }
          : { name: "⚪" },
        description: def.description.slice(0, 100),
        value: key,
        default: key === selectedKey
      }))
    );

  const rows = [new ActionRowBuilder().addComponents(keyMenu)];

  if (selectedKey) {
    const def = SETTINGS[selectedKey];

    if (def.type === "role") {
      rows.push(
        new ActionRowBuilder().addComponents(
          new RoleSelectMenuBuilder()
            .setCustomId(`cfg:val:${selectedKey}:${userId}`)
            .setPlaceholder(`Pick the ${def.label.toLowerCase()}`)
        )
      );
    } else if (def.type !== "string") {
      rows.push(
        new ActionRowBuilder().addComponents(
          new ChannelSelectMenuBuilder()
            .setCustomId(`cfg:val:${selectedKey}:${userId}`)
            .setChannelTypes(CHANNEL_TYPES[def.type])
            .setPlaceholder(`Pick the ${def.label.toLowerCase()}`)
        )
      );
    }

    const buttons = [];

    if (def.type === "string") {
      buttons.push(
        new ButtonBuilder()
          .setCustomId(`cfg:edit:${selectedKey}:${userId}`)
          .setLabel("Edit text")
          .setStyle(ButtonStyle.Primary)
      );
    }

    buttons.push(
      new ButtonBuilder()
        .setCustomId(`cfg:clear:${selectedKey}:${userId}`)
        .setLabel("Clear")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!cfg[selectedKey] && !cfg.__setupCreated?.[selectedKey]),
      new ButtonBuilder()
        .setCustomId(`cfg:done:${userId}`)
        .setLabel("Done")
        .setStyle(ButtonStyle.Success)
    );

    rows.push(new ActionRowBuilder().addComponents(buttons));
  } else {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`cfg:done:${userId}`)
          .setLabel("Done")
          .setStyle(ButtonStyle.Success)
      )
    );
  }

  return {
    components: [card, ...rows],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] }
  };
}

async function handlePanelInteraction(interaction) {
  const parts = interaction.customId.split(":"); // cfg:<action>:...:<userId>
  const action = parts[1];
  const userId = parts[parts.length - 1];

  if (interaction.user.id !== userId) {
    return interaction.reply({
      content: "This setup panel belongs to someone else. Run the config command yourself to open your own.",
      flags: MessageFlags.Ephemeral
    });
  }

  if (!interaction.guild || !interaction.member || !canManage(interaction.member)) {
    return interaction.reply({
      content: "You need the **Manage Server** permission to change the configuration.",
      flags: MessageFlags.Ephemeral
    });
  }

  const guild = interaction.guild;

  // 1) a setting was chosen from the main menu
  if (action === "key" && interaction.isStringSelectMenu()) {
    const key = interaction.values[0];
    if (!SETTINGS[key]) return interaction.deferUpdate();

    return interaction.update(await buildPanel(guild, userId, key));
  }

  // 2) a channel / role was picked
  if (action === "val" && (interaction.isChannelSelectMenu() || interaction.isRoleSelectMenu())) {
    const key = parts[2];
    const def = SETTINGS[key];
    if (!def) return interaction.deferUpdate();

    const result = resolveTarget(guild, def.type, interaction.values[0]);

    if (result.error) {
      return interaction.update(await buildPanel(guild, userId, key, `<:error_g:1561271715164721245> ${result.error}`));
    }

    if (key === "quarantineRole") {
      try {
        await quarantine.configureRole(guild, result.value);
      } catch (error) {
        return interaction.update(await buildPanel(guild, userId, key, "<:error_g:1561271715164721245> " + error.message));
      }
    }

    await guildConfig.set(guild.id, key, result.value);

    return interaction.update(
      await buildPanel(guild, userId, key, `<:success_g:1561271843346714777> **${def.label}** is now ${mention(def.type, result.value)}.`)
    );
  }

  // 3) "Edit text" button -> pop-up form (prefix / ip message / YouTube URL)
  if (action === "edit" && interaction.isButton()) {
    const key = parts[2];
    const def = SETTINGS[key];
    const limits = STRING_INPUTS[key];
    if (!def || !limits) return interaction.deferUpdate();

    const cfg = await guildConfig.get(guild.id);

    const input = new TextInputBuilder()
      .setCustomId("value")
      .setLabel(def.label.slice(0, 45))
      .setStyle(limits.style)
      .setRequired(true)
      .setMinLength(1)
      .setMaxLength(limits.max);

    if (cfg[key]) input.setValue(String(cfg[key]).slice(0, limits.max));

    return interaction.showModal(
      new ModalBuilder()
        .setCustomId(`cfg:modal:${key}:${userId}`)
        .setTitle(def.label.slice(0, 45))
        .addComponents(new ActionRowBuilder().addComponents(input))
    );
  }

  // 4) pop-up form submitted
  if (action === "modal" && interaction.isModalSubmit()) {
    const key = parts[2];
    const def = SETTINGS[key];
    if (!def || def.type !== "string") return;

    const value = interaction.fields.getTextInputValue("value").trim();

    let problem = null;
    if (key === "prefix") problem = validatePrefix(value);
    if (key === "youtubeUrl" && !YOUTUBE_URL.test(value)) problem = YOUTUBE_PROBLEM;

    if (!problem) await guildConfig.set(guild.id, key, value);

    const panel = await buildPanel(
      guild,
      userId,
      key,
      problem ? `<:error_g:1561271715164721245> ${problem}` : `<:success_g:1561271843346714777> **${def.label}** is now ${display("string", value)}.`
    );

    return interaction.isFromMessage()
      ? interaction.update(panel)
      : interaction.reply({ ...panel, flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
  }

  // 5) clear the selected setting and undo resources made by the setup wizard.
  if (action === "clear" && interaction.isButton()) {
    const key = parts[2];
    const def = SETTINGS[key];
    if (!def) return interaction.deferUpdate();

    try {
      const result = await clearSetting(guild, key);
      return interaction.update(await buildPanel(guild, userId, key, result.message));
    } catch (error) {
      return interaction.update(await buildPanel(guild, userId, key,
        "<:error_g:1561271715164721245> Could not clear this setting: " +
        String(error.message || "unknown error")));
    }
  }

  // 6) done: remove the menus
  if (action === "done" && interaction.isButton()) {
    return interaction.update({
      components: [
        createCard({
          color: COLORS.GREEN,
          content:
            "# Setup saved\n\nYour settings are saved. Run the config command again any time to change them.\n\n-# F.R.I.D.A.Y • Setup",
          avatarURL: guild.client.user.displayAvatarURL({ extension: "png", size: 128 }),
          avatarDescription: "F.R.I.D.A.Y"
        })
      ],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] }
    });
  }
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

      const sub = (args.shift() || "panel").toLowerCase();

      if (sub === "panel" || sub === "open" || sub === "menu") {
        return message.reply(await buildPanel(message.guild, message.author.id));
      }

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
            `**Usage:** \`${PREFIX}config set <key> <#channel | @role>\`\n\nOr just run \`${PREFIX}config\` and pick from the menus. See \`${PREFIX}config keys\` for every key.`
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

        if (key === "quarantineRole") {
          try {
            await quarantine.configureRole(message.guild, value);
          } catch (error) {
            return reply(message, COLORS.RED, error.message);
          }
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

        const result = await clearSetting(message.guild, key);
        return reply(message, result.retained ? COLORS.RED : COLORS.GREEN, result.message);
      }

      return reply(
        message,
        COLORS.RED,
        `Unknown option. Try \`${PREFIX}config\` (menu), \`${PREFIX}config view\`, \`${PREFIX}config set\`, \`${PREFIX}config clear\` or \`${PREFIX}config keys\`.`
      );
    } catch (error) {
      console.error("[Settings] Command error:", error);
      reply(message, COLORS.RED, "Something went wrong while updating the configuration.").catch(() => {});
    }
  });

  client.on("interactionCreate", async interaction => {
    if (!interaction.customId?.startsWith("cfg:")) return;

    try {
      await handlePanelInteraction(interaction);
    } catch (error) {
      console.error("[Settings] Panel error:", error);

      if (!interaction.replied && !interaction.deferred) {
        interaction
          .reply({ content: "Something went wrong. Please run the config command again.", flags: MessageFlags.Ephemeral })
          .catch(() => {});
      }
    }
  });
};
