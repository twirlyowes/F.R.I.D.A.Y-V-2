const {
  Client,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
  GatewayIntentBits,
  PermissionsBitField,
  ActivityType,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder
} = require("discord.js");

const fs = require("fs").promises;
const path = require("path");
const guildConfig = require("./lib/guildConfig");
const verificationRoles = require("./lib/verificationRoles");
const { parseCommand } = require("./lib/prefix");
const consoleLogger = require("./console");
const { makeRecorder } = require("./lib/dashboardEvents");
const dashboardEvents = makeRecorder();
const { COLORS, createCard, getAvatarURL } = require("./lib/pixelVillaUI");

const TOKEN = process.env.DISCORD_TOKEN;

if (!TOKEN) {
  console.error("<:error_g:1561271715164721245> DISCORD_TOKEN environment variable is not set.");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildWebhooks,
    GatewayIntentBits.DirectMessages
  ],

  partials: [
    Partials.Channel
  ]
});

// Many feature modules each listen for messages; raise the default cap of 10.
client.setMaxListeners(50);

// Discord.js emits client-level errors for some rejected gateway/API operations.
// Without an error listener, Node treats an emitted "error" as fatal and exits,
// taking the entire bot offline for a single failed Discord request.
client.on("error", error => {
  console.error("[Discord Client Error] A Discord operation failed; keeping the bot process alive:", error);
});

client.on("shardError", error => {
  console.error("[Discord Gateway Error] A shard connection error occurred:", error);
});

// Discord API requests can fail when a channel permission is missing or an
// interaction token has expired. Log otherwise-unhandled promise rejections
// instead of letting Node 22 terminate the process; individual handlers should
// still catch and handle expected errors locally.
process.on("unhandledRejection", reason => {
  console.error("[Unhandled Promise Rejection] Bot kept running; investigate this error:", reason);
});

consoleLogger.connect(client);

const WARN_FILE = path.join(__dirname, "warnings.json");

const slashCommands = [
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Check bot latency")
    .toJSON()
];

async function registerSlashCommands() {
  try {
    const rest = new REST({ version: "10" }).setToken(TOKEN);

    // Global commands work in every server the bot is in.
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: slashCommands }
    );

    // Clear any old per-server copies so /ping doesn't show up twice.
    for (const guild of client.guilds.cache.values()) {
      await rest
        .put(
          Routes.applicationGuildCommands(client.user.id, guild.id),
          { body: [] }
        )
        .catch(() => {});
    }

    console.log("<:success_g:1561271843346714777> Slash commands registered globally.");
  } catch (err) {
    console.error("<:error_g:1561271715164721245> Failed to register slash commands:", err);
  }
}

const AUTO_SLOWMODE_WINDOW_MS = 15 * 1000;
const AUTO_SLOWMODE_USER_THRESHOLD = 10;
const AUTO_SLOWMODE_SECONDS = 2;

const recentChatters = new Map();
const slowmodeState = new Map();

async function handleAutoSlowmode(message) {
  const cfg = await guildConfig.get(message.guild.id);
  if (!cfg.slowmodeChannel || message.channel.id !== cfg.slowmodeChannel) return;

  const now = Date.now();

  let entries =
    recentChatters.get(message.channel.id) || [];

  entries.push({
    userId: message.author.id,
    timestamp: now
  });

  entries = entries.filter(
    e => now - e.timestamp <= AUTO_SLOWMODE_WINDOW_MS
  );

  recentChatters.set(
    message.channel.id,
    entries
  );

  const uniqueUsers =
    new Set(entries.map(e => e.userId)).size;

  const isSlowmodeOn =
    slowmodeState.get(message.channel.id) || false;

  try {
    if (
      uniqueUsers >= AUTO_SLOWMODE_USER_THRESHOLD &&
      !isSlowmodeOn
    ) {
      await message.channel.setRateLimitPerUser(
        AUTO_SLOWMODE_SECONDS,
        `Auto-slowmode: ${uniqueUsers} unique chatters in the last ${AUTO_SLOWMODE_WINDOW_MS / 1000}s`
      );

      slowmodeState.set(
        message.channel.id,
        true
      );

    } else if (
      uniqueUsers < AUTO_SLOWMODE_USER_THRESHOLD &&
      isSlowmodeOn
    ) {
      await message.channel.setRateLimitPerUser(
        0,
        `Auto-slowmode: activity dropped to ${uniqueUsers} unique chatters in the last ${AUTO_SLOWMODE_WINDOW_MS / 1000}s`
      );

      slowmodeState.set(
        message.channel.id,
        false
      );
    }
  } catch (err) {
    console.error("Auto-slowmode error:", err);
  }
}

