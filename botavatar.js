const {
    REST,
    Routes,
    MessageFlags
} = require("discord.js");

const { parseCommand } = require("./lib/prefix");
const { COLORS, createCard } = require("./lib/pixelVillaUI");

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPES = new Set([
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif"
]);
const IMAGE_EXTENSIONS = /\.(?:png|jpe?g|webp|gif)(?:$|\?)/i;
const DISCORD_MESSAGE_URL = /^https?:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/channels\/(\d{17,20})\/(\d{17,20})\/(\d{17,20})\/?(?:\?.*)?$/i;

const EMOJIS = {
    success: "<:success_g:1561271843346714777>",
    error: "<:error_g:1561271715164721245>",
    warning: "<:warning_g:1561271566233501797>",
    info: "<:info_g:1561269600564281374>"
};

function cardReply(color, content) {
    return {
        components: [createCard({ color, content })],
        flags: MessageFlags.IsComponentsV2
    };
}

function isSafeImageURL(value) {
    try {
        const url = new URL(value);
        if (url.protocol !== "https:") return false;

        const hostname = url.hostname.toLowerCase();
        if (
            hostname === "localhost" ||
            hostname.endsWith(".localhost") ||
            hostname === "127.0.0.1" ||
            hostname === "::1" ||
            hostname.startsWith("10.") ||
            hostname.startsWith("192.168.") ||
            hostname.startsWith("169.254.") ||
            /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
        ) {
            return false;
        }

        return true;
    } catch {
        return false;
    }
}

async function imageToDataURI(source) {
    if (!isSafeImageURL(source)) {
        throw new Error("Use a valid public HTTPS image URL, a Discord message link, or attach an image.");
    }

    const response = await fetch(source, {
        signal: AbortSignal.timeout(15000),
        redirect: "error"
    });

    if (!response.ok) {
        throw new Error("The image URL returned HTTP " + response.status + ".");
    }

    const contentType = (response.headers.get("content-type") || "")
        .split(";")[0]
        .trim()
        .toLowerCase();

    if (!IMAGE_TYPES.has(contentType)) {
        throw new Error("Unsupported image type. Use PNG, JPG, WEBP, or GIF.");
    }

    const declaredSize = Number(response.headers.get("content-length") || 0);
    if (declaredSize > MAX_IMAGE_BYTES) {
        throw new Error("Image is larger than 8 MB.");
    }

    const chunks = [];
    let size = 0;

    if (!response.body) throw new Error("Could not read the image response.");

    for await (const chunk of response.body) {
        size += chunk.length;
        if (size > MAX_IMAGE_BYTES) {
            throw new Error("Image is larger than 8 MB.");
        }
        chunks.push(chunk);
    }

    const buffer = Buffer.concat(chunks);
    if (!buffer.length) throw new Error("The image file is empty.");

    return `data:${contentType};base64,${buffer.toString("base64")}`;
}

function looksLikeImage(attachment) {
    const contentType = (attachment.contentType || "").split(";")[0].trim().toLowerCase();
    return IMAGE_TYPES.has(contentType) || IMAGE_EXTENSIONS.test(attachment.name || attachment.url || "");
}

async function attachmentToDataURI(attachment) {
    if (!attachment) return null;

    if (!looksLikeImage(attachment)) {
        throw new Error("Attach a PNG, JPG, WEBP, or GIF image.");
    }

    if (attachment.size > MAX_IMAGE_BYTES) {
        throw new Error("Image is larger than 8 MB.");
    }

    return imageToDataURI(attachment.url);
}

async function resolveDiscordMessageImage(client, commandMessage, source) {
    const match = source.match(DISCORD_MESSAGE_URL);
    if (!match) return imageToDataURI(source);

    const [, guildId, channelId, messageId] = match;

    if (guildId !== commandMessage.guild.id) {
        throw new Error("For safety, the message link must point to a message in this same server.");
    }

    let channel;
    let referencedMessage;

    try {
        channel = await client.channels.fetch(channelId);
        if (!channel || !channel.isTextBased() || !channel.messages?.fetch) {
            throw new Error("That link does not point to a readable text channel.");
        }

        if (channel.guildId && channel.guildId !== commandMessage.guild.id) {
            throw new Error("That message belongs to a different server.");
        }

        referencedMessage = await channel.messages.fetch(messageId);
    } catch (error) {
        if (
            error.message === "That link does not point to a readable text channel." ||
            error.message === "That message belongs to a different server."
        ) {
            throw error;
        }
        throw new Error("I couldn't read that linked message. Make sure FRIDAY can view its channel and read message history.");
    }

    const attachment = referencedMessage.attachments.find(looksLikeImage);
    if (attachment) return attachmentToDataURI(attachment);

    const embeddedImage = referencedMessage.embeds.find(embed => embed.image?.url)?.image?.url;
    if (embeddedImage) return imageToDataURI(embeddedImage);

    throw new Error("That message has no image attachment or embedded image. Link a message containing the image itself.");
}

