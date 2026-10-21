const {
    ContainerBuilder,
    TextDisplayBuilder,
    SectionBuilder,
    ThumbnailBuilder,
    MessageFlags
} = require("discord.js");

const db = require("./firebase");
const { parseCommand } = require("./lib/prefix");

// AFK state is per server: keyed "guildId_userId"
const afkKey = (guildId, userId) => `${guildId}_${userId}`;

let afkData = new Map();

const SKY_BLUE = 0x38BDF8;
const SUCCESS_GREEN = 0x57F287;

async function loadAFK() {
    try {
        const snapshot = await db.collection("afk").get();

        afkData.clear();

        snapshot.forEach(doc => {
            if (!doc.id.includes("_")) return;
            afkData.set(doc.id, doc.data());
        });

        console.log(
            `<:success_g:1561271843346714777> AFK loaded from Firebase (${afkData.size} users)`
        );
    } catch (error) {
        console.error(
            "<:error_g:1561271715164721245> Failed loading AFK from Firebase:",
            error
        );
    }
}

async function saveAFK(userId, data) {
    try {
        await db.collection("afk").doc(userId).set(data);
    } catch (error) {
        console.error(
            "<:error_g:1561271715164721245> Failed saving AFK:",
            error
        );
    }
}

async function removeAFK(userId) {
    try {
        await db.collection("afk").doc(userId).delete();
    } catch (error) {
        console.error(
            "<:error_g:1561271715164721245> Failed removing AFK:",
            error
        );
    }
}

function formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);

    if (seconds < 60) return `${seconds}s`;

    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    const parts = [];

    if (days) parts.push(`${days}d`);
    if (hours) parts.push(`${hours}h`);
    if (minutes) parts.push(`${minutes}m`);

    return parts.join(" ");
}

function formatTime(time) {
    return `<t:${Math.floor(time / 1000)}:f> (<t:${Math.floor(time / 1000)}:R>)`;
}

const AFK_PREFIX = "[AFK] ";
const MAX_REASON = 200;
const MAX_AFK_NOTICES = 5;

// AFK reasons must never ping @everyone, roles, or users.
const NO_PINGS = { parse: [] };

/**
 * Sets the server nickname to "[AFK] DISPLAY NAME".
 * Uses member.displayName instead of member.user.username.
 * Preserves the original nickname for restoration.
 */
async function applyAfkNickname(member) {
    if (!member || !member.manageable) {
        return { changed: false, original: null };
    }

    try {
        const original = member.nickname || null;

        // The name visible in the server, e.g. ADRIEN.
        const baseName = member.displayName;

        // Don't add the AFK prefix twice.
        if (baseName.startsWith(AFK_PREFIX)) {
            return { changed: false, original };
        }

        const newNick = `${AFK_PREFIX}${baseName}`.slice(0, 32);

        await member.setNickname(newNick);

        return { changed: true, original };
    } catch (error) {
        console.error(
            `<:error_g:1561271715164721245> Failed setting AFK nickname for ${member.id}:`,
            error?.message || error
        );

        return { changed: false, original: null };
    }
}

/**
 * Restores the original nickname only if the bot changed it
 * and the current nickname still has our AFK prefix.
 */
async function restoreNickname(member, data) {
    if (!member || !member.manageable) return;

    // Older saved records don't have nickChanged.
    const weChangedIt =
        data.nickChanged === undefined ? true : data.nickChanged;

    if (!weChangedIt) return;

    if (!member.nickname || !member.nickname.startsWith(AFK_PREFIX)) {
        return;
    }

    try {
        await member.setNickname(data.originalNickname || null);
    } catch (error) {
        console.error(
            `<:error_g:1561271715164721245> Failed restoring nickname for ${member.id}:`,
            error?.message || error
        );
    }
}

/* ---------------------------------------------------------
   COMPONENTS V2 CARD BUILDER
--------------------------------------------------------- */

function createAFKCard(
    color,
    content,
    avatarURL,
    avatarDescription = "User avatar"
) {
    const container = new ContainerBuilder()
        .setAccentColor(color);

    const text = new TextDisplayBuilder()
        .setContent(content);

    if (avatarURL) {
        const thumbnail = new ThumbnailBuilder()
            .setURL(avatarURL)
            .setDescription(avatarDescription);

        const section = new SectionBuilder()
            .addTextDisplayComponents(text)
            .setThumbnailAccessory(thumbnail);

        container.addSectionComponents(section);
    } else {
        container.addTextDisplayComponents(text);
    }

    return container;
}