(async () => {
  try {
    await fs.access(WARN_FILE);
  } catch {
    await fs.writeFile(
      WARN_FILE,
      "{}",
      "utf8"
    );
  }
})();

async function getWarnings() {
  try {
    const data = await fs.readFile(
      WARN_FILE,
      "utf8"
    );

    return JSON.parse(data);
  } catch (error) {
    console.error(
      "Error reading warnings:",
      error
    );

    return {};
  }
}

async function saveWarnings(data) {
  try {
    await fs.writeFile(
      WARN_FILE,
      JSON.stringify(data, null, 2),
      "utf8"
    );
  } catch (error) {
    console.error(
      "Error saving warnings:",
      error
    );
  }
}

function makeCard(
  color,
  text,
  user = null
) {
  return createCard({
    color,
    content: text,
    avatarURL: getAvatarURL(user),
    avatarDescription: user
      ? "User avatar"
      : "F.R.I.D.A.Y"
  });
}

function cardReply(
  color,
  text,
  user = null
) {
  return {
    components: [
      makeCard(color, text, user)
    ],
    flags: MessageFlags.IsComponentsV2
  };
}

function hasModPermission(member) {
  return member.permissions.has(
    PermissionsBitField.Flags.ModerateMembers
  );
}

function hierarchyCheck(
  message,
  target
) {
  if (
    target.id === message.author.id
  ) {
    return false;
  }

  if (
    !message.member.roles.highest ||
    !target.roles.highest
  ) {
    return true;
  }

  return (
    target.roles.highest.position <
    message.member.roles.highest.position
  );
}

function ms(time) {
  if (!time) return null;

  const number = parseInt(
    time,
    10
  );

  if (isNaN(number)) return null;

  if (time.endsWith("s")) {
    return number * 1000;
  }

  if (time.endsWith("m")) {
    return number * 60000;
  }

  if (time.endsWith("h")) {
    return number * 3600000;
  }

  if (time.endsWith("d")) {
    return number * 86400000;
  }

  return null;
}

async function sendLog(
  guild,
  options
) {
  try {
    const channel = await guildConfig.getLogChannel(guild);

    if (channel) {
      await channel.send(options);
    }
  } catch (err) {
    console.error(
      "Failed to send log:",
      err
    );
  }
}

client.once(
  "clientReady",
  async () => {
    console.log(
      `${client.user.tag} is online and fully optimized!`
    );

    client.user.setPresence({
      activities: [
        {
          name: "F.R.I.D.A.Y",
          type: ActivityType.Streaming,
          url: "https://www.twitch.tv/discord"
        }
      ],
      status: "dnd"
    });

    await registerSlashCommands();

    // Migrate and enforce existing Unverified configurations on startup.
    for (const guild of client.guilds.cache.values()) {
      try {
        const cfg = await guildConfig.get(guild.id);
        if (cfg.unverifiedRole && cfg.verifyChannel) {
          const result = await verificationRoles.configureUnverifiedRole(guild, cfg.unverifiedRole, cfg.verifyChannel);
          console.log("[Verification Roles] Secured Unverified in " + guild.name + " (" + result.configuredChannels + " channels).");
        }
      } catch (error) {
        console.error("[Verification Roles] Could not secure Unverified in " + guild.id + ":", error.message);
      }
    }
  }
);

client.on(
  "interactionCreate",
  async interaction => {
    if (
      !interaction.isChatInputCommand()
    ) {
      return;
    }

    if (
      interaction.commandName === "ping"
    ) {
      await interaction.reply(
        `🏓 Pong! Latency: ${client.ws.ping}ms`
      );
    }
  }
);

