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
const verificationRoles = require("./lib/verificationRoles");
const { parseCommand } = require("./lib/prefix");
const { COLORS, createCard } = require("./lib/pixelVillaUI");
const { trackCreatedResource, trackSetupAllAssignment, clearSetting, clearAllSetupResources } = require("./lib/setupClear");

const CHANNEL_TYPES = {
  text: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
  voice: [ChannelType.GuildVoice],
  category: [ChannelType.GuildCategory]
};

const FEATURES = {
  logs: {
    label: "Server Logs",
    description: "Choose or create the shared moderation and activity log channel.",
    fields: [{ key: "logs", name: "Logs Channel", createName: "friday-logs" }]
  },
  verification: {
    label: "Verification",
    description: "Set up the verification panel and the roles members receive.",
    fields: [
      { key: "verifyChannel", name: "Verification Channel", createName: "verify" },
      { key: "verifiedRole", name: "Verified Role", createName: "Verified" },
      { key: "unverifiedRole", name: "Unverified Role", createName: "Unverified" }
    ]
  },
  voice: {
    label: "Temporary Voice Rooms",
    description: "Choose the join-to-create voice channel and room category.",
    fields: [
      { key: "voiceCategory", name: "Temp VCs Category", createName: "Temp VCs" },
      { key: "voiceCreate", name: "Join-to-Create Voice Channel", createName: "join-to-create" }
    ]
  },
  tickets: {
    label: "ModMail Support",
    description: "Configure the shared ModMail category, ticket logs, and one support-team role.",
    fields: [
      { key: "ticketCategory", name: "ModMail Category", createName: "mod-mail" },
      { key: "ticketLogs", name: "Ticket Logs Channel", createName: "ticket-logs" },
      { key: "supportRole", name: "Support Role", createName: "Support" }
    ]
  },
  activity: {
    label: "Staff Activity",
    description: "Choose separate roles for moderation access, Active Time tracking, and viewing activity logs.",
    fields: [
      { key: "staffRole", name: "Staff Role", createName: "Staff" },
      { key: "activityRole", name: "Active Time Role", createName: "Active Time" },
      { key: "atlogsRole", name: "Activity Logs Role", createName: "Activity Logs" }
    ]
  },
  youtube: {
    label: "YouTube Alerts",
    optional: true,
    description: "Optional. Choose an announcement channel and enter the YouTube channel URL.",
    fields: [
      { key: "youtubeChannel", name: "YouTube Alerts Channel", createName: "youtube-alerts" },
      { key: "youtubeUrl", name: "YouTube Channel URL" }
    ]
  },
  slowmode: {
    label: "Auto-Slowmode",
    optional: true,
    description: "Optional. Choose the channel where FRIDAY watches for chat bursts.",
    fields: [{ key: "slowmodeChannel", name: "Auto-Slowmode Channel", createName: "general" }]
  },
  quarantine: {
    label: "Anti-Nuke Quarantine",
    description: "Role assigned when Anti-Nuke quarantines a user.",
    fields: [{ key: "quarantineRole", name: "Quarantine Role", createName: "Quarantine" }]
  }
};

const URL_PATTERN = /^https?:\/\/(www\.)?youtube\.com\//i;
const TEXT_LIMITS = { youtubeUrl: 200 };

function canManage(member) {
  return Boolean(member &&
    (member.permissions.has(PermissionsBitField.Flags.Administrator) ||
      member.permissions.has(PermissionsBitField.Flags.ManageGuild)));
}

function card(guild, color, content) {
  return createCard({
    color,
    content,
    avatarURL: guild.client.user.displayAvatarURL({ extension: "png", size: 128 }),
    avatarDescription: "F.R.I.D.A.Y"
  });
}

function statusPage(guild, status, title, content, actionRow = null) {
  const styles = {
    progress: { color: COLORS.SKY_BLUE, emoji: "<a:loading:1562810100647989350>", label: "IN PROGRESS" },
    success: { color: COLORS.GREEN, emoji: "<:success_g:1562810067642884177>", label: "SUCCESS" },
    completed: { color: COLORS.GREEN, emoji: "<a:success:1562810143425691790>", label: "COMPLETED" },
    error: { color: COLORS.RED, emoji: "<:error_g:1562810019454386196>", label: "ERROR" }
  };
  const style = styles[status] || styles.progress;
  return {
    components: [
      card(guild, style.color,
        "# " + style.emoji + " " + title + "\n\n" + content +
        "\n\n-# " + style.label + " • F.R.I.D.A.Y Setup"),
      ...(actionRow ? [actionRow] : [])
    ],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] }
  };
}

