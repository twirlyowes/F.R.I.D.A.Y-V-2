const fs = require("fs");
const path = require("path");
const { EmbedBuilder, PermissionFlagsBits } = require("discord.js");
const guildConfig = require("./lib/guildConfig");
const protection = require("./lib/protection");
const { parseCommand } = require("./lib/prefix");
const db = require("./firebase");

const badWordsFile = path.join(__dirname, "badwords.json");

// Shipped default list (badwords.json). Each server starts from a copy of it
// and then keeps its own list in Firestore (badwords/{guildId}).
let defaultWords = new Set();
const guildWordCache = new Map();

function loadDefaultWords() {
    try {
        if (!fs.existsSync(badWordsFile)) return;
        const raw = fs.readFileSync(badWordsFile, "utf8");
        const parsed = JSON.parse(raw || '{"words":[]}');
        defaultWords = new Set(parsed.words.map(w => w.toLowerCase()));
    } catch (error) {
        console.error("Failed to load default bad words file:", error);
    }
}

async function getGuildWords(guildId) {
    if (guildWordCache.has(guildId)) return guildWordCache.get(guildId);

    let words = new Set(defaultWords);

    try {
        const doc = await db.collection("badwords").doc(guildId).get();
        if (doc.exists) {
            words = new Set((doc.data().words || []).map(w => String(w).toLowerCase()));
        }
    } catch (error) {
        console.error(`Failed to load bad words for ${guildId}:`, error);
    }

    guildWordCache.set(guildId, words);
    return words;
}

async function saveGuildWords(guildId) {
    const words = guildWordCache.get(guildId);
    if (!words) return;

    try {
        await db.collection("badwords").doc(guildId).set({ words: Array.from(words) });
    } catch (error) {
        console.error(`Failed to save bad words for ${guildId}:`, error);
    }
}

// Staff, admins and message-managers are never filtered, so a freshly added
// (not yet configured) server doesn't have the bot deleting its admins' messages.
async function isFilterExempt(member) {
    if (!member) return false;
    if (await guildConfig.isStaff(member)) return true;

    return (
        member.permissions.has(PermissionFlagsBits.Administrator) ||
        member.permissions.has(PermissionFlagsBits.ManageMessages)
    );
}

const linkRegex = /(https?:\/\/|www\.)[^\s]+/i;