client.on(
  "messageCreate",
  async message => {
    if (
      message.author.bot ||
      !message.guild
    ) {
      return;
    }

    await handleAutoSlowmode(message);

    const parsed = await parseCommand(message);

    if (!parsed) {
      return;
    }

    const { command, args, prefix: PREFIX } = parsed;

    try {

      if (command === "testembed") {
        const container =
          new ContainerBuilder()
            .setAccentColor(0x38BDF8)

            .addTextDisplayComponents(
              new TextDisplayBuilder()
                .setContent(
                  "# F.R.I.D.A.Y\n" +
                  "### Support System"
                )
            )

            .addSeparatorComponents(
              new SeparatorBuilder()
            )

            .addTextDisplayComponents(
              new TextDisplayBuilder()
                .setContent(
                  "**Square UI Test**\n\n" +
                  "This is a test of the new F.R.I.D.A.Y card-style interface.\n\n" +
                  "**Theme:** Sky Blue\n" +
                  "**Style:** Components V2"
                )
            )

            .addSeparatorComponents(
              new SeparatorBuilder()
            )

            .addTextDisplayComponents(
              new TextDisplayBuilder()
                .setContent(
                  "-# F.R.I.D.A.Y"
                )
            );

        return message.reply({
          components: [container],
          flags:
            MessageFlags.IsComponentsV2
        });
      }

      if (command === "mute") {
        const user =
          message.mentions.members.first();

        const time = args[1];

        const reason =
          args.slice(2).join(" ") ||
          "No reason provided";

        if (
          !user ||
          !time ||
          !ms(time)
        ) {
          return message.reply(
            cardReply(
              COLORS.RED,
              `**Usage:** ${PREFIX}mute @user [time: 10m/1h] [reason]`
            )
          );
        }

        if (
          !hasModPermission(
            message.member
          )
        ) {
          return message.reply(
            cardReply(
              COLORS.RED,
              "You need the **Moderate Members** permission."
            )
          );
        }

        if (
          !hierarchyCheck(
            message,
            user
          )
        ) {
          return message.reply(
            cardReply(
              COLORS.RED,
              "You cannot mute this user due to role hierarchy."
            )
          );
        }

        await user.timeout(
          ms(time),
          reason
        );

        dashboardEvents.recordCase(message.guild.id, {
          action: "timeout",
          targetId: user.id,
          targetName: user.user.tag,
          moderatorId: message.author.id,
          moderatorName: message.author.tag,
          reason
        }).catch(error => console.error("[Dashboard Events] Timeout case could not be recorded:", error.message));

        const options =
          cardReply(
            COLORS.RED,
            `**${user.user.tag}** has been muted.\n\n**Duration:** ${time}\n**Reason:** ${reason}\n**Moderator:** ${message.author.tag}`,
            user
          );

        await message.reply(
          options
        );

        await sendLog(
          message.guild,
          options
        );
      }

      if (command === "unmute") {
        const user =
          message.mentions.members.first();

        if (!user) {
          return message.reply(
            cardReply(
              COLORS.RED,
              `**Usage:** \`${PREFIX}unmute @user\``
            )
          );
        }

        if (
          !hasModPermission(
            message.member
          )
        ) {
          return message.reply(
            cardReply(
              COLORS.RED,
              "You need the **Moderate Members** permission."
            )
          );
        }

        if (
          !user.isCommunicationDisabled()
        ) {
          return message.reply(
            cardReply(
              COLORS.RED,
              "That user is not currently muted."
            )
          );
        }

        if (!user.moderatable) {
          return message.reply(
            cardReply(
              COLORS.RED,
              "I can't unmute that user — their role is higher than mine."
            )
          );
        }

        const wasMutedUntil =
          user.communicationDisabledUntilTimestamp;

        try {
          await user.timeout(
            null,
            `Unmuted by ${message.author.tag}`
          );
        } catch (err) {
          console.error(
            "Unmute failed:",
            err
          );

          return message.reply(
            cardReply(
              COLORS.RED,
              "Failed to unmute that user — check my role position and permissions."
            )
          );
        }

        const options =
          cardReply(
            COLORS.GREEN,
            `# Member Unmuted\n\n` +
            `**User**\n${user}\n\n` +
            `**Moderator**\n${message.author}\n\n` +
            (
              wasMutedUntil
                ? `**Was Muted Until**\n<t:${Math.floor(wasMutedUntil / 1000)}:R>\n\n`
                : ""
            ) +
            `-# F.R.I.D.A.Y Moderation`,
            user
          );

        await message.reply(
          options
        );

        await sendLog(
          message.guild,
          options
        );
      }

      if (
        ["purge", "c"].includes(
          command
        )
      ) {
        if (
          !message.member.permissions.has(
            PermissionsBitField.Flags.ManageMessages
          )
        ) {
          return message.reply(
            cardReply(
              COLORS.RED,
              "You need the **Manage Messages** permission."
            )
          );
        }

        const amount =
          Number(args[0]);

        if (
          !amount ||
          amount < 1 ||
          amount > 100
        ) {
          return message.reply(
            cardReply(
              COLORS.RED,
              "Please enter a valid amount between 1 and 100. (e.g., `purge 50`)"
            )
          );
        }

        await message.delete()
          .catch(() => {});

        await message.channel.bulkDelete(
          amount,
          true
        );

        const options =
          cardReply(
            COLORS.GREEN,
            `Successfully deleted **${amount}** messages.\n\n**Moderator:** ${message.author.tag}`
          );

        const successMsg =
          await message.channel.send(
            options
          );

        setTimeout(
          () =>
            successMsg
              .delete()
              .catch(() => {}),
          4000
        );
      }

      if (command === "vcp") {
        const search =
          args.join(" ")
            .trim()
            .toLowerCase();

        const user =
          message.mentions.members.first() ||
          message.guild.members.cache.get(
            search
          ) ||
          message.guild.members.cache.find(
            member =>
              member.user.username
                .toLowerCase()
                .includes(search)
          ) ||
          message.guild.members.cache.find(
            member =>
              member.displayName
                .toLowerCase()
                .includes(search)
          );

        if (!user) {
          return message.reply(
            cardReply(
              COLORS.RED,
              "Please mention a valid user or provide part of their username/display name. (e.g., `vcp @user`, `vcp Celestial`, or `vcp cele`)"
            )
          );
        }

        if (
          !message.member.permissions.has(
            PermissionsBitField.Flags.MoveMembers
          )
        ) {
          return message.reply(
            cardReply(
              COLORS.RED,
              "You need the **Move Members** permission."
            )
          );
        }

        const voiceChannel =
          message.member.voice.channel;

        if (!voiceChannel) {
          return message.reply(
            cardReply(
              COLORS.RED,
              "You must be sitting inside a voice channel to pull someone."
            )
          );
        }

        if (!user.voice.channel) {
          return message.reply(
            cardReply(
              COLORS.RED,
              "That user isn't connected to any voice channel right now."
            )
          );
        }

        await user.voice.setChannel(
          voiceChannel,
          `Voice-pulled by ${message.author.tag}`
        );

        await message.reply(
          cardReply(
            COLORS.GREEN,
            `Pulled **${user.user.tag}** into your voice channel.\n\n**Moderator:** ${message.author.tag}`,
            user
          )
        );
      }

    } catch (error) {
      console.error(
        `Command Error Encountered (${command}):`,
        error
      );

      message.reply(
        cardReply(
          COLORS.RED,
          "Something went sideways while running that command."
        )
      ).catch(() => {});
    }
  }
);