async function updateGuildProfile(client, guildId, field, value) {
    const rest = new REST({ version: "10" }).setToken(client.token);

    await rest.patch(Routes.guildMember(guildId, "@me"), {
        body: { [field]: value }
    });
}

module.exports = (client) => {
    client.on("messageCreate", async (message) => {
        if (!message.guild || message.author.bot) return;

        const parsed = await parseCommand(message).catch(() => null);
        if (!parsed) return;

        const { command, args, prefix } = parsed;
        const normalized = command.toLowerCase();

        const fieldByCommand = {
            setavatar: "avatar",
            botavatar: "avatar",
            setbanner: "banner",
            botbanner: "banner"
        };

        const resetCommand = {
            resetavatar: "avatar",
            resetbanner: "banner"
        };

        const field = fieldByCommand[normalized] || resetCommand[normalized];
        if (!field) return;

        const ownerId = process.env.OWNER_ID?.trim();
        if (!ownerId) {
            console.error("[Bot Avatar] OWNER_ID is not configured; profile customization is disabled.");
            return await message.reply(cardReply(
                COLORS.RED,
                `${EMOJIS.error} **Owner Only**\nThis command is disabled because the \`OWNER_ID\` environment variable is not configured.`
            ));
        }

        if (message.author.id !== ownerId) {
            return await message.reply(cardReply(
                COLORS.RED,
                `${EMOJIS.error} **Owner Only**\nOnly FRIDAY's configured owner can change the bot's server-specific avatar or banner.`
            ));
        }

        const isReset = Boolean(resetCommand[normalized]);
        const attachment = message.attachments.find(looksLikeImage);

        if (!isReset && !attachment && !args[0]) {
            return await message.reply(cardReply(
                COLORS.ORANGE,
                `${EMOJIS.info} **FRIDAY Server Profile**\n\n` +
                `**Set avatar:** \`${prefix}setavatar <image URL or Discord message link>\`\n` +
                `**Set banner:** \`${prefix}setbanner <image URL or Discord message link>\`\n` +
                `You can also attach an image to either command, or link a message containing an image from this server.\n\n` +
                `**Reset avatar:** \`${prefix}resetavatar\`\n` +
                `**Reset banner:** \`${prefix}resetbanner\``
            ));
        }

        const imageURL = attachment?.url || args[0];
        const action = isReset ? "reset" : "update";
        const progress = await message.reply(cardReply(
            COLORS.ORANGE,
            `${EMOJIS.info} **FRIDAY Profile**\n${isReset ? "Resetting" : "Updating"} the server-specific ${field} for **${message.guild.name}**…`
        ));

        try {
            const dataURI = isReset
                ? null
                : attachment
                    ? await attachmentToDataURI(attachment)
                    : await resolveDiscordMessageImage(client, message, imageURL);

            await updateGuildProfile(client, message.guild.id, field, dataURI);

            await progress.edit(cardReply(
                COLORS.GREEN,
                `${EMOJIS.success} **Profile ${isReset ? "Reset" : "Updated"}**\nFRIDAY's server-specific ${field} was ${action === "reset" ? "reset to its default" : "updated"} in **${message.guild.name}**.`
            ));
        } catch (error) {
            console.error(`[Bot Avatar] Failed to ${action} guild ${field} for ${message.guild.id}:`, error);

            await progress.edit(cardReply(
                COLORS.RED,
                `${EMOJIS.error} **Profile Update Failed**\nCould not ${action} FRIDAY's server-specific ${field}.\n\n${EMOJIS.warning} ${String(error.message || "Discord rejected the request.").slice(0, 500)}`
            )).catch(() => {});
        }
    });
};
