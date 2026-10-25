const {
    REST,
    Routes,
    MessageFlags,
    PermissionsBitField
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
        throw new Error("Use a valid public HTTPS image URL or attach an image.");
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

async function attachmentToDataURI(attachment) {
    if (!attachment) return null;

    const contentType = (attachment.contentType || "")
        .split(";")[0]
        .trim()
        .toLowerCase();

    if (!IMAGE_TYPES.has(contentType)) {
        throw new Error("Attach a PNG, JPG, WEBP, or GIF image.");
    }

    if (attachment.size > MAX_IMAGE_BYTES) {
        throw new Error("Image is larger than 8 MB.");
    }

    return imageToDataURI(attachment.url);
}

async function updateGuildProfile(client, guildId, field, value) {
    const rest = new REST({ version: "10" }).setToken(client.token);

    await rest.patch(Routes.guildMember(guildId, "@me"), {
        body: { [field]: value }
    });
}

module.exports = (client) => {
    const rest = new REST({ version: "10" }).setToken(
        process.env.DISCORD_TOKEN
    );

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

        if (
            !message.member.permissions.has(
                PermissionsBitField.Flags.ManageGuild
            )
        ) {
            return message.reply(cardReply(
                COLORS.RED,
                `${EMOJIS.error} **Permission Denied**\nYou need **Manage Server** to customize FRIDAY's profile in this server.`
            ));
        }

        const isReset = Boolean(resetCommand[normalized]);
        const attachment = message.attachments.find(file =>
            (file.contentType || "").startsWith("image/")
        );

        if (!isReset && !attachment && !args[0]) {
            return message.reply(cardReply(
                COLORS.ORANGE,
                `${EMOJIS.info} **FRIDAY Server Profile**\n\n` +
                `**Set avatar:** \`${prefix}setavatar <image URL>\`\n` +
                `**Set banner:** \`${prefix}setbanner <image URL>\`\n` +
                `You can also attach an image to either command.\n\n` +
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
                    : await imageToDataURI(imageURL);

            await updateGuildProfile(client, message.guild.id, field, dataURI);

            await progress.edit(cardReply(
                COLORS.GREEN,
                `${EMOJIS.success} **Profile ${isReset ? "Reset" : "Updated"}**\nFRIDAY's server-specific ${field} was ${action === "reset" ? "reset to its default" : "updated"} in **${message.guild.name}**.\n\n${EMOJIS.info} This does not change FRIDAY's global profile.`
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