function resourceLabel(def, value) {
  if (!value) return "*not set*";
  if (def.type === "role") return "<@&" + value + ">";
  if (def.type === "string") {
    const clean = String(value).replace(/\x60/g, "'").replace(/\s+/g, " ");
    return "\x60" + (clean.length > 70 ? clean.slice(0, 67) + "…" : clean) + "\x60";
  }
  return "<#" + value + ">";
}

async function buildMainPanel(guild, userId, note = "") {
  const cfg = await guildConfig.get(guild.id);
  const lines = Object.entries(FEATURES).map(([key, feature]) => {
    const configured = feature.fields.filter(field => cfg[field.key]).length;
    const optionalTag = feature.optional ? " *(optional)*" : "";
    return "**" + feature.label + "**" + optionalTag + " — " + configured + "/" + feature.fields.length + " setting(s) configured";
  });

  const menu = new StringSelectMenuBuilder()
    .setCustomId("setup:feature:" + userId)
    .setPlaceholder("Choose a feature to configure")
    .addOptions(Object.entries(FEATURES).map(([key, feature]) => ({
      label: feature.label,
      description: (feature.optional ? "Optional · " : "") + feature.description.slice(0, feature.optional ? 85 : 100),
      value: key
    })));

  return {
    components: [
      card(guild, COLORS.SKY_BLUE,
        "# <:FRIDAY:1564865373583581266> F.R.I.D.A.Y Setup Wizard\n\n" + (note ? note + "\n\n" : "") +
        lines.join("\n") + "\n\n" +
        "Select a feature to configure or replace settings. Use Setup All to create missing resources.\n\n-# F.R.I.D.A.Y • Guided Setup"),
      new ActionRowBuilder().addComponents(menu),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("setup:all:" + userId)
          .setLabel("Setup All")
          .setStyle(ButtonStyle.Success)
          .setEmoji("🛠️"),
        new ButtonBuilder()
          .setCustomId("setup:clearall:" + userId)
          .setLabel("Clear All")
          .setStyle(ButtonStyle.Danger)
          .setEmoji("<:remove:1562810132918706276>"),
        new ButtonBuilder()
          .setCustomId("setup:close:" + userId)
          .setLabel("Close")
          .setStyle(ButtonStyle.Secondary)
      )
    ],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] }
  };
}

function targetField(featureKey, index) {
  const feature = FEATURES[featureKey];
  if (!feature || !Number.isInteger(index) || index < 0 || index >= feature.fields.length) return null;
  return feature.fields[index];
}

