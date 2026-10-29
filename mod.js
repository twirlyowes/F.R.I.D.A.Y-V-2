const { PermissionsBitField, MessageFlags } = require("discord.js");
const guildConfig = require("./lib/guildConfig");
const { makeRecorder } = require("./lib/dashboardEvents");
const dashboardEvents = makeRecorder();
const { parseCommand } = require("./lib/prefix");
const { COLORS, createCard, getAvatarURL } = require("./lib/pixelVillaUI");
const serverOwners = require("./lib/serverOwners");
const quarantine = require("./lib/quarantine");

const quarantineSnapshots = require("./lib/quarantineSnapshots");
const quarantineActions = require("./lib/quarantineActions");

const WARNING_YELLOW = 0xFEE75C;
const ORANGE = 0xF39C12;
const BLURPLE = 0x5865F2;

module.exports = (client) => {
  const startTime = Date.now();

  function makeCard(color, text, user = null) {
    const content = user
      ? `${text}\n\n-# Requested by ${user.tag}`
      : text;

    return createCard({
      color,
      content,
      avatarURL: getAvatarURL(user),
      avatarDescription: user ? `${user.tag}'s avatar` : "F.R.I.D.A.Y"
    });
  }

  function cardReply(color, text, user = null) {
    return {
      components: [makeCard(color, text, user)],
      flags: MessageFlags.IsComponentsV2
    };
  }

  function hierarchyCheck(message, target) {
    if (target.id === message.author.id) return false;
    if (!message.member.roles.highest || !target.roles.highest) return true;
    return target.roles.highest.position < message.member.roles.highest.position;
  }

  // IMPORTANT: message.mentions.members will ALSO contain the replied-to
  // user when someone uses Discord's reply feature (with "mention author"
  // enabled), even if they never typed an @mention. Relying on
  // message.mentions.members.first() therefore lets a bare reply
  // (e.g. replying + typing ".ban spamming") slip through as if a user
  // had been pinged. To require an EXPLICIT typed mention, we only accept
  // a mention that appears literally as the first argument.
  function getExplicitMentionedMember(message, args) {
    if (!args[0]) return null;

    const match = args[0].match(/^<@!?(\d+)>$/);

    if (!match) return null;

    return message.mentions.members.get(match[1]) || null;
  }

  // Discord's native Audit Log attributes the action to the bot because
  // the bot is the account performing the REST/API action. Include the
  // human moderator in the reason so the Audit Log still identifies who
  // requested the action.
  function auditReason(message, reason = "No reason provided") {
    const text = `${reason} | Action by: ${message.author.tag} (${message.author.id})`;
    return text.length > 512 ? text.slice(0, 509) + "..." : text;
  }

  async function sendLog(guild, options) {
    try {
      const channel = await guildConfig.getLogChannel(guild);

      if (channel) {
        await channel.send(options);
      }
    } catch (err) {
      console.error("Failed to send moderation log:", err);
    }
  }

  client.on("messageCreate", async (message) => {
    if (message.author.bot || !message.guild) return;

    const parsed = await parseCommand(message);
    if (!parsed) return;

    const { command, args, prefix: PREFIX } = parsed;

    try {
      // =========================================================
      // MANUAL QUARANTINE / UNQUARANTINE
      // =========================================================
      if (command === "q" || command === "uq") {
        let authorized = message.author.id === message.guild.ownerId;
        try {
          if (!authorized) authorized = await serverOwners.isOwner(message.guild.id, message.author.id);
        } catch (error) {
          console.error("[Quarantine Commands] Could not verify delegated-owner access:", error.message);
          return await message.reply(cardReply(COLORS.RED, "I couldn't verify your server-owner permissions right now. Please try again shortly.", message.author));
        }

        if (!authorized) {
          return await message.reply(cardReply(COLORS.RED, "Only the server owner and delegated server owners can use this command.", message.author));
        }

        const target = getExplicitMentionedMember(message, args);
        if (!target) {
          return await message.reply(cardReply(WARNING_YELLOW, `**Usage:** \`${PREFIX}${command} @user [reason]\``, message.author));
        }

        if (target.id === message.guild.ownerId) {
          return await message.reply(cardReply(COLORS.RED, "The server owner is protected from quarantine actions.", message.author));
        }

        let targetIsDelegatedOwner;
        try {
          targetIsDelegatedOwner = await serverOwners.isOwner(message.guild.id, target.id);
        } catch (error) {
          console.error("[Quarantine Commands] Could not verify target owner status:", error.message);
          return await message.reply(cardReply(COLORS.RED, "I couldn't verify the target's server-owner status right now. No action was taken.", message.author));
        }
        if (targetIsDelegatedOwner) {
          return await message.reply(cardReply(COLORS.RED, "Delegated server owners are protected from quarantine actions.", message.author));
        }

        const reason = args.slice(1).join(" ").trim() || "No reason provided";
        const auditText = `${reason} | Action by: ${message.author.tag} (${message.author.id})`.slice(0, 512);
        const cfg = await guildConfig.get(message.guild.id);
        const quarantineRole = cfg.quarantineRole
          ? (message.guild.roles.cache.get(cfg.quarantineRole) || await message.guild.roles.fetch(cfg.quarantineRole).catch(() => null))
          : null;

        if (!quarantineRole) {
          return await message.reply(cardReply(COLORS.RED, "No valid Quarantine role is configured for this server.", message.author));
        }

        const me = message.guild.members.me || await message.guild.members.fetchMe().catch(() => null);
        if (!me?.permissions.has(PermissionsBitField.Flags.ManageRoles) || !quarantineRole.editable) {
          return await message.reply(cardReply(COLORS.RED, "I need **Manage Roles**, and my highest role must be above the Quarantine role.", message.author));
        }

        if (command === "q") {
          if (target.roles.cache.has(quarantineRole.id)) {
            return await message.reply(cardReply(WARNING_YELLOW, "That member is already quarantined.", message.author));
          }
          if (quarantineRole.id === message.guild.id || quarantineRole.managed) {
            return await message.reply(cardReply(COLORS.RED, "The configured Quarantine role is invalid.", message.author));
          }
          const originalRoles = target.roles.cache
            .filter(role => role.id !== message.guild.id && role.id !== quarantineRole.id && !role.managed)
            .map(role => role.id);

          // Persist the snapshot before changing roles so redeploys cannot erase it.
          try {
            await quarantineSnapshots.save(message.guild.id, target.id, originalRoles);
          } catch (error) {
            console.error("[Quarantine Commands] Could not save role snapshot:", error.message);
            return await message.reply(cardReply(COLORS.RED, "I couldn't safely save this member's role snapshot, so no quarantine action was taken. Please try again shortly.", message.author));
          }

          const result = await quarantine.quarantineMember(message.guild, target.id, quarantineRole.id);
          const refreshed = await message.guild.members.fetch(target.id).catch(() => null);
          if (!refreshed?.roles.cache.has(quarantineRole.id)) {
            // Do not leave a snapshot that suggests quarantine succeeded when it did not.
            await quarantineSnapshots.remove(message.guild.id, target.id).catch(() => {});
          }
          const response = cardReply(
            result.ok ? COLORS.GREEN : COLORS.RED,
            `${result.ok ? "Member quarantined." : "Quarantine completed with a warning:"} <@!${target.id}>\n**Reason:** ${reason}\n${result.text}`,
            message.author
          );
          await message.reply(response);
          await sendLog(message.guild, response);
          return;
        }

        if (!target.roles.cache.has(quarantineRole.id)) {
          return await message.reply(cardReply(WARNING_YELLOW, "That member does not currently have the Quarantine role.", message.author));
        }
        if (!target.manageable) {
          return await message.reply(cardReply(COLORS.RED, "I cannot manage this member because their highest role is at or above mine.", message.author));
        }

        let savedRoleIds = null;
        try {
          savedRoleIds = await quarantineSnapshots.load(message.guild.id, target.id);
        } catch (error) {
          console.error("[Quarantine Commands] Could not load role snapshot:", error.message);
          return await message.reply(cardReply(COLORS.RED, "I couldn't retrieve the saved role snapshot, so I left the member quarantined. Please try again shortly.", message.author));
        }

        quarantineActions.expectUnquarantine(
          message.guild.id, target.id, quarantineRole.id, savedRoleIds || []
        );
        await target.roles.remove(quarantineRole, auditText);
        let restored = 0;
        let skipped = 0;
        if (savedRoleIds) {
          for (const roleId of savedRoleIds) {
            const role = message.guild.roles.cache.get(roleId) || await message.guild.roles.fetch(roleId).catch(() => null);
            if (!role || role.managed || !role.editable) {
              skipped++;
              continue;
            }
            try {
              await target.roles.add(role, auditText);
              restored++;
            } catch (error) {
              skipped++;
              console.warn("[Quarantine Commands] Could not restore role " + roleId + ":", error.message);
            }
          }
          await quarantineSnapshots.remove(message.guild.id, target.id);
        }

        const restoreText = savedRoleIds
          ? `Restored ${restored} role(s)${skipped ? `; skipped ${skipped} role(s) that were missing or unmanageable` : ""}.`
          : "Removed the Quarantine role. No saved role snapshot was available, so previous roles could not be restored.";
        const response = cardReply(COLORS.GREEN, `Member unquarantined: <@!${target.id}>\n**Reason:** ${reason}\n${restoreText}`, message.author);
        await message.reply(response);
        await sendLog(message.guild, response);
        return;
      }

      // =========================================================
      // KICK
      // =========================================================

      if (command === "kick") {
        if (!(await guildConfig.isStaff(message.member))) {
          return await message.reply(
            cardReply(
              COLORS.RED,
              "<a:error:1562810082469740594> You don't have permission to use this command.",
              message.author
            )
          );
        }

        const user = getExplicitMentionedMember(message, args);
        const reason = args.slice(1).join(" ") || "No reason provided";

        if (!user) {
          return await message.reply(
            cardReply(
              WARNING_YELLOW,
              `<a:Warning:1562810154930413569> **Usage:** \`${PREFIX}kick @user [reason]\`\n\nReplying to a message does **not** count — you must type the @mention.`,
              message.author
            )
          );
        }

        if (!user.kickable) {
          return await message.reply(
            cardReply(
              COLORS.RED,
              "<a:error:1562810082469740594> I cannot kick this user. They may have a higher role than me or have Administrator permissions.",
              message.author
            )
          );
        }

        if (!hierarchyCheck(message, user)) {
          return await message.reply(
            cardReply(
              COLORS.RED,
              "<a:error:1562810082469740594> You cannot kick this user because they have an equal or higher role than you.",
              message.author
            )
          );
        }

        await user.kick(auditReason(message, reason));
        dashboardEvents.recordCase(message.guild.id, {
          action: "kick", targetId: user.id, targetName: user.user.tag,
          moderatorId: message.author.id, moderatorName: message.author.tag, reason
        }).catch(error => console.error("[Dashboard Events] Kick case could not be recorded:", error.message));

        const options = cardReply(
          ORANGE,
          `<:kick:1562810087964147722> **Member Kicked**\n\n**User:** ${user.user.tag} (${user.id})\n**Reason:** ${reason}`,
          message.author
        );

        await message.reply(options);
        await sendLog(message.guild, options);
      }

      // =========================================================
      // BAN
      // =========================================================

      if (command === "ban") {
        if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) {
          return await message.reply(
            cardReply(
              COLORS.RED,
              "<a:error:1562810082469740594> You don't have permission to use this command.",
              message.author
            )
          );
        }

        const user = getExplicitMentionedMember(message, args);
        const reason = args.slice(1).join(" ") || "No reason provided";

        if (!user) {
          return await message.reply(
            cardReply(
              WARNING_YELLOW,
              `<a:Warning:1562810154930413569> **Usage:** \`${PREFIX}ban @user [reason]\`\n\nReplying to a message does **not** count — you must type the @mention.`,
              message.author
            )
          );
        }

        if (!user.bannable) {
          return await message.reply(
            cardReply(
              COLORS.RED,
              "<a:error:1562810082469740594> I cannot ban this user. They may have a higher role than me or have Administrator permissions.",
              message.author
            )
          );
        }

        if (!hierarchyCheck(message, user)) {
          return await message.reply(
            cardReply(
              COLORS.RED,
              "<a:error:1562810082469740594> You cannot ban this user because they have an equal or higher role than you.",
              message.author
            )
          );
        }

        await user.ban({
          reason: auditReason(message, reason)
        });
        dashboardEvents.recordCase(message.guild.id, {
          action: "ban", targetId: user.id, targetName: user.user.tag,
          moderatorId: message.author.id, moderatorName: message.author.tag, reason
        }).catch(error => console.error("[Dashboard Events] Ban case could not be recorded:", error.message));

        const options = cardReply(
          COLORS.RED,
          `<a:ban:1562809995307778188> **Member Banned**\n\n**User:** ${user.user.tag} (${user.id})\n**Reason:** ${reason}`,
          message.author
        );

        await message.reply(options);
        await sendLog(message.guild, options);
      }

      // =========================================================
      // NICK
      // =========================================================

      if (command === "nick") {
        if (!(await guildConfig.isStaff(message.member))) {
          return await message.reply(
            cardReply(
              COLORS.RED,
              "<a:error:1562810082469740594> You don't have permission to use this command.",
              message.author
            )
          );
        }

        const user = getExplicitMentionedMember(message, args);
        const nickname = args.slice(1).join(" ");

        if (!user) {
          return await message.reply(
            cardReply(
              WARNING_YELLOW,
              `<a:Warning:1562810154930413569> **Usage:** \`${PREFIX}nick @user [new nickname / leave blank to reset]\`\n\nReplying to a message does **not** count — you must type the @mention.`,
              message.author
            )
          );
        }

        if (!user.manageable) {
          return await message.reply(
            cardReply(
              COLORS.RED,
              "<a:error:1562810082469740594> I cannot change this user's nickname. They may have a higher role than me.",
              message.author
            )
          );
        }

        if (!hierarchyCheck(message, user)) {
          return await message.reply(
            cardReply(
              COLORS.RED,
              "<a:error:1562810082469740594> You cannot change this user's nickname due to role hierarchy.",
              message.author
            )
          );
        }

        const reason = nickname
          ? `Changed nickname to: ${nickname}`
          : "Reset nickname";

        await user.setNickname(nickname || null, auditReason(message, reason));

        const statusText = nickname
          ? `changed to **${nickname}**`
          : "reset to default";

        const options = cardReply(
          COLORS.SKY_BLUE,
          `**Nickname Updated**\n\n**User:** ${user.user.tag}\n**Nickname:** ${statusText}`,
          message.author
        );

        await message.reply(options);
        await sendLog(message.guild, options);
      }

      // =========================================================
      // PING
      // =========================================================

      if (command === "ping") {
        const sent = await message.reply(
          cardReply(
            BLURPLE,
            "<a:loading:1562810100647989350> Measuring latency...",
            message.author
          )
        );

        const latency =
          sent.createdTimestamp - message.createdTimestamp;

        const apiLatency = Math.round(client.ws.ping);

        await sent.edit(
          cardReply(
            COLORS.GREEN,
            `<a:ONLINE:1562810127814500382> **Pong!**\n\n**Roundtrip Latency:** \`${latency}ms\`\n**API Latency:** \`${apiLatency}ms\``,
            message.author
          )
        );
      }

      // =========================================================
      // UPTIME
      // =========================================================

      if (command === "uptime") {
        const uptime = Date.now() - startTime;
        const totalSeconds = Math.floor(uptime / 1000);

        const days = Math.floor(totalSeconds / 86400);
        const hours = Math.floor((totalSeconds % 86400) / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;

        const timestamp = Math.floor(startTime / 1000);

        await message.reply(
          cardReply(
            BLURPLE,
            `# F.R.I.D.A.Y Uptime\n\n**I am online from** <t:${timestamp}:R>\n\n**Total Uptime:** ${days} days, ${hours} hours, ${minutes} minutes, ${seconds} seconds\n\n**Started:** <t:${timestamp}:F>`,
            message.author
          )
        );
      }

      // =========================================================
      // LOCK
      // =========================================================

      if (command === "lock") {
        if (!(await guildConfig.isStaff(message.member))) {
          return await message.reply(
            cardReply(
              COLORS.RED,
              "<a:error:1562810082469740594> You don't have permission to use this command.",
              message.author
            )
          );
        }

        const channel = message.channel;
        const reason = args.join(" ") || "No reason provided";

        await channel.permissionOverwrites.edit(
          message.guild.roles.everyone,
          {
            SendMessages: false,
            CreatePublicThreads: false,
            CreatePrivateThreads: false,
            SendMessagesInThreads: false
          },
          { reason: auditReason(message, reason) }
        );

        const options = cardReply(
          COLORS.RED,
          `<:lock:1562810104393375876> **Channel Locked**\n\n**Channel:** ${channel}\n**Reason:** ${reason}`,
          message.author
        );

        await message.reply(options);
        await sendLog(message.guild, options);
      }

      // =========================================================
      // UNLOCK
      // =========================================================

      if (command === "unlock") {
        if (!(await guildConfig.isStaff(message.member))) {
          return await message.reply(
            cardReply(
              COLORS.RED,
              "<a:error:1562810082469740594> You don't have permission to use this command.",
              message.author
            )
          );
        }

        const channel = message.channel;
        const reason = args.join(" ") || "No reason provided";

        await channel.permissionOverwrites.edit(
          message.guild.roles.everyone,
          {
            SendMessages: null,
            CreatePublicThreads: null,
            CreatePrivateThreads: null,
            SendMessagesInThreads: null
          },
          { reason: auditReason(message, reason) }
        );

        const options = cardReply(
          COLORS.GREEN,
          `<:unlock:1562810151977754775> **Channel Unlocked**\n\n**Channel:** ${channel}\n**Reason:** ${reason}`,
          message.author
        );

        await message.reply(options);
        await sendLog(message.guild, options);
      }

      // =========================================================
      // UNBAN
      // =========================================================

      if (command === "unban") {
        if (!(await guildConfig.isStaff(message.member))) {
          return await message.reply(
            cardReply(
              COLORS.RED,
              "<a:error:1562810082469740594> You don't have permission to use this command.",
              message.author
            )
          );
        }

        const userId = args[0];
        const reason = args.slice(1).join(" ") || "No reason provided";

        if (!userId) {
          return await message.reply(
            cardReply(
              WARNING_YELLOW,
              `<a:Warning:1562810154930413569> **Usage:** \`${PREFIX}unban [User ID] [reason]\``,
              message.author
            )
          );
        }

        const banInfo =
          await message.guild.bans.fetch(userId).catch(() => null);

        if (!banInfo) {
          return await message.reply(
            cardReply(
              COLORS.RED,
              "<a:error:1562810082469740594> This user is not banned or the provided ID is invalid.",
              message.author
            )
          );
        }

        await message.guild.members.unban(
          userId,
          auditReason(message, reason)
        );

        const options = cardReply(
          COLORS.GREEN,
          `<a:success:1562810143425691790> **Member Unbanned**\n\n**User:** ${banInfo.user.tag} (${banInfo.user.id})\n**Reason:** ${reason}`,
          message.author
        );

        await message.reply(options);
        await sendLog(message.guild, options);
      }

    } catch (error) {
      console.error(
        `Error executing moderation command (${command}):`,
        error
      );

      message.reply(
        cardReply(
          COLORS.RED,
          "<a:error:1562810082469740594> An unexpected error occurred while executing this command.",
          message.author
        )
      ).catch(() => {});
    }
  });
};