module.exports = (client) => {

    loadDefaultWords();

    client.on("messageCreate", async (message) => {
        try {
            if (message.author.bot || !message.guild) return;

            const isStaff = await guildConfig.isStaff(message.member);
            const exempt = await isFilterExempt(message.member);

            // The AutoMod panel can switch the word filter off, or skip chosen channels/roles.
            const automod = await protection.getAutomod(message.guild.id);
            const filterActive =
                automod.rules.badwords !== false &&
                !automod.ignoredChannels.includes(message.channelId) &&
                !(message.channel?.parentId && automod.ignoredChannels.includes(message.channel.parentId)) &&
                !(message.member && message.member.roles.cache.some(role => automod.ignoredRoles.includes(role.id)));
            const parsed = await parseCommand(message);
            const command = parsed ? parsed.command : "";
            const args = parsed ? [parsed.command, ...parsed.args] : [];
            const badWordsCache = await getGuildWords(message.guild.id);

            if (isStaff) {
                // Add Word
                if (command === "addbadword") {
                    if (!args[1]) return message.reply("Provide a word.");

                    const word = args[1].toLowerCase();
                    if (badWordsCache.has(word)) return message.reply("Word already exists.");

                    badWordsCache.add(word);
                    await saveGuildWords(message.guild.id);
                    return message.reply("Bad word added.");
                }

                // Remove Word
                if (command === "removebadword") {
                    if (!args[1]) return message.reply("Provide a word.");

                    const word = args[1].toLowerCase();
                    if (!badWordsCache.has(word)) return message.reply("Word not found in database.");

                    badWordsCache.delete(word);
                    await saveGuildWords(message.guild.id);
                    return message.reply("Bad word removed.");
                }

                // List All Words
                if (command === "badwordslist") {
                    const list = Array.from(badWordsCache);
                    if (list.length === 0) return message.reply("The bad words list is empty.");

                    const embed = new EmbedBuilder()
                        .setTitle("Prohibited Words List")
                        .setColor("#5865F2")
                        .setDescription(`\`\`\`${list.join(", ")}\`\`\``)
                        .setTimestamp();

                    return message.reply({ embeds: [embed] });
                }
            }

            const normalized = message.content.toLowerCase();

            let found = false;
            let detectedWord = null;

            if (!found && !exempt && filterActive) {
                for (const word of badWordsCache) {
                    const regex = new RegExp(
                        `\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
                        "i"
                    );

                    if (regex.test(normalized)) {
                        found = true;
                        detectedWord = word;
                        break;
                    }
                }
            }

            if (!found) return;

            const deletedMessage = message.content;

            await message.delete().catch(() => {});

            const warn = await message.channel.send({
                embeds: [
                    new EmbedBuilder()
                        .setColor("#F1C40F")
                        .setAuthor({
                            name: "F.R.I.D.A.Y • Auto Moderation",
                            iconURL: client.user.displayAvatarURL()
                        })
                        .setDescription(
`<a:Warning:1532986372716236932> ${message.author}

Message removed for a prohibited word.`
                        )
                ]
            }).catch(() => null);

            if (warn) {
                setTimeout(() => {
                    warn.delete().catch(() => {});
                }, 5000);
            }

            const logChannel = await guildConfig.getLogChannel(message.guild);

            if (logChannel) {
                const embed = new EmbedBuilder()
                    .setColor("#ED4245")
                    .setAuthor({
                        name: "F.R.I.D.A.Y • Auto Moderation",
                        iconURL: client.user.displayAvatarURL()
                    })
                    .setThumbnail(message.author.displayAvatarURL({ dynamic: true }))
                    .setDescription(
`<a:Warning:1532986372716236932> **Prohibited Word Detected**

━━━━━━━━━━━━━━━━━━━━━━

<:Shield_2:1532989398642327594> **User**
> ${message.author} (\`${message.author.id}\`)

<:HOME:1532991400503673055> **Channel**
> ${message.channel}

<a:LP_Message:1532991009066324049> **Deleted Message**
\`\`\`
${deletedMessage.slice(0, 1000)}
\`\`\`

━━━━━━━━━━━━━━━━━━━━━━

<a:error:1532986765105696778> The message has been automatically removed by the filter.`
                    )
                    .setFooter({
                        text: "F.R.I.D.A.Y • Moderation Logs"
                    })
                    .setTimestamp();

                logChannel.send({ embeds: [embed] }).catch(() => {});
            }

        } catch (error) {
            console.error("Filter System Error:", error);
        }
    });

    // Delete a message only if a link was newly added via editing
    // (messages that already contained a link before the edit are left alone)
    client.on("messageUpdate", async (oldMessage, newMessage) => {
        try {
            if (newMessage.partial) await newMessage.fetch().catch(() => {});
            if (!newMessage.guild || newMessage.author?.bot) return;

            if (await isFilterExempt(newMessage.member)) return;

            const newContent = newMessage.content || "";
            if (!linkRegex.test(newContent)) return;

            // If we know what the message looked like before the edit,
            // and it already had a link, this isn't a "link edited in" case — leave it.
            const oldContent = oldMessage.partial ? null : (oldMessage.content || "");
            if (oldContent !== null && linkRegex.test(oldContent)) {
                return;
            }

            const deletedMessage = newContent;

            await newMessage.delete().catch(() => {});

            const warn = await newMessage.channel.send({
                embeds: [
                    new EmbedBuilder()
                        .setColor("#F1C40F")
                        .setAuthor({
                            name: "F.R.I.D.A.Y • Auto Moderation",
                            iconURL: client.user.displayAvatarURL()
                        })
                        .setDescription(
`<a:Warning:1532986372716236932> ${newMessage.author}

Edited messages cannot add links.`
                        )
                ]
            }).catch(() => null);

            if (warn) {
                setTimeout(() => {
                    warn.delete().catch(() => {});
                }, 5000);
            }

            const logChannel = await guildConfig.getLogChannel(newMessage.guild);

            if (logChannel) {
                const embed = new EmbedBuilder()
                    .setColor("#ED4245")
                    .setAuthor({
                        name: "F.R.I.D.A.Y • Auto Moderation",
                        iconURL: client.user.displayAvatarURL()
                    })
                    .setThumbnail(newMessage.author.displayAvatarURL({ dynamic: true }))
                    .setDescription(
`<a:Warning:1532986372716236932> **Edited-In Link Detected**

━━━━━━━━━━━━━━━━━━━━━━

<:Shield_2:1532989398642327594> **User**
> ${newMessage.author} (\`${newMessage.author.id}\`)

<:HOME:1532991400503673055> **Channel**
> ${newMessage.channel}

<a:LP_Message:1532991009066324049> **Edited Message Content**
\`\`\`
${deletedMessage.slice(0, 1000)}
\`\`\`

━━━━━━━━━━━━━━━━━━━━━━

<a:error:1532986765105696778> The message was removed because a link was added via editing.`
                    )
                    .setFooter({
                        text: "F.R.I.D.A.Y • Moderation Logs"
                    })
                    .setTimestamp();

                logChannel.send({ embeds: [embed] }).catch(() => {});
            }

        } catch (error) {
            console.error("Edit Link Filter Error:", error);
        }
    });
};