async function buildFeaturePanel(guild, userId, featureKey, index = 0, note = "") {
  const feature = FEATURES[featureKey];
  if (!feature) return buildMainPanel(guild, userId, "Unknown feature. Pick one from the menu.");

  const cfg = await guildConfig.get(guild.id);
  const fields = feature.fields;

  if (index >= fields.length) {
    return {
      components: [
        card(guild, COLORS.GREEN,
          "# " + feature.label + "\n\n" + (note ? note + "\n\n" : "") +
          "Feature setup finished. Use `.config` to edit these settings later.\n\n-# F.R.I.D.A.Y • Guided Setup"),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("setup:back:" + userId).setLabel("Back to Features").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId("setup:close:" + userId).setLabel("Close").setStyle(ButtonStyle.Secondary)
        )
      ],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] }
    };
  }

  const field = fields[index];
  const def = guildConfig.SETTINGS[field.key];
  const isConfigured = Boolean(cfg[field.key]);
  const current = resourceLabel(def, cfg[field.key]);
  const description = field.key === "quarantineRole"
    ? "This role will have no server-wide permissions, and its channel overwrites will deny access to server channels."
    : field.key === "unverifiedRole"
      ? "FRIDAY removes server-wide permissions, blocks this role from server channels, and allows it to view the verification panel only. The Verified role is left unchanged."
      : def.description;

  const rows = [];
  if (def.type === "role") {
    rows.push(new ActionRowBuilder().addComponents(
      new RoleSelectMenuBuilder()
        .setCustomId("setup:pick:" + featureKey + ":" + index + ":" + userId)
        .setPlaceholder("Select an existing " + field.name.toLowerCase())
        .setMinValues(1)
        .setMaxValues(1)
    ));
  } else if (def.type !== "string") {
    rows.push(new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId("setup:pick:" + featureKey + ":" + index + ":" + userId)
        .setChannelTypes(CHANNEL_TYPES[def.type])
        .setPlaceholder("Select an existing " + field.name.toLowerCase())
        .setMinValues(1)
        .setMaxValues(1)
    ));
  }

  const buttons = [];
  if (def.type === "string") {
    buttons.push(new ButtonBuilder()
      .setCustomId("setup:edit:" + featureKey + ":" + index + ":" + userId)
      .setLabel("Enter URL")
      .setStyle(ButtonStyle.Primary));
  } else {
    buttons.push(new ButtonBuilder()
      .setCustomId("setup:create:" + featureKey + ":" + index + ":" + userId)
      .setLabel("Create " + (def.type === "role" ? "Role" : def.type === "category" ? "Category" : "Channel"))
      .setStyle(ButtonStyle.Success));
  }
  buttons.push(new ButtonBuilder()
    .setCustomId("setup:skip:" + featureKey + ":" + index + ":" + userId)
    .setLabel("Skip")
    .setStyle(ButtonStyle.Secondary));
  buttons.push(new ButtonBuilder()
    .setCustomId("setup:back:" + userId)
    .setLabel("Features")
    .setStyle(ButtonStyle.Secondary));
  rows.push(new ActionRowBuilder().addComponents(buttons));
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("setup:clear:" + featureKey + ":" + index + ":" + userId)
      .setLabel("Clear Config / Undo")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!isConfigured && !cfg.__setupCreated?.[field.key])
  ));

  return {
    components: [
      card(guild, COLORS.SKY_BLUE,
        "# " + feature.label + "\n\n" + (note ? note + "\n\n" : "") +
        "**Step " + (index + 1) + " of " + fields.length + ": " + field.name + "**\n" +
        description + "\n\n**Current value:** " + current + "\n\n" +
        (isConfigured
          ? "Already set. Select/create a replacement or skip to keep it."
          : def.type === "string"
            ? "Enter a URL or skip."
            : "Select a resource, create one, or skip.") +
        (feature.optional ? "\n\n*Optional feature: Setup All skips this section. Configure it only if you need it.*" : "") +
        "\n\n-# F.R.I.D.A.Y • Guided Setup"),
      ...rows
    ],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] }
  };
}

async function saveField(guild, field, value) {
  if (field.key === "quarantineRole") await quarantine.configureRole(guild, value);
  const handled = await verificationRoles.saveVerificationSetting(guild, field.key, value);
  if (!handled) {
    await guildConfig.set(guild.id, field.key, typeof value === "string" ? value : value.id);
  }
}

async function createResource(guild, field, trackingOptions = {}) {
  const def = guildConfig.SETTINGS[field.key];
  if (!def) throw new Error("Unknown setup setting: " + field.key);

  const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
  if (!botMember) throw new Error("I could not resolve my bot member in this server.");

  if (def.type === "role") {
    if (!botMember.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
      throw new Error("I need the **Manage Roles** permission to create the " + field.name + ".");
    }
    const role = await guild.roles.create({
      name: field.createName || field.name,
      permissions: [],
      reason: "F.R.I.D.A.Y guided server setup"
    });
    try {
      await saveField(guild, field, role);
      await trackCreatedResource(guild, field.key, role, trackingOptions).catch(error => {
        console.error("[Setup] Could not record created role for cleanup:", error);
      });
      return role;
    } catch (error) {
      await role.delete("F.R.I.D.A.Y setup could not safely configure the role").catch(() => {});
      throw error;
    }
  }

  if (!botMember.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
    throw new Error("I need the **Manage Channels** permission to create the " + field.name + ".");
  }
  const type = CHANNEL_TYPES[def.type]?.[0];
  if (type === undefined || type === null) {
    throw new Error("This setting cannot create that type of resource (setting type: " + def.type + ").");
  }

  const channelOptions = {
    name: field.createName || field.name.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
    type,
    reason: "F.R.I.D.A.Y guided server setup"
  };
  if (field.key === "voiceCreate") {
    const cfg = await guildConfig.get(guild.id);
    let category = cfg.voiceCategory
      ? guild.channels.cache.get(cfg.voiceCategory) || await guild.channels.fetch(cfg.voiceCategory).catch(() => null)
      : null;
    if (!category || category.type !== ChannelType.GuildCategory || category.name.toLowerCase() !== "temp vcs") {
      category = guild.channels.cache.find(channel =>
        channel.type === ChannelType.GuildCategory && channel.name.toLowerCase() === "temp vcs"
      ) || null;
      let createdCategory = false;
      if (!category) {
        category = await guild.channels.create({
          name: "Temp VCs", type: ChannelType.GuildCategory,
          reason: "F.R.I.D.A.Y guided voice setup"
        });
        createdCategory = true;
      }
      await guildConfig.set(guild.id, "voiceCategory", category.id);
      if (createdCategory) {
        await trackCreatedResource(guild, "voiceCategory", category, trackingOptions).catch(error => {
          console.error("[Setup] Could not record Temp VCs category for cleanup:", error);
        });
      } else {
        await trackSetupAllAssignment(guild, "voiceCategory", category.id, trackingOptions).catch(error => {
          console.error("[Setup] Could not record Setup All voice category assignment:", error);
        });
      }
    }
    channelOptions.parent = category.id;
  }
  const channel = await guild.channels.create(channelOptions);

  const cfg = await guildConfig.get(guild.id);
  try {
    if (cfg.quarantineRole) {
      await quarantine.applyToChannel(guild, channel, cfg.quarantineRole).catch(() => false);
    }
    await saveField(guild, field, channel);
  } catch (error) {
    await channel.delete("F.R.I.D.A.Y setup could not safely save the channel configuration").catch(() => {});
    throw error;
  }
  await trackCreatedResource(guild, field.key, channel, trackingOptions).catch(error => {
    console.error("[Setup] Could not record created channel for cleanup:", error);
  });
  return channel;
}

