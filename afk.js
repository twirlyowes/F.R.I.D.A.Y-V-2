const {
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
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
            if (!doc.id.includes("_")) return; // legacy un-scoped record
            afkData.set(doc.id, doc.data());
        });

        console.log(`✅ AFK loaded from Firebase (${afkData.size} users)`);
    } catch (error) {
        console.error("❌ Failed loading AFK from Firebase:", error);
    }
}

async function saveAFK(userId, data) {
    try {
        await db.collection("afk").doc(userId).set(data);
    } catch (error) {
        console.error("❌ Failed saving AFK:", error);
    }
}

async function removeAFK(userId) {
    try {
        await db.collection("afk").doc(userId).delete();
    } catch (error) {
        console.error("❌ Failed removing AFK:", error);
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

async function applyAfkNickname(member) {
    if (!member || !member.manageable) return null;

    try {
        const originalNickname = member.nickname;
        const baseName = originalNickname || member.user.username;

        if (baseName.startsWith(AFK_PREFIX)) return originalNickname;

        let newNick = `${AFK_PREFIX}${baseName}`;

        if (newNick.length > 32) {
            newNick = newNick.slice(0, 32);
        }

        await member.setNickname(newNick);

        return originalNickname;
    } catch (error) {
        console.error(
            `❌ Failed setting AFK nickname for ${member.id}:`,
            error && error.message ? error.message : error
        );

        return null;
    }
}

async function restoreNickname(member, originalNickname) {
    if (!member || !member.manageable) return;
    if (originalNickname === undefined) return;

    try {
        await member.setNickname(originalNickname);
    } catch (error) {
        console.error(
            `❌ Failed restoring nickname for ${member.id}:`,
            error && error.message ? error.message : error
        );
    }
}

/* ---------------------------------------------------------
   COMPONENTS V2 CARD BUILDER
--------------------------------------------------------- */

function createAFKCard(color, content, avatarURL, avatarDescription = "User avatar") {
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
               AFK MENTION CHECK
            --------------------------------------------------------- */

            if (message.mentions.users.size > 0) {
                const mentions = [];

                message.mentions.users.forEach(user => {
                    if (user.id === message.author.id) return;

                    const data = afkData.get(afkKey(message.guild.id, user.id));

                    if (data) {
                        mentions.push(
`<a:Moon:1532988257338527835> **${user.username} is currently AFK**

<a:LP_Message:1532991009066324049> **Reason**
> ${data.reason}

<a:Clock:1532990759371018372> **Away Since**
> ${formatTime(data.time)}`
                        );
                    }
                });

                if (mentions.length > 0) {
                    const firstAFKUser = message.mentions.users.find(
                        user => user.id !== message.author.id && afkData.has(afkKey(message.guild.id, user.id))
                    );

                    const avatarURL = firstAFKUser
                        ? firstAFKUser.displayAvatarURL({ extension: "png", size: 128 })
                        : null;

                    const card = createAFKCard(
                        SKY_BLUE,
`${mentions.join("\n\n")}
<a:sparkles:1532986077651140620> Hope they get back to you soon!`,
                        avatarURL,
                        firstAFKUser ? `${firstAFKUser.username}'s avatar` : "AFK user avatar"
                    );

                    return message.channel.send({
                        components: [card],
                        flags: MessageFlags.IsComponentsV2
                    });
                }
            }

            /* ---------------------------------------------------------
               ENABLE AFK
            --------------------------------------------------------- */

            if (parsed && parsed.command === "afk") {
                const reason =
                    parsed.args.join(" ").trim() || "No reason provided";

                const time = Date.now();
                const member = message.member;

                const originalNickname =
                    await applyAfkNickname(member);

                afkData.set(key, {
                    reason,
                    time,
                    setupAt: time,
                    originalNickname:
                        originalNickname === undefined
                            ? null
                            : originalNickname
                });

                await saveAFK(key, {
                    reason,
                    time,
                    setupAt: time,
                    originalNickname:
                        originalNickname === undefined
                            ? null
                            : originalNickname
                });

                const avatarURL = message.author.displayAvatarURL({
                    extension: "png",
                    size: 128
                });

                const card = createAFKCard(
                    SKY_BLUE,
`<a:Moon:1532988257338527835> **AFK Enabled**

Your AFK status has been enabled successfully.

<a:LP_Message:1532991009066324049> **Reason**
> ${reason}

<a:Clock:1532990759371018372> **Started**
> ${formatTime(time)}

<a:sparkles:1532986077651140620> Hope you have a great time away!`,
                    avatarURL,
                    `${message.author.username}'s avatar`
                );

                return message.channel.send({
                    components: [card],
                    flags: MessageFlags.IsComponentsV2
                });
            }

            /* ---------------------------------------------------------
               REMOVE AFK / WELCOME BACK
            --------------------------------------------------------- */

            if (afkData.has(key)) {
                const data = afkData.get(key);

                if (Date.now() - data.setupAt > 2000) {
                    const duration =
                        formatDuration(Date.now() - data.time);

                    afkData.delete(key);

                    await removeAFK(key);

                    await restoreNickname(
                        message.member,
                        data.originalNickname
                    );

                    const avatarURL = message.author.displayAvatarURL({
                        extension: "png",
                        size: 128
                    });

                    const card = createAFKCard(
                        SUCCESS_GREEN,
`<a:back:1532987608542744847> **Welcome Back!**

Your AFK status has been removed successfully.

<a:Clock:1532990759371018372> **Time Away**
> ${duration}

<a:success:1532986625343099050> Welcome back to **${message.guild.name}**. Hope you had a great break!`,
                        avatarURL,
                        `${message.author.username}'s avatar`
                    );

                    return message.channel.send({
                        components: [card],
                        flags: MessageFlags.IsComponentsV2
                    }).then(msg => {
                        setTimeout(() => {
                            msg.delete().catch(() => {});
                        }, 8000);
                    });
                }
            }
        } catch (error) {
            console.error("AFK System Error:", error);
        }
    });
};