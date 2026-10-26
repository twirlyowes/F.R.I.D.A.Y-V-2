
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SectionBuilder,
  ThumbnailBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder
} = require("discord.js");

const { COLORS, createCard } = require("./lib/pixelVillaUI");
const { parseCommand } = require("./lib/prefix");

const WARNING_YELLOW = 0xFEE75C;
const BLURPLE = 0x5865F2;

module.exports = (client) => {
  function cardReply(color, content, avatarURL = null, avatarDescription = "F.R.I.D.A.Y") {
    return {
      components: [
        createCard({
          color,
          content,
          avatarURL,
          avatarDescription
        })
      ],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] }
    };
  }

  client.on("messageCreate", async (message) => {
    if (message.author.bot || !message.guild) return;

    const parsed = await parseCommand(message);
    if (!parsed) return;

    const { command, args, prefix } = parsed;

    try {
      if (command === "ri" || command === "roleinfo") {
        const mentionedRole = message.mentions.roles.first();
        const rawArg = args.join(" ").trim();
        const cleanedId = (mentionedRole?.id || rawArg.replace(/[<@&>]/g, "")).trim();
        let role = null;

        if (/^\d{17,20}$/.test(cleanedId)) {
          role = message.guild.roles.cache.get(cleanedId) ||
            await message.guild.roles.fetch(cleanedId).catch(() => null);
        } else if (rawArg) {
          role = message.guild.roles.cache.find(
            candidate => candidate.name.toLowerCase() === rawArg.toLowerCase()
          ) || null;
        }

        if (!role) {
          return message.reply(cardReply(
            WARNING_YELLOW,
            "Please mention a role, provide its ID, or use its exact name. Example: " +
              prefix + "ri @Role.",
            message.author.displayAvatarURL({ extension: "png", size: 128 }),
            message.author.tag + "'s avatar"
          ));
        }

        const permissions = role.permissions.toArray();
        const permissionText = permissions.length
          ? permissions.slice(0, 12).map(permission =>
              "`" + permission.replace(/([A-Z])/g, " $1").trim() + "`"
            ).join(", ") + (permissions.length > 12 ? " +" + (permissions.length - 12) + " more" : "")
          : "No permissions";

        const createdAt = Math.floor(role.createdTimestamp / 1000);
        const roleIconURL = role.iconURL({ size: 256 });
        const details =
          "# Role Information: " + role.name +
          "\n\n**Role:** <@&" + role.id + ">" +
          "\n**Role ID:** `" + role.id + "`" +
          "\n**Color:** " + (role.hexColor === "#000000" ? "Default" : role.hexColor) +
          "\n**Position:** " + role.position +
          "\n**Members with role (cached):** " + role.members.size +
          "\n**Mentionable:** " + (role.mentionable ? "Yes" : "No") +
          "\n**Displayed separately:** " + (role.hoist ? "Yes" : "No") +
          "\n**Managed by integration/bot:** " + (role.managed ? "Yes" : "No") +
          "\n**Created:** <t:" + createdAt + ":F> (<t:" + createdAt + ":R>)" +
          "\n\n**Permissions**\n" + permissionText +
          "\n\n-# Member count is based on members currently cached by Discord.js. Requested by " +
          message.author.tag;

        if (roleIconURL) {
          const container = new ContainerBuilder()
            .setAccentColor(BLURPLE)
            .addSectionComponents(
              new SectionBuilder()
                .addTextDisplayComponents(new TextDisplayBuilder().setContent(details))
                .setThumbnailAccessory(
                  new ThumbnailBuilder()
                    .setURL(roleIconURL)
                    .setDescription(role.name + " role icon")
                )
            );
          return message.reply({
            components: [container],
            flags: MessageFlags.IsComponentsV2,
            allowedMentions: { parse: [] }
          });
        }

        return message.reply(cardReply(
          BLURPLE,
          details,
          message.author.displayAvatarURL({ extension: "png", size: 128 }),
          message.author.tag + "'s avatar"
        ));
      }

      if (command === "roleicon") {
        const mentionedRole = message.mentions.roles.first();
        const rawArg = args.join(" ").trim();
        const cleanedId = (mentionedRole?.id || rawArg.replace(/[<@&>]/g, "")).trim();
        let role = null;

        if (/^\d{17,20}$/.test(cleanedId)) {
          role = message.guild.roles.cache.get(cleanedId) ||
            await message.guild.roles.fetch(cleanedId).catch(() => null);
        } else if (rawArg) {
          role = message.guild.roles.cache.find(
            candidate => candidate.name.toLowerCase() === rawArg.toLowerCase()
          ) || null;
        }

        if (!role) {
          return message.reply(cardReply(
            WARNING_YELLOW,
            "Please mention a role, provide its ID, or use its exact name. Example: " +
              prefix + "ri @Role.",
            message.author.displayAvatarURL({ extension: "png", size: 128 }),
            message.author.tag + "'s avatar"
          ));
        }

        const roleIconURL = role.iconURL({ size: 4096 });
        if (!roleIconURL) {
          return message.reply(cardReply(
            WARNING_YELLOW,
            "**" + role.name + "** has no role icon set.\n\nA server administrator can add one in role settings if the server supports role icons.",
            message.author.displayAvatarURL({ extension: "png", size: 128 }),
            message.author.tag + "'s avatar"
          ));
        }

        const container = new ContainerBuilder()
          .setAccentColor(BLURPLE)
          .addSectionComponents(
            new SectionBuilder()
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                  "# Role Icon: " + role.name +
                  "\n\n**Role:** <@&" + role.id + ">" +
                  "\n**Role ID:** " + role.id +
                  "\n**Position:** " + role.position +
                  "\n\n-# Requested by " + message.author.tag
                )
              )
              .setThumbnailAccessory(
                new ThumbnailBuilder()
                  .setURL(roleIconURL)
                  .setDescription(role.name + " role icon")
              )
          )
          .addSeparatorComponents(new SeparatorBuilder())
          .addMediaGalleryComponents(
            new MediaGalleryBuilder().addItems(
              new MediaGalleryItemBuilder()
                .setURL(roleIconURL)
                .setDescription(role.name + " role icon")
            )
          );

        const pngURL = role.iconURL({ extension: "png", size: 4096 }) || roleIconURL;
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setLabel("Open Role Icon")
            .setStyle(ButtonStyle.Link)
            .setURL(pngURL)
        );

        return message.reply({
          components: [container, row],
          flags: MessageFlags.IsComponentsV2,
          allowedMentions: { parse: [] }
        });
      }

      if (command === "ci" || command === "channelinfo") {
        const mentionedChannel = message.mentions.channels.first();
        const rawArg = args[0]?.replace(/[<#>]/g, "");
        let channel = mentionedChannel || message.channel;

        if (rawArg) {
          if (!/^\d{17,20}$/.test(rawArg)) {
            return message.reply(cardReply(
              WARNING_YELLOW,
              "Please mention a channel or provide its ID. Example: " + prefix + "ci #general.",
              message.author.displayAvatarURL({ extension: "png", size: 128 }),
              message.author.tag + "'s avatar"
            ));
          }

          channel = await message.guild.channels.fetch(rawArg).catch(() => null);
          if (!channel) {
            return message.reply(cardReply(
              COLORS.RED,
              "Could not find that channel in this server.",
              message.author.displayAvatarURL({ extension: "png", size: 128 }),
              message.author.tag + "'s avatar"
            ));
          }
        }

        const typeNames = {
          0: "Text",
          2: "Voice",
          4: "Category",
          5: "Announcement",
          10: "Announcement Thread",
          11: "Public Thread",
          12: "Private Thread",
          13: "Stage",
          14: "Directory",
          15: "Forum",
          16: "Media"
        };
        const typeName = typeNames[channel.type] || "Unknown";
        const createdAt = Math.floor(channel.createdTimestamp / 1000);
        const details = [
          "**Channel:** <#" + channel.id + ">",
          "**Channel ID:** " + channel.id,
          "**Type:** " + typeName,
          "**Category:** " + (channel.parent?.name || "None"),
          "**Created:** <t:" + createdAt + ":F> (<t:" + createdAt + ":R>)"
        ];

        if ("topic" in channel && channel.topic) {
          details.push("**Topic:** " + channel.topic.slice(0, 900));
        }
        if ("nsfw" in channel) {
          details.push("**NSFW:** " + (channel.nsfw ? "Yes" : "No"));
        }
        if ("rateLimitPerUser" in channel && channel.rateLimitPerUser) {
          details.push("**Slowmode:** " + channel.rateLimitPerUser + "s");
        }
        if ("bitrate" in channel && channel.bitrate) {
          details.push("**Bitrate:** " + Math.round(channel.bitrate / 1000) + " kbps");
        }
        if ("userLimit" in channel && channel.userLimit) {
          details.push("**User Limit:** " + channel.userLimit);
        }

        return message.reply(cardReply(
          COLORS.SKY_BLUE,
          "# Channel Information\n\n" + details.join("\n") +
            "\n\n-# Requested by " + message.author.tag,
          client.user.displayAvatarURL({ extension: "png", size: 128 }),
          "F.R.I.D.A.Y"
        ));
      }

      if (command === "mc" || command === "membercount") {
        const guild = message.guild;
        const cachedMembers = guild.members.cache;
        const cachedHumans = cachedMembers.filter(member => !member.user.bot).size;
        const cachedBots = cachedMembers.filter(member => member.user.bot).size;
        const serverIcon = guild.iconURL({ extension: "png", size: 128 }) ||
          client.user.displayAvatarURL({ extension: "png", size: 128 });

        return message.reply(cardReply(
          COLORS.SKY_BLUE,
          "# " + guild.name + " — Member Count\n\n" +
            "**Total Members**\n" + (guild.memberCount ?? cachedMembers.size) +
            "\n\n**Humans in Cache**\n" + cachedHumans +
            "\n\n**Bots in Cache**\n" + cachedBots +
            "\n\n-# Human/bot breakdown reflects members currently cached by Discord.js; the total is Discord's server member count.",
          serverIcon,
          guild.name + " server icon"
        ));
      }

      if (command === "banner") {
        const arg = args[0];
        let targetUser = message.author;

        if (arg) {
          const mentionedUser = message.mentions.users.first();
          const cleanedId = (mentionedUser?.id || arg).replace(/<@!?(\d+)>/, "$1");

          if (!/^\d{17,20}$/.test(cleanedId)) {
            return message.reply(cardReply(
              WARNING_YELLOW,
              "Please mention a user or provide a valid Discord user ID. Example: " +
                prefix + "banner @user.",
              message.author.displayAvatarURL({ extension: "png", size: 128 }),
              message.author.tag + "'s avatar"
            ));
          }

          try {
            targetUser = await client.users.fetch(cleanedId, { force: true });
          } catch {
            return message.reply(cardReply(
              COLORS.RED,
              "Could not find that Discord user.",
              message.author.displayAvatarURL({ extension: "png", size: 128 }),
              message.author.tag + "'s avatar"
            ));
          }
        }

        const bannerURL = targetUser.bannerURL({ size: 4096 });
        if (!bannerURL) {
          return message.reply(cardReply(
            WARNING_YELLOW,
            "**" + targetUser.username + " has no profile banner.**\n\nTry another user with " +
              prefix + "banner @user.",
            targetUser.displayAvatarURL({ extension: "png", size: 128 }),
            targetUser.username + "'s avatar"
          ));
        }

        const container = new ContainerBuilder()
          .setAccentColor(BLURPLE)
          .addSectionComponents(
            new SectionBuilder()
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                  "# " + targetUser.username + "'s Profile Banner\n\n-# Requested by " +
                    message.author.tag
                )
              )
              .setThumbnailAccessory(
                new ThumbnailBuilder()
                  .setURL(targetUser.displayAvatarURL({ extension: "png", size: 128 }))
                  .setDescription(targetUser.username + "'s avatar")
              )
          )
          .addSeparatorComponents(new SeparatorBuilder())
          .addMediaGalleryComponents(
            new MediaGalleryBuilder().addItems(
              new MediaGalleryItemBuilder()
                .setURL(bannerURL)
                .setDescription(targetUser.username + "'s profile banner")
            )
          );

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setLabel("Open Banner")
            .setStyle(ButtonStyle.Link)
            .setURL(bannerURL)
        );

        return message.reply({
          components: [container, row],
          flags: MessageFlags.IsComponentsV2,
          allowedMentions: { parse: [] }
        });
      }
    } catch (error) {
      console.error("[Utility Commands] Failed to run " + command + ":", error);
      return message.reply(cardReply(
        COLORS.RED,
        "Something went wrong while running this utility command. Please try again.",
        message.author.displayAvatarURL({ extension: "png", size: 128 }),
        message.author.tag + "'s avatar"
      )).catch(() => null);
    }
  });
};