module.exports = client => {
  client.on("messageCreate", async message => {
    if (message.author.bot || !message.guild || !message.member) return;
    const parsed = await parseCommand(message);
    if (!parsed || parsed.command !== "setup") return;

    if (!canManage(message.member)) {
      return await message.reply({
        components: [card(message.guild, COLORS.RED, "You need **Manage Server** or **Administrator** to use the setup wizard.")],
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: { parse: [] }
      });
    }

    const subcommand = String(parsed.args?.[0] || "").toLowerCase();
    if (subcommand === "clear") {
      let progressMessage;
      try {
        progressMessage = await message.reply(statusPage(
          message.guild,
          "progress",
          "Setup Clear • In Progress",
          "Undoing resources and configuration assignments created by Setup All. Manually selected resources will be preserved."
        ));
        const result = await clearAllSetupResources(message.guild);
        const title = result.retained ? "Setup Clear • Completed with Items Kept" : "Setup Clear • Completed";
        return progressMessage.edit(statusPage(
          message.guild,
          result.retained ? "error" : "completed",
          title,
          result.message
        ));
      } catch (error) {
        console.error("[Setup] .setup clear failed:", error);
        const payload = statusPage(
          message.guild,
          "error",
          "Setup Clear • Error",
          String(error.message || "Could not undo Setup All resources.").slice(0, 900)
        );
        if (progressMessage) return progressMessage.edit(payload).catch(() => null);
        return await message.reply(payload);
      }
    }

    try {
      return await message.reply(await buildMainPanel(message.guild, message.author.id));
    } catch (error) {
      console.error("[Setup] Could not open setup wizard:", error);
      return await message.reply({
        components: [card(message.guild, COLORS.RED, "Could not open the setup wizard. Check the bot logs and try again.")],
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: { parse: [] }
      });
    }
  });

  client.on("interactionCreate", async interaction => {
    if (!interaction.customId?.startsWith("setup:")) return;

    try {
      const parts = interaction.customId.split(":");
      const action = parts[1];
      const userId = parts[parts.length - 1];

      if (interaction.user.id !== userId) {
        return await interaction.reply({
          content: "This setup wizard belongs to someone else. Run \x60.setup\x60 yourself to open your own.",
          flags: MessageFlags.Ephemeral
        });
      }
      if (!interaction.guild || !canManage(interaction.member)) {
        return await interaction.reply({
          content: "You need **Manage Server** or **Administrator** to change the setup.",
          flags: MessageFlags.Ephemeral
        });
      }

      const guild = interaction.guild;

      if (action === "feature" && interaction.isStringSelectMenu()) {
        const key = interaction.values[0];
        if (!FEATURES[key]) return interaction.deferUpdate();
        return interaction.update(await buildFeaturePanel(guild, userId, key, 0));
      }
      if (action === "back" && interaction.isButton()) {
        return interaction.update(await buildMainPanel(guild, userId));
      }
      if (action === "all" && interaction.isButton()) {
        await interaction.update(statusPage(guild, "progress", "Setup All • In Progress",
          "Creating missing channels and roles; existing settings will be kept."));
        const successes = [];
        const skipped = [];
        const errors = [];
        let verificationRoleConfiguredThisRun = false;
        const cfg = await guildConfig.get(guild.id);

        for (const feature of Object.values(FEATURES)) {
          if (feature.optional) {
            skipped.push("⏭️ **" + feature.label + "** — optional; left unchanged. Configure it from the feature menu if needed.");
            continue;
          }
          for (const field of feature.fields) {
            const latestCfg = await guildConfig.get(guild.id);
            if (latestCfg[field.key]) {
              skipped.push("↪️ **" + field.name + "** — already configured");
              continue;
            }
            if (field.key === "youtubeUrl") {
              skipped.push("⏭️ **" + field.name + "** — add manually in the YouTube Alerts step");
              continue;
            }
            try {
              const latestCfg = await guildConfig.get(guild.id);
              if (latestCfg[field.key]) {
                skipped.push("↪️ **" + field.name + "** — already configured; skipped");
                continue;
              }
              const value = await createResource(guild, field, { scope: "setupAll" });
              cfg[field.key] = value.id;
              successes.push("<:success_g:1562810067642884177> **" + field.name + "** — created");
              if (field.key === "unverifiedRole" || field.key === "verifyChannel") verificationRoleConfiguredThisRun = true;
            } catch (error) {
              errors.push("<:error_g:1562810019454386196> **" + field.name + "** — " +
                String(error.message || "failed").slice(0, 180));
            }
          }
        }

        const finalCfg = await guildConfig.get(guild.id);
        if (finalCfg.unverifiedRole && finalCfg.verifyChannel && !verificationRoleConfiguredThisRun) {
          try {
            const secured = await verificationRoles.configureUnverifiedRole(guild, finalCfg.unverifiedRole, finalCfg.verifyChannel);
            successes.push("<:success_g:1562810067642884177> **Unverified role permissions** — secured across " + secured.configuredChannels + " channels; verification remains accessible.");
          } catch (error) {
            errors.push("<:error_g:1562810019454386196> **Unverified role permissions** — " + String(error.message || "failed").slice(0, 180));
          }
        }

        const sections = [];
        if (successes.length) sections.push("## <:success_g:1562810067642884177> Success\n" + successes.join("\n"));
        if (skipped.length) sections.push("## <a:settings:1562810057454919740> Skipped / Already Configured\n" + skipped.join("\n"));
        if (errors.length) sections.push("## <:error_g:1562810019454386196> Errors\n" + errors.join("\n"));
        const title = errors.length ? "Setup All • Completed with Errors" : "Setup All • Completed";
        const content = sections.join("\n\n") +
          "\n\nOptional features can be configured from the feature menu. Use `.config` to change settings later.";
        return interaction.editReply(statusPage(guild, errors.length ? "error" : "completed", title, content,
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("setup:back:" + userId).setLabel("Back to Features").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("setup:close:" + userId).setLabel("Close").setStyle(ButtonStyle.Secondary)
          )));
      }
      if (action === "clearall" && interaction.isButton()) {
        await interaction.update(statusPage(guild, "progress", "Clear All • In Progress",
          "Undoing resources and settings created by Setup All. Existing channels and roles selected manually will be preserved."));
        try {
          const result = await clearAllSetupResources(guild);
          const title = result.retained ? "Clear All • Completed with Items Kept" : "Clear All • Completed";
          return interaction.editReply(statusPage(guild, result.retained ? "error" : "completed", title, result.message,
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId("setup:back:" + userId).setLabel("Back to Features").setStyle(ButtonStyle.Primary),
              new ButtonBuilder().setCustomId("setup:close:" + userId).setLabel("Close").setStyle(ButtonStyle.Secondary)
            )));
        } catch (error) {
          console.error("[Setup] Clear All failed:", error);
          return interaction.editReply(statusPage(guild, "error", "Clear All • Error",
            String(error.message || "Could not undo Setup All resources.").slice(0, 900),
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId("setup:back:" + userId).setLabel("Back to Features").setStyle(ButtonStyle.Secondary)
            )));
        }
      }
      if (action === "close" && interaction.isButton()) {
        return interaction.update({
          components: [card(guild, COLORS.GREEN, "# Setup closed\n\nYour saved settings remain in place.\n\n-# F.R.I.D.A.Y • Guided Setup")],
          flags: MessageFlags.IsComponentsV2,
          allowedMentions: { parse: [] }
        });
      }

      if (action === "continue" && interaction.isButton()) {
        const featureKey = parts[2];
        const nextIndex = Number(parts[3]);
        return interaction.update(await buildFeaturePanel(guild, userId, featureKey, nextIndex));
      }
      const featureKey = parts[2];
      const index = Number(parts[3]);
      const field = targetField(featureKey, index);
      if (!field) return interaction.deferUpdate();

      if (action === "clear" && interaction.isButton()) {
        await interaction.update(statusPage(guild, "progress", "Clear Config • In Progress",
          "Clearing **" + field.name + "** and undoing setup-created resources where safe."));
        try {
          const result = await clearSetting(guild, field.key);
          return interaction.editReply(statusPage(guild, result.retained ? "error" : "completed",
            "Clear Config • " + (result.retained ? "Resource Retained" : "Completed"),
            result.message,
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId("setup:continue:" + featureKey + ":" + index + ":" + userId)
                .setLabel("Back to Setting").setStyle(ButtonStyle.Primary),
              new ButtonBuilder().setCustomId("setup:back:" + userId)
                .setLabel("Back to Features").setStyle(ButtonStyle.Secondary)
            )));
        } catch (error) {
          console.error("[Setup] Clear config failed:", error);
          return interaction.editReply(statusPage(guild, "error", "Clear Config • Error",
            String(error.message || "Could not clear this setting.").slice(0, 800),
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId("setup:continue:" + featureKey + ":" + index + ":" + userId)
                .setLabel("Back to Setting").setStyle(ButtonStyle.Secondary)
            )));
        }
      }

      if (action === "pick" && (interaction.isRoleSelectMenu() || interaction.isChannelSelectMenu())) {
        const def = guildConfig.SETTINGS[field.key];
        let value;

        if (def.type === "role" && interaction.isRoleSelectMenu()) {
          value = guild.roles.cache.get(interaction.values[0]) ||
            await guild.roles.fetch(interaction.values[0]).catch(() => null);
          if (!value || value.id === guild.id || value.managed) {
            return interaction.update(await buildFeaturePanel(guild, userId, featureKey, index,
              "Choose a normal server role, not @everyone or a managed integration role."));
          }
        } else if (def.type !== "role" && interaction.isChannelSelectMenu()) {
          value = guild.channels.cache.get(interaction.values[0]) ||
            await guild.channels.fetch(interaction.values[0]).catch(() => null);
          if (!value || !CHANNEL_TYPES[def.type]?.includes(value.type)) {
            return interaction.update(await buildFeaturePanel(guild, userId, featureKey, index,
              "Choose a channel of the requested type."));
          }
        } else {
          return interaction.deferUpdate();
        }

        try {
          const latestCfg = await guildConfig.get(guild.id);
          const replacing = Boolean(latestCfg[field.key] && latestCfg[field.key] !== value.id);
          await saveField(guild, field, value);
          const mention = def.type === "role" ? "<@&" + value.id + ">" : "<#" + value.id + ">";
          return interaction.update(await buildFeaturePanel(guild, userId, featureKey, index + 1,
            "<:success_g:1562810067642884177> " + (replacing ? "Changed" : "Saved") + " **" + field.name + "** as " + mention + "."));
        } catch (error) {
          return interaction.update(await buildFeaturePanel(guild, userId, featureKey, index,
            "<:error_g:1562810019454386196> " + error.message));
        }
      }

      if (action === "create" && interaction.isButton()) {
        const latestCfg = await guildConfig.get(guild.id);
        if (latestCfg[field.key]) return interaction.update(await buildFeaturePanel(guild, userId, featureKey, index,
          "**Already configured.** Select a replacement above if you want to change it; no duplicate was created."));
        await interaction.update(statusPage(guild, "progress", "Creating Resource • In Progress",
          "Creating **" + field.name + "**. Please wait while FRIDAY applies the configuration."));
        try {
          const value = await createResource(guild, field);
          const def = guildConfig.SETTINGS[field.key];
          const mention = def.type === "role" ? "<@&" + value.id + ">" : "<#" + value.id + ">";
          return interaction.editReply(statusPage(guild, "success", "Resource Created • Success",
            "<:success_g:1562810067642884177> Created and saved **" + field.name + "**: " + mention + ".",
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId("setup:continue:" + featureKey + ":" + (index + 1) + ":" + userId).setLabel("Continue Setup").setStyle(ButtonStyle.Success),
              new ButtonBuilder().setCustomId("setup:continue:" + featureKey + ":" + index + ":" + userId).setLabel("Back to Step").setStyle(ButtonStyle.Secondary)
            )));
        } catch (error) {
          console.error("[Setup] Resource creation failed:", error);
          return interaction.editReply(statusPage(guild, "error", "Resource Creation • Error",
            "<:error_g:1562810019454386196> Could not create **" + field.name + "**.\n\n" + String(error.message || "Unknown error").slice(0, 700),
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId("setup:continue:" + featureKey + ":" + index + ":" + userId).setLabel("Back to Step").setStyle(ButtonStyle.Secondary),
              new ButtonBuilder().setCustomId("setup:back:" + userId).setLabel("Back to Features").setStyle(ButtonStyle.Secondary)
            )));
        }
      }

      if (action === "skip" && interaction.isButton()) {
        return interaction.update(await buildFeaturePanel(guild, userId, featureKey, index + 1,
          "Skipped **" + field.name + "**. The current saved value was left unchanged."));
      }

      if (action === "edit" && interaction.isButton() && field.key === "youtubeUrl") {
        const cfg = await guildConfig.get(guild.id);
        const input = new TextInputBuilder()
          .setCustomId("value")
          .setLabel("YouTube Channel URL")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(8)
          .setMaxLength(TEXT_LIMITS.youtubeUrl);
        if (cfg.youtubeUrl) input.setValue(String(cfg.youtubeUrl).slice(0, TEXT_LIMITS.youtubeUrl));

        return interaction.showModal(
          new ModalBuilder()
            .setCustomId("setup:modal:" + featureKey + ":" + index + ":" + userId)
            .setTitle("YouTube Channel URL")
            .addComponents(new ActionRowBuilder().addComponents(input))
        );
      }

      if (action === "modal" && interaction.isModalSubmit() && field.key === "youtubeUrl") {
        const value = interaction.fields.getTextInputValue("value").trim();
        if (!URL_PATTERN.test(value)) {
          const panel = await buildFeaturePanel(guild, userId, featureKey, index,
            "That doesn't look like a YouTube channel URL, such as \x60https://www.youtube.com/@name\x60.");
          return interaction.isFromMessage()
            ? interaction.update(panel)
            : interaction.reply({ ...panel, flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
        }

        await guildConfig.set(guild.id, field.key, value);
        const panel = await buildFeaturePanel(guild, userId, featureKey, index + 1,
          "<:success_g:1562810067642884177> Saved the YouTube channel URL.");
        return interaction.isFromMessage()
          ? interaction.update(panel)
          : interaction.reply({ ...panel, flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
      }
    } catch (error) {
      console.error("[Setup] Interaction error:", error);
      if (!interaction.replied && !interaction.deferred) {
        interaction.reply({
          content: "Setup hit an error. Check the bot permissions and try that step again.",
          flags: MessageFlags.Ephemeral
        }).catch(() => {});
      }
    }
  });
};