require("./firebase");
const { attachDashboardEvents } = require("./lib/dashboardEvents");
attachDashboardEvents(client);

// Newly created channels must not accidentally expose themselves to unverified members.
client.on("channelCreate", async channel => {
  if (!channel.guild || channel.isThread?.()) return;
  try {
    await verificationRoles.applyToChannel(channel.guild, channel);
  } catch (error) {
    console.error("[Verification Roles] Could not secure new channel " + channel.id + ":", error.message);
  }
});

console.log("Loading help...");
require("./help")(client);

console.log("Loading badwords...");
require("./badwords")(client);

console.log("Loading mod...");
require("./mod")(client);

console.log("Loading strike...");
require("./strike")(client);  

console.log("Loading verify...");
require("./verify")(client);

console.log("Loading ModMail...");
require("./modmail")(client);

console.log("Loading misc...");
require("./misc")(client);
require("./utilities")(client);

console.log("Loading voicesystem...");
require("./voicesystem")(client);

console.log("Loading quote...");
require('./quote')(client);

console.log("Loading warn...");
require("./warn")(client, {
  getWarnings,
  saveWarnings,
  hasModPermission,
  hierarchyCheck,
  sendLog
});

console.log("Loading activetime...");
console.log("Loading settings...");
require("./settings")(client);

console.log("Loading guided setup...");
require("./setup")(client);

console.log("Loading automod...");
require("./automod")(client);

console.log("Loading anti-nuke...");
require("./antinuke")(client);

console.log("Loading antibot...");
require("./antibot")(client);

console.log("Loading owner management...");
require("./owner")(client);

console.log("Loading no-prefix...");
require("./noprefix")(client);
require("./activetime")(client);

console.log("Loading afk...");
require("./afk")(client);

console.log("Loading YouTube...");
require("./YouTube")(client);

console.log("Loading bot avatar and banner customization...");
require("./botavatar")(client);

console.log("About to login...");
console.log(
  "Token exists:",
  !!TOKEN
);

client.login(TOKEN)
  .then(() =>
    console.log("<:success_g:1561271843346714777> Login successful")
  )
  .catch(err =>
    console.error(
      "<:error_g:1561271715164721245> Login failed:",
      err
    )
  );

const express = require("express");
const app = express();

app.get("/", (req, res) => {
  res.send("Bot is running!");
});

const PORT =
  process.env.PORT || 3000;

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Keep-alive server is running on port ${PORT}`
    );
  }
);
