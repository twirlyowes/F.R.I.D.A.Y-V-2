const fs = require("fs");
const path = require("path");
const { EmbedBuilder, PermissionFlagsBits } = require("discord.js");
const guildConfig = require("./lib/guildConfig");
const protection = require("./lib/protection");
const { parseCommand } = require("./lib/prefix");
const db = require("./firebase");
const { detectAdvancedAbuse } = require("./lib/advancedAntiwords");
const { findNormalizedBadword } = require("./lib/smartBadwords");
const { createCard, messageOptions } = require("./lib/pixelVillaUI");

const advancedOffences = new Map();
const advancedLogCooldown = new Map();
const ADVANCED_OFFENCE_WINDOW_MS = 24 * 60 * 60 * 1000;

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

async function handleAdvancedViolation(message, detection, client) {
    const now = Date.now();
    const key = message.guild.id + ":" + message.author.id;
    const history = (advancedOffences.get(key) || []).filter(ts => now - ts < ADVANCED_OFFENCE_WINDOW_MS);
    history.push(now);
    advancedOffences.set(key, history);

    await message.delete().catch(() => {});

    const timeoutMinutes = history.length === 2 ? 5 : history.length >= 3 ? 60 : 0;
    let timeoutApplied = false;
    if (timeoutMinutes && message.member && message.member.moderatable) {
        try {
            await message.member.timeout(timeoutMinutes * 60 * 1000, "F.R.I.D.A.Y Advanced Antiwords: repeated abusive message");
            timeoutApplied = true;
        } catch (error) {
            console.error("[Advanced Antiwords] Timeout failed:", error.message);
        }
    }

    let noticeText = "<@" + message.author.id + ">, your message was removed by ADVANCED ANTIWORDS.";
    if (timeoutApplied) {
        noticeText += " You have been timed out for " + timeoutMinutes + " minutes due to repeated violations.";
    } else if (timeoutMinutes) {
        noticeText += " A timeout could not be applied; please contact a moderator.";
    } else {
        noticeText += " Further violations may result in a timeout.";
    }

    const noticeCard = createCard({
        color: 0xED7117,
        content:
            "# <:warning_g:1562810073733136506> ADVANCED ANTIWORDS\n\n" +
            noticeText +
            "\n\n-# F.R.I.D.A.Y • AutoMod"
    });

    const notice = await message.channel.send({
        ...messageOptions(noticeCard),
        allowedMentions: { parse: [] }
    }).catch(() => null);

    if (notice) {
        setTimeout(() => notice.delete().catch(() => {}), 7000).unref?.();
    }

    const lastLogged = advancedLogCooldown.get(key) || 0;
    if (timeoutApplied || now - lastLogged > 10000) {
        advancedLogCooldown.set(key, now);
        const logChannel = await guildConfig.getLogChannel(message.guild);
        if (logChannel) {
            const safeMessage = String(message.content || "")
                .replace(new RegExp(String.fromCharCode(96).repeat(3), "g"), "'''")
                .replace(/@/g, "@\u200b")
                .slice(0, 900);
            const resultText = timeoutApplied
                ? "Message deleted; timed out for " + timeoutMinutes + " minutes"
                : timeoutMinutes
                    ? "Message deleted; timeout could not be applied"
                    : "Message deleted; warning sent";

            const embed = new EmbedBuilder()
                .setColor("#ED7117")
                .setTitle("ADVANCED ANTIWORDS • Message removed")
                .setDescription(
                    "**Member:** " + message.author.tag + " (" + message.author.id + ")\n" +
                    "**Channel:** " + message.channelId + "\n" +
                    "**Detection:** " + detection.category + "\n" +
                    "**Offences in 24 hours:** " + history.length + "\n" +
                    "**Action:** " + resultText + "\n\n" +
                    "**Removed message:**\n" + safeMessage
                )
                .setFooter({ text: "F.R.I.D.A.Y • AutoMod" })
                .setTimestamp();

            await logChannel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(error => {
                console.error("[Advanced Antiwords] Could not send log:", error.message);
            });
        }
    }
}