module.exports = (client) => {
    loadAFK();

    client.on("messageCreate", async (message) => {
        try {
            if (message.author.bot || !message.guild) return;

            const key = afkKey(message.guild.id, message.author.id);
            const parsed = await parseCommand(message);

            /* ---------------------------------------------------------
               ENABLE AFK OR UPDATE THE REASON
            --------------------------------------------------------- */

            if (parsed && parsed.command === "afk") {
                const reason =
                    parsed.args
                        .join(" ")
                        .replace(/\s+/g, " ")
                        .trim()
                        .slice(0, MAX_REASON) || "No reason provided";

                const time = Date.now();
                const existing = afkData.get(key);

                // Keep the original nickname when updating an AFK reason.
                const nick = existing
                    ? {
                        changed:
                            existing.nickChanged === undefined
                                ? true
                                : Boolean(existing.nickChanged),
                        original: existing.originalNickname || null
                    }
                    : await applyAfkNickname(message.member);

                const data = {
                    reason,
                    time,
                    setupAt: time,
                    originalNickname: nick.original,
                    nickChanged: nick.changed
                };

                afkData.set(key, data);
                await saveAFK(key, data);

                const avatarURL = message.author.displayAvatarURL({
                    extension: "png",
                    size: 128
                });

                const card = createAFKCard(
                    SKY_BLUE,
                    `<a:Moon:1532988257338527835> **AFK Enabled**\n\n` +
                    `<a:LP_Message:1532991009066324049> **Reason**\n` +
                    `> ${reason}\n\n` +
                    `<a:Clock:1532990759371018372> **Started**\n` +
                    `> ${formatTime(time)}`,
                    avatarURL,
                    `${message.author.username}'s avatar`
                );

                return message.channel.send({
                    components: [card],
                    flags: MessageFlags.IsComponentsV2,
                    allowedMentions: NO_PINGS
                });
            }

            /* ---------------------------------------------------------
               THE AUTHOR IS BACK: REMOVE THEIR AFK
            --------------------------------------------------------- */

            const mine = afkData.get(key);

            if (
                mine &&
                Date.now() - (mine.setupAt || mine.time || 0) > 2000
            ) {
                const duration = formatDuration(Date.now() - mine.time);

                afkData.delete(key);

                await removeAFK(key);
                await restoreNickname(message.member, mine);

                const avatarURL = message.author.displayAvatarURL({
                    extension: "png",
                    size: 128
                });

                const card = createAFKCard(
                    SUCCESS_GREEN,
                    `<a:back:1532987608542744847> **Welcome Back!**\n\n` +
                    `<a:Clock:1532990759371018372> **Time Away**\n` +
                    `> ${duration}`,
                    avatarURL,
                    `${message.author.username}'s avatar`
                );

                const welcome = await message.channel.send({
                    components: [card],
                    flags: MessageFlags.IsComponentsV2,
                    allowedMentions: NO_PINGS
                });

                setTimeout(() => {
                    welcome.delete().catch(() => {});
                }, 8000);
            }

            /* ---------------------------------------------------------
               SOMEONE MENTIONED AN AFK USER
            --------------------------------------------------------- */

            if (message.mentions.users.size > 0) {
                const afkUsers = message.mentions.users.filter(
                    user =>
                        user.id !== message.author.id &&
                        afkData.has(afkKey(message.guild.id, user.id))
                );

                if (afkUsers.size > 0) {
                    const shown = [...afkUsers.values()]
                        .slice(0, MAX_AFK_NOTICES);

                    const mentions = shown.map(user => {
                        const data = afkData.get(
                            afkKey(message.guild.id, user.id)
                        );

                        return (
                            `<a:Moon:1532988257338527835> **${user.username} is currently AFK**\n\n` +
                            `<a:LP_Message:1532991009066324049> **Reason**\n` +
                            `> ${data.reason}\n\n` +
                            `<a:Clock:1532990759371018372> **Away Since**\n` +
                            `> ${formatTime(data.time)}`
                        );
                    });

                    if (afkUsers.size > shown.length) {
                        mentions.push(
                            `…and ${afkUsers.size - shown.length} more AFK user(s).`
                        );
                    }

                    const firstAFKUser = shown[0];

                    const card = createAFKCard(
                        SKY_BLUE,
                        `${mentions.join("\n\n")}\n` +
                        `<a:sparkles:1532986077651140620> Hope they get back to you soon!`,
                        firstAFKUser.displayAvatarURL({
                            extension: "png",
                            size: 128
                        }),
                        `${firstAFKUser.username}'s avatar`
                    );

                    return message.channel.send({
                        components: [card],
                        flags: MessageFlags.IsComponentsV2,
                        allowedMentions: NO_PINGS
                    });
                }
            }
        } catch (error) {
            console.error("AFK System Error:", error);
        }
    });
};
