const { MessageFlags } = require("discord.js");
const guildConfig = require("./lib/guildConfig");
const { parseCommand } = require("./lib/prefix");
const { db } = require("./firebase");
const { COLORS, createCard, getAvatarURL } = require("./lib/pixelVillaUI");

// Colors used here that aren't in the shared COLORS set
const ERROR_RED = 0xE74C3C;
const WARN_YELLOW = 0xF1C40F;
const WARNED_GREEN = 0x43B581;

module.exports = client => {

    function makeCard(color, title, text, avatarURL = null) {
        return createCard({
            color,
            content: `# ${title}\n\n${text}\n-# F.R.I.D.A.Y • Warning System`,
            avatarURL,
            avatarDescription: avatarURL ? "User avatar" : "F.R.I.D.A.Y"
        });
    }

    function cardReply(color, title, text, avatarURL = null) {
        return {
            components: [makeCard(color, title, text, avatarURL)],
            flags: MessageFlags.IsComponentsV2
        };
    }

    // IMPORTANT: message.mentions.members will ALSO contain the replied-to
    // user when someone uses Discord's reply feature (with "mention author"
    // enabled), even if they never typed an @mention. Relying on
    // message.mentions.members.first() therefore lets a bare reply
    // (e.g. replying + typing ".warn spamming") slip through as if a user
    // had been pinged. To require an EXPLICIT typed mention, we only accept
    // a mention that appears literally as the first argument.
    function getExplicitMentionedMember(message, args) {
        if (!args[0]) return null;

        const match = args[0].match(/^<@!?(\d+)>$/);

        if (!match) return null;

        return message.mentions.members.get(match[1]) || null;
    }

    client.on("messageCreate", async message => {
        if (message.author.bot || !message.guild) return;

        const parsed = await parseCommand(message);
        if (!parsed) return;

        const { command, args, prefix: PREFIX } = parsed;

        const warnCommands = ["warn", "wlist", "wremove", "wreset"];

        if (!warnCommands.includes(command)) return;

        if (
            !(await guildConfig.isStaff(message.member))
        ) {
            return message.channel.send(
                cardReply(
                    ERROR_RED,
                    "<a:error:1532986765105696778> Permission Denied",
                    "You do not have permission to use this command."
                )
            );
        }

        try {

            // =========================================================
            // WARN
            // =========================================================

            if (command === "warn") {

                /*
                 * IMPORTANT:
                 * The user MUST be explicitly mentioned.
                 *
                 * Examples:
                 * .warn @User spamming
                 * .warn @User inappropriate language
                 *
                 * These will NOT work:
                 * .warn
                 * .warn spamming
                 * Replying to a user and typing .warn
                 */

                const user = getExplicitMentionedMember(message, args);

                if (!user) {
                    return message.channel.send(
                        cardReply(
                            ERROR_RED,
                            "<a:error:1532986765105696778> Invalid Usage",
                            `**Usage:** \`${PREFIX}warn @user [reason]\`\n\nReplies do not count; mention the user directly.`
                        )
                    );
                }

                const reason = args.slice(1).join(" ") || "No reason provided";

                const userDoc = await db
                    .collection("warnings")
                    .doc(`${message.guild.id}_${user.id}`)
                    .get();

                const userWarnings = userDoc.exists
                    ? userDoc.data().warnings || []
                    : [];

                const warnId = Math.floor(
                    100000 + Math.random() * 900000
                ).toString();

                const now = new Date();

                const newWarning = {
                    id: warnId,
                    moderator: message.author.tag,
                    reason,
                    timestamp: now.toISOString()
                };

                userWarnings.push(newWarning);

                await db
                    .collection("warnings")
                    .doc(`${message.guild.id}_${user.id}`)
                    .set({
                        warnings: userWarnings
                    });

                // =====================================================
                // DM USER
                // =====================================================

                let dmedUser = "Yes";

                try {
                    await user.send(
                        cardReply(
                            WARN_YELLOW,
                            `<a:Warning:1532986372716236932> Warning Received | ${message.guild.name}`,
                            `**Reason:** ${reason}`
                        )
                    );
                } catch {
                    dmedUser = "No (DMs Closed)";
                }

                // =====================================================
                // FORMAT DATE
                // =====================================================

                const formattedDate = now.toLocaleString("en-US", {
                    year: "numeric",
                    month: "numeric",
                    day: "numeric",
                    hour: "numeric",
                    minute: "numeric",
                    second: "numeric",
                    hour12: true
                });

                // =====================================================
                // SUCCESS CARD
                // =====================================================

                const options = cardReply(
                    WARNED_GREEN,
                    `<:success_g:1561271843346714777> ${user.user.username} has been warned.`,
                    `**Reason**\n${reason}\n\n` +
                    `**Warned by**\n${message.author.username} (${message.author.id})\n\n` +
                    `**Timestamp**\n${formattedDate}\n\n` +
                    `**Warning ID**\n${warnId}\n\n` +
                    `**Member Notified**\n${dmedUser}\n\n` +
                    `**Total Warnings**\n${userWarnings.length}/5`,
                    getAvatarURL(user)
                );

                await message.channel.send(options);

                // =====================================================
                // STAFF LOG
                // =====================================================

                {
                    try {
                        const logChannel = await guildConfig.getLogChannel(message.guild);

                        if (logChannel) {
                            await logChannel.send(options);
                        }
                    } catch (err) {
                        console.error(
                            "Failed to fetch or send to staff log channel:",
                            err
                        );
                    }
                }
            }

            // =========================================================
            // WLIST
            // =========================================================

            if (command === "wlist") {

                /*
                 * IMPORTANT:
                 * The user MUST be explicitly mentioned, same as warn/wremove/wreset.
                 *
                 * Examples:
                 * .wlist @User
                 *
                 * These will NOT work:
                 * .wlist
                 * Replying to a user and typing .wlist
                 */

                const user = getExplicitMentionedMember(message, args);

                if (!user) {
                    return message.channel.send(
                        cardReply(
                            ERROR_RED,
                            "<a:error:1532986765105696778> Invalid Usage",
                            `**Usage:** \`${PREFIX}wlist @user\`\n\nReplies do not count; mention the user directly.`
                        )
                    );
                }

                const userDoc = await db
                    .collection("warnings")
                    .doc(`${message.guild.id}_${user.id}`)
                    .get();

                const userWarns = userDoc.exists
                    ? userDoc.data().warnings || []
                    : [];

                if (userWarns.length === 0) {
                    return message.channel.send(
                        cardReply(
                            COLORS.GREEN,
                            "<a:success:1532986625343099050> Clean Record",
                            `<:Shield_2:1532989398642327594> **User**\n${user}\n\n` +
                            `<a:Warning:1532986372716236932> **Warnings**\n` +
                            `No warnings found.`
                        )
                    );
                }

                const historyBlocks = userWarns
                    .slice(-5)
                    .reverse()
                    .map(
                        (warn, index) =>
                            `**Warning #${userWarns.length - index} • ID: ${warn.id || "N/A"}**\n\n` +
                            `<:Shield_2:1532989398642327594> **Moderator**\n${warn.moderator}\n\n` +
                            `<a:LP_Message:1532991009066324049> **Reason**\n${warn.reason}\n\n` +
                            `<a:Clock:1532990759371018372> **Date**\n<t:${Math.floor(
                                new Date(warn.timestamp).getTime() / 1000
                            )}:R>`
                    )
                    .join("\n\n");

                await message.channel.send(
                    cardReply(
                        WARN_YELLOW,
                        "<a:Warning:1532986372716236932> Infraction History",
                        `<:Shield_2:1532989398642327594> **User**\n${user}\n\n` +
                        `<:Stats:1532990723408793661> **Total Warnings**\n${userWarns.length}/5\n\n` +
                        historyBlocks,
                        getAvatarURL(user)
                    )
                );
            }

            // =========================================================
            // WREMOVE
            // =========================================================

            if (command === "wremove") {

                const user = getExplicitMentionedMember(message, args);

                if (!user) {
                    return message.channel.send(
                        cardReply(
                            ERROR_RED,
                            "<a:error:1532986765105696778> Invalid Usage",
                            `**Usage:** \`${PREFIX}wremove @user <warning ID>\`\n\nReplies do not count; mention the user directly.`
                        )
                    );
                }

                const warnId = args.find(arg => /^\d{6}$/.test(arg));

                if (!warnId) {
                    return message.channel.send(
                        cardReply(
                            ERROR_RED,
                            "<a:error:1532986765105696778> Missing Warning ID",
                            `Please provide a valid Warning ID.\n\n` +
                            `**Usage:** \`${PREFIX}wremove @user <warning ID>\``
                        )
                    );
                }

                const userDoc = await db
                    .collection("warnings")
                    .doc(`${message.guild.id}_${user.id}`)
                    .get();

                const userWarns = userDoc.exists
                    ? userDoc.data().warnings || []
                    : [];

                if (userWarns.length === 0) {
                    return message.channel.send(
                        cardReply(
                            ERROR_RED,
                            "<a:error:1532986765105696778> No Warnings Found",
                            `**${user.user.tag}** has no warnings to remove.`
                        )
                    );
                }

                const warnIndex = userWarns.findIndex(
                    warn => warn.id === warnId
                );

                if (warnIndex === -1) {
                    return message.channel.send(
                        cardReply(
                            ERROR_RED,
                            "<a:error:1532986765105696778> Warning Not Found",
                            `No warning found with ID **${warnId}**.`
                        )
                    );
                }

                const removed = userWarns.splice(warnIndex, 1)[0];

                if (userWarns.length === 0) {
                    await db
                        .collection("warnings")
                        .doc(`${message.guild.id}_${user.id}`)
                        .delete();
                } else {
                    await db
                        .collection("warnings")
                        .doc(`${message.guild.id}_${user.id}`)
                        .set({
                            warnings: userWarns
                        });
                }

                const options = cardReply(
                    COLORS.GREEN,
                    "<a:success:1532986625343099050> Warning Removed",
                    `<:Shield_2:1532989398642327594> **User**\n${user}\n\n` +
                    `<a:Warning:1532986372716236932> **Warning ID**\n\`${removed.id}\`\n\n` +
                    `<a:LP_Message:1532991009066324049> **Reason**\n${removed.reason}\n\n` +
                    `<:Shield_2:1532989398642327594> **Originally Warned By**\n${removed.moderator}\n\n` +
                    `<a:settings:1532990547394957393> **Removed By**\n${message.author}\n\n` +
                    ``,
                    getAvatarURL(user)
                );

                await message.channel.send(options);

                // =====================================================
                // STAFF LOG
                // =====================================================

                {
                    try {
                        const logChannel = await guildConfig.getLogChannel(message.guild);

                        if (logChannel) {
                            await logChannel.send(options);
                        }
                    } catch (err) {
                        console.error(
                            "<:error_g:1561271715164721245> Warning removal log error:",
                            err
                        );
                    }
                }
            }

            // =========================================================
            // WRESET
            // =========================================================

            if (command === "wreset") {

                const user = getExplicitMentionedMember(message, args);

                if (!user) {
                    return message.channel.send(
                        cardReply(
                            ERROR_RED,
                            "<a:error:1532986765105696778> Invalid Usage",
                            `**Usage:** \`${PREFIX}wreset @user\`\n\nReplies do not count; mention the user directly.`
                        )
                    );
                }

                const userDoc = await db
                    .collection("warnings")
                    .doc(`${message.guild.id}_${user.id}`)
                    .get();

                const userWarns = userDoc.exists
                    ? userDoc.data().warnings || []
                    : [];

                if (userWarns.length === 0) {
                    return message.channel.send(
                        cardReply(
                            ERROR_RED,
                            "<a:error:1532986765105696778> No Warnings Found",
                            `**${user.user.tag}** does not have any warnings to reset.`
                        )
                    );
                }

                await db
                    .collection("warnings")
                    .doc(`${message.guild.id}_${user.id}`)
                    .delete();

                const options = cardReply(
                    COLORS.GREEN,
                    "<a:success:1532986625343099050> Warning History Reset",
                    `<:Shield_2:1532989398642327594> **User**\n${user}\n\n` +
                    `<a:Warning:1532986372716236932> **Action**\nAll warnings have been removed\n\n` +
                    `<a:settings:1532990547394957393> **Reset By**\n${message.author}\n\n` +
                    `<a:sparkles:1532986077651140620> Infraction history has been cleared successfully.`,
                    getAvatarURL(user)
                );

                await message.channel.send(options);

                // =====================================================
                // STAFF LOG
                // =====================================================

                {
                    try {
                        const logChannel = await guildConfig.getLogChannel(message.guild);

                        if (logChannel) {
                            await logChannel.send(options);
                        }
                    } catch (err) {
                        console.error(
                            "<:error_g:1561271715164721245> Warning reset log error:",
                            err
                        );
                    }
                }
            }

        } catch (error) {

            console.error(
                "Error executing warning structure:",
                error
            );

            message.channel
                .send(
                    cardReply(
                        ERROR_RED,
                        "<a:error:1532986765105696778> Error",
                        "An error occurred inside the warning system."
                    )
                )
                .catch(() => {});
        }
    });
};