module.exports = (client) => {

    loadDefaultWords();

    client.on("messageCreate", async (message) => {
        try {
            if (message.author.bot || !message.guild) return;

            const isStaff = await guildConfig.isStaff(message.member);
            const exempt = await isFilterExempt(message.member);

            // The AutoMod panel can switch the word filter off, or skip chosen channels/roles.
            const automod = await protection.getAutomod(message.guild.id);
            const ignoredByAutoMod =
                automod.ignoredChannels.includes(message.channelId) ||
                Boolean(message.channel?.parentId && automod.ignoredChannels.includes(message.channel.parentId)) ||
                Boolean(message.member && message.member.roles.cache.some(role => automod.ignoredRoles.includes(role.id)));
            const filterActive = automod.rules.badwords !== false && !ignoredByAutoMod;
            const advancedFilterActive = automod.advancedAntiwords === true && !ignoredByAutoMod;
            const smartAutomod = await protection.getSmartAutomod(message.guild.id);
            const smartBadwordsActive = smartAutomod.normalizedBadwords === true && !ignoredByAutoMod;
            const parsed = await parseCommand(message);
            const command = parsed ? parsed.command : "";
            const args = parsed ? [parsed.command, ...parsed.args] : [];
            const badWordsCache = await getGuildWords(message.guild.id);

            if (isStaff) {
                // Add Word
                if (command === "addbadword") {
                    if (!args[1]) return await message.reply("Provide a word.");

                    const word = args[1].toLowerCase();
                    if (badWordsCache.has(word)) return await message.reply("Word already exists.");

                    badWordsCache.add(word);
                    await saveGuildWords(message.guild.id);
                    return await message.reply("Bad word added.");
                }

                // Remove Word
                if (command === "removebadword") {
                    if (!args[1]) return await message.reply("Provide a word.");

                    const word = args[1].toLowerCase();
                    if (!badWordsCache.has(word)) return await message.reply("Word not found in database.");

                    badWordsCache.delete(word);
                    await saveGuildWords(message.guild.id);
                    return await message.reply("Bad word removed.");
                }

                // List All Words
                if (command === "badwordslist") {
                    const list = Array.from(badWordsCache);
                    if (list.length === 0) return await message.reply("The bad words list is empty.");

                    const embed = new EmbedBuilder()
                        .setTitle("Prohibited Words List")
                        .setColor("#5865F2")
                        .setDescription(`\`\`\`${list.join(", ")}\`\`\``)
                        .setTimestamp();

                    return await message.reply({ embeds: [embed] });
                }
            }

            if (!exempt && advancedFilterActive && message.member) {
                const advancedDetection = detectAdvancedAbuse(message.content);
                if (advancedDetection) {
                    await handleAdvancedViolation(message, advancedDetection, client);
                    return;
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

            // Optional additive layer: normalize common leetspeak and short punctuation/spacing gaps.
            // This has its own OFF-by-default setting and uses the existing per-server word list.
            if (!found && !exempt && smartBadwordsActive) {
                detectedWord = findNormalizedBadword(message.content, badWordsCache);
                found = Boolean(detectedWord);
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
`<a:Warning:1562810154930413569> ${message.author}

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
                const safeDeletedMessage = String(deletedMessage || "")
                    .replace(/`{3,}/g, "'''")
                    .replace(/@/g, "@\\u200b")
                    .slice(0, 1000);
                const embed = new EmbedBuilder()
                    .setColor("#ED4245")
                    .setAuthor({
                        name: "F.R.I.D.A.Y • Auto Moderation",
                        iconURL: client.user.displayAvatarURL()
                    })
                    .setThumbnail(message.author.displayAvatarURL({ dynamic: true }))
                    .setDescription(
`<a:Warning:1562810154930413569> **Prohibited Word Detected**

━━━━━━━━━━━━━━━━━━━━━━

<:Shield_2:1562810059946328185> **User**
> ${message.author} (\`${message.author.id}\`)

<:HOME:1562810031643295784> **Channel**
> ${message.channel}

<a:LP_Message:1562810046088486952> **Deleted Message**
\`\`\`
${safeDeletedMessage}
\`\`\`

━━━━━━━━━━━━━━━━━━━━━━

<a:error:1562810082469740594> The message has been automatically removed by the filter.`
                    )
                    .setFooter({
                        text: "F.R.I.D.A.Y • Moderation Logs"
                    })
                    .setTimestamp();

                logChannel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
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

            const automod = await protection.getAutomod(newMessage.guild.id);
            const ignoredByAutoMod =
                automod.ignoredChannels.includes(newMessage.channelId) ||
                Boolean(newMessage.channel?.parentId && automod.ignoredChannels.includes(newMessage.channel.parentId)) ||
                Boolean(newMessage.member && newMessage.member.roles.cache.some(role => automod.ignoredRoles.includes(role.id)));
            if (automod.advancedAntiwords === true && !ignoredByAutoMod && newMessage.member) {
                const advancedDetection = detectAdvancedAbuse(newMessage.content || "");
                if (advancedDetection) {
                    await handleAdvancedViolation(newMessage, advancedDetection, client);
                    return;
                }
            }

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
`<a:Warning:1562810154930413569> ${newMessage.author}

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
`<a:Warning:1562810154930413569> **Edited-In Link Detected**

━━━━━━━━━━━━━━━━━━━━━━

<:Shield_2:1562810059946328185> **User**
> ${newMessage.author} (\`${newMessage.author.id}\`)

<:HOME:1562810031643295784> **Channel**
> ${newMessage.channel}

<a:LP_Message:1562810046088486952> **Edited Message Content**
\`\`\`
${deletedMessage.slice(0, 1000)}
\`\`\`

━━━━━━━━━━━━━━━━━━━━━━

<a:error:1562810082469740594> The message was removed because a link was added via editing.`
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
