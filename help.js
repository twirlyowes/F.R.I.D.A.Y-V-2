const {
    ChannelType,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    PermissionFlagsBits,
    PermissionsBitField,
    MessageFlags,
    AttachmentBuilder,
    MediaGalleryBuilder,
    MediaGalleryItemBuilder,
    FileBuilder,
    TextDisplayBuilder
} = require("discord.js");

const db = require("./firebase");
const guildConfig = require("./lib/guildConfig");
const { parseCommand } = require("./lib/prefix");

const {
    COLORS,
    createCard,
    getAvatarURL
} = require("./lib/pixelVillaUI");

// Legacy role keys are only used to keep previously-open category tickets working.
// New ModMail tickets all use the single Support Role.
const LEGACY_SUPPORT_ROLE_KEYS = {
    minecraft: "supportMinecraft",
    discord: "supportDiscord",
    others: "supportOthers"
};

async function getSupportRoleId(guildId, category) {
    const cfg = await guildConfig.get(guildId);
    const legacyKey = LEGACY_SUPPORT_ROLE_KEYS[category];
    return (legacyKey && cfg[legacyKey]) ||
        cfg.supportRole ||
        cfg.supportMinecraft ||
        cfg.supportDiscord ||
        cfg.supportOthers ||
        null;
}

async function getTicketLogsChannel(client, guildId) {
    const cfg = await guildConfig.get(guildId);
    if (!cfg.ticketLogs) return null;
    return client.channels.fetch(cfg.ticketLogs).catch(() => null);
}

// Servers (with tickets configured) that this user shares with the bot
async function getEligibleGuilds(client, userId) {
    const eligible = [];

    for (const guild of client.guilds.cache.values()) {
        const cfg = await guildConfig.get(guild.id);
        if (!cfg.ticketCategory) continue;

        const member = await guild.members.fetch(userId).catch(() => null);
        if (member) eligible.push(guild);
    }

    return eligible;
}

function buildCategoryRow(guildId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`modmail_cat_support_${guildId}`)
            .setLabel("Open ModMail Ticket")
            .setStyle(ButtonStyle.Primary)
            .setEmoji("📩")
    );
}

function buildServerRow(guilds) {
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId("modmail_srv")
            .setPlaceholder("Choose a server")
            .addOptions(
                guilds.slice(0, 25).map(g => ({
                    label: g.name.slice(0, 100),
                    value: g.id
                }))
            )
    );
}

const CATEGORY_NAMES = {
    support: "ModMail",
    // Keep historic labels for transcripts and tickets opened before the unified flow.
    minecraft: "Minecraft",
    discord: "Discord",
    others: "Others"
};

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)(\?|$)/i;
const MAX_ATTACHMENTS = 10;

// Accepts discord.js Attachment objects, stored objects, or legacy URL strings
function normalizeAttachments(list) {
    const arr = Array.isArray(list)
        ? list
        : list && typeof list.values === "function"
            ? [...list.values()]
            : [];

    return arr
        .map((att, i) => {
            if (typeof att === "string") {
                const clean = att.split("?")[0];
                return {
                    url: att,
                    name: clean.split("/").pop() || `file_${i}`,
                    contentType: null
                };
            }

            return {
                url: att.url,
                name: att.name || `file_${i}`,
                contentType: att.contentType || null
            };
        })
        .filter(att => att.url)
        .slice(0, MAX_ATTACHMENTS);
}

// Shape stored in Firestore for pending (pre-ticket) messages
function serializeAttachments(attachments) {
    return normalizeAttachments(attachments).map(att => ({
        url: att.url,
        name: att.name,
        contentType: att.contentType
    }));
}

function isImageAttachment(att) {
    return (
        (att.contentType && att.contentType.startsWith("image/")) ||
        IMAGE_EXT.test(att.name || "") ||
        IMAGE_EXT.test(att.url || "")
    );
}

// Components V2 messages only display files that are referenced inside
// the components, so a bare `files` array is not shown.
async function sendWithAttachments(target, card, attachments) {
    const list = normalizeAttachments(attachments);

    if (!list.length) {
        return target.send({
            components: [card],
            flags: MessageFlags.IsComponentsV2
        });
    }

    const images = list.filter(isImageAttachment);
    const others = list.filter(att => !isImageAttachment(att));

    const extraComponents = [];
    const files = [];

    // Images: shown straight from the CDN URL (no re-upload, no size limit)
    if (images.length) {
        extraComponents.push(
            new MediaGalleryBuilder().addItems(
                images.map(att =>
                    new MediaGalleryItemBuilder().setURL(att.url)
                )
            )
        );
    }

    // Other files: re-uploaded and referenced with attachment://
    others.forEach((att, i) => {
        const safeName =
            `${i}_${att.name}`.replace(/[^a-zA-Z0-9._-]/g, "_");

        files.push(new AttachmentBuilder(att.url, { name: safeName }));

        extraComponents.push(
            new FileBuilder().setURL(`attachment://${safeName}`)
        );
    });

    try {
        return await target.send({
            components: [card, ...extraComponents],
            flags: MessageFlags.IsComponentsV2,
            files
        });
    } catch (error) {
        console.error(
            "ModMail attachment send failed, falling back to links:",
            error
        );

        // Fallback (e.g. file too large to re-upload): send the links as text
        return target.send({
            components: [
                card,
                new TextDisplayBuilder().setContent(
                    list.map(att => `📎 ${att.url}`).join("\n")
                )
            ],
            flags: MessageFlags.IsComponentsV2
        });
    }
}

async function getNextTicketId() {
    const counterRef = db.collection("modmail").doc("config");

    return await db.runTransaction(async (transaction) => {
        const doc = await transaction.get(counterRef);

        let nextId = 1;

        if (doc.exists) {
            nextId = (doc.data().ticketCounter || 0) + 1;
        }

        transaction.set(
            counterRef,
            { ticketCounter: nextId },
            { merge: true }
        );

        return nextId;
    });
}

function padTicketId(id) {
    return String(id).padStart(4, "0");
}

function mergeOverwrite(list, id, allow = [], deny = []) {
    const idx = list.findIndex(o => o.id === id);

    if (idx !== -1) {
        list[idx].allow = new PermissionsBitField(list[idx].allow)
            .add(allow)
            .remove(deny);

        list[idx].deny = new PermissionsBitField(list[idx].deny)
            .add(deny)
            .remove(allow);
    } else {
        list.push({
            id,
            allow,
            deny
        });
    }
}

function setupHelpCommand(client) {
    if (client.__pixelVillaHelpLoaded) return;

    client.__pixelVillaHelpLoaded = true;

    client.on("messageCreate", async (message) => {
        try {
            if (message.author.bot) return;
            if (!message.content) return;

            const parsed = await parseCommand(message);

            if (!parsed || parsed.command !== "help") return;

            const p = parsed.prefix;

            const avatarURL = client.user.displayAvatarURL({
                extension: "png",
                size: 128
            });

            const helpContent =
`<a:sparkles:1532986077651140620> **F.R.I.D.A.Y — COMMAND CENTER**

> Your all-in-one assistant for moderation, security, server management, and more.
> Explore the command categories below to get started.

<:Shield_2:1532989398642327594> **PREFIX & USAGE**
```yaml
Prefix: ${p}
Example: ${p}help
Alternative: @F.R.I.D.A.Y help
```
-# Your server's configured prefix is used automatically.

<a:ban:1532989769766801511> **MODERATION & SAFETY**
> Keep your community clean, controlled, and protected.
```
${p}warn  ${p}wlist  ${p}wremove  ${p}wreset
${p}strike  ${p}strikes  ${p}unstrike
${p}mute  ${p}unmute  ${p}kick  ${p}ban  ${p}unban  ${p}nick
${p}lock  ${p}unlock  ${p}hide  ${p}unhide
${p}purge  ${p}snipe  ${p}vcp
${p}addbadword  ${p}removebadword  ${p}badwordslist
```

<a:settings:1532990547394957393> **SERVER MANAGEMENT**
> Configure FRIDAY and manage your server's features.
```
${p}config  ${p}prefix  ${p}setupverify  ${p}role
${p}automod  ${p}antinuke
${p}sticky  ${p}say  ${p}dm
${p}atlogs  ${p}resetactivetime  ${p}removeuser  ${p}activetime
```

<:terminal:1532991459005829264> **UTILITIES & INFORMATION**
> Useful tools and quick information whenever you need them.
```
${p}help  ${p}afk  ${p}ping  ${p}uptime  ${p}botinfo
${p}av  ${p}ui  ${p}si  ${p}wiki  ${p}calculate  ${p}quote  ${p}ip
```

🎙️ **TEMPORARY VOICE ROOMS**
> Manage your own temporary voice channel.
```
${p}vclock  ${p}vcunlock  ${p}vchide  ${p}vcunhide
${p}vcname  ${p}vclimit  ${p}vcadd  ${p}vcremove
${p}vckick  ${p}vcowner
```
-# Voice commands are for your own temporary room.

-# <:success_g:1561271843346714777> F.R.I.D.A.Y • Help Module`;

            const card = createCard({
                color: COLORS.SKY_BLUE,
                content: helpContent,
                avatarURL,
                avatarDescription: "F.R.I.D.A.Y avatar"
            });

            await message.reply({
                components: [card],
                flags: MessageFlags.IsComponentsV2
            });

        } catch (error) {
            console.error("Help Command Error:", error);
        }
    });
}

function setupModMail(client) {
    if (client.__pixelVillaModMailLoaded) return;

    client.__pixelVillaModMailLoaded = true;

    client.on("messageCreate", async (message) => {
        try {
            if (message.author.bot) return;

            if (message.channel.type === ChannelType.DM) {
                const userId = message.author.id;

                const existingTicketSnapshot =
                    await db.collection("modmail_tickets")
                        .where("userId", "==", userId)
                        .where("status", "==", "open")
                        .get();

                if (!existingTicketSnapshot.empty) {
                    const ticketData =
                        existingTicketSnapshot.docs[0].data();

                    const ticketChannel =
                        await client.channels
                            .fetch(ticketData.channelId)
                            .catch(() => null);

                    if (!ticketChannel) return;

                    const content =
`<@${userId}> **${message.author.tag}**

${message.content || "*[No Text Content]*"}

-# Sent via F.R.I.D.A.Y ModMail`;

                    const forwardCard = createCard({
                        color: COLORS.SKY_BLUE,
                        content,
                        avatarURL: getAvatarURL(message.author),
                        avatarDescription:
                            `${message.author.username}'s avatar`
                    });

                    await sendWithAttachments(
                        ticketChannel,
                        forwardCard,
                        message.attachments
                    );

                    return;
                }

                const pendingRef =
                    db.collection("modmail_pending").doc(userId);

                const pendingDoc =
                    await pendingRef.get();

                let messagesList = [];

                if (pendingDoc.exists) {
                    messagesList =
                        pendingDoc.data().messages || [];
                }

                messagesList.push({
                    content: message.content,
                    attachments:
                        serializeAttachments(message.attachments),
                    timestamp: new Date().toISOString()
                });

                await pendingRef.set(
                    {
                        messages: messagesList
                    },
                    {
                        merge: true
                    }
                );

                const categoryCard = createCard({
                    color: COLORS.SKY_BLUE,
                    content:
`# 📨 Support Ticket

Open your ModMail ticket below. All enquiries go to one support team.`,
                    avatarURL: getAvatarURL(message.author),
                    avatarDescription:
                        `${message.author.username}'s avatar`
                });

                const eligibleGuilds =
                    await getEligibleGuilds(client, userId);

                if (eligibleGuilds.length === 0) {
                    await pendingRef.delete().catch(() => {});

                    await message.reply(
                        "<:error_g:1561271715164721245> I can't open a support ticket for you: none of the servers we share have support tickets set up."
                    ).catch(() => {});

                    return;
                }

                if (eligibleGuilds.length > 1) {
                    const serverCard = createCard({
                        color: COLORS.SKY_BLUE,
                        content:
`# Choose a Server

Select which server this ticket is for.`,
                        avatarURL: getAvatarURL(message.author),
                        avatarDescription:
                            `${message.author.username}'s avatar`
                    });

                    await message.reply({
                        components: [
                            serverCard,
                            buildServerRow(eligibleGuilds)
                        ],
                        flags: MessageFlags.IsComponentsV2
                    }).catch(() => {});

                    return;
                }

                await message.reply({
                    components: [
                        categoryCard,
                        buildCategoryRow(eligibleGuilds[0].id)
                    ],
                    flags: MessageFlags.IsComponentsV2
                }).catch(() => {});

                return;
            }

            if (message.guild) {
                const ticketSnapshot =
                    await db.collection("modmail_tickets")
                        .where("channelId", "==", message.channel.id)
                        .where("status", "==", "open")
                        .get();

                if (ticketSnapshot.empty) return;

                const ticketData =
                    ticketSnapshot.docs[0].data();

                const ticketUser =
                    await client.users
                        .fetch(ticketData.userId)
                        .catch(() => null);

                if (!ticketUser) return;

                const hideStaff =
                    ticketData.hideStaffName === true;

                const staffName = hideStaff
                    ? "🛡️ F.R.I.D.A.Y"
                    : `🛡️ Staff (${message.author.tag})`;

                const staffAvatar = hideStaff
                    ? client.user
                    : message.author;

                const staffCard = createCard({
                    color: COLORS.SKY_BLUE,
                    content:
`${staffName}

${message.content || "*[No Text Content]*"}

-# F.R.I.D.A.Y • ModMail`,
                    avatarURL: getAvatarURL(staffAvatar),
                    avatarDescription: hideStaff
                        ? "F.R.I.D.A.Y avatar"
                        : `${message.author.username}'s avatar`
                });

                await sendWithAttachments(
                    ticketUser,
                    staffCard,
                    message.attachments
                ).catch(async () => {
                    await message.reply(
                        "<:warning_g:1561271566233501797> Could not send DM to the user. They might have DMs disabled."
                    ).catch(() => {});
                });
            }

        } catch (error) {
            console.error(
                "Error in ModMail messageCreate handler:",
                error
            );
        }
    });

    client.on("interactionCreate", async (interaction) => {
        try {
            if (
                interaction.isStringSelectMenu() &&
                interaction.customId === "modmail_srv"
            ) {
                const chosenGuildId = interaction.values[0];

                const eligibleGuilds =
                    await getEligibleGuilds(client, interaction.user.id);

                if (!eligibleGuilds.some(g => g.id === chosenGuildId)) {
                    await interaction.reply({
                        content: "<:error_g:1561271715164721245> That server isn't available for tickets right now.",
                        ephemeral: true
                    }).catch(() => {});

                    return;
                }

                const categoryCard = createCard({
                    color: COLORS.SKY_BLUE,
                    content:
`# 📨 Support Ticket

Open your ModMail ticket below. All enquiries go to one support team.`,
                    avatarURL: getAvatarURL(interaction.user),
                    avatarDescription:
                        `${interaction.user.username}'s avatar`
                });

                await interaction.update({
                    components: [
                        categoryCard,
                        buildCategoryRow(chosenGuildId)
                    ],
                    flags: MessageFlags.IsComponentsV2
                }).catch(() => {});

                return;
            }

            if (!interaction.isButton()) return;

            const customId = interaction.customId;

            if (customId.startsWith("modmail_cat_")) {
                await interaction.deferUpdate().catch(() => {});

                const userId = interaction.user.id;

                const [categoryKey, buttonGuildId] =
                    customId.replace("modmail_cat_", "").split("_");

                // Ignore stale buttons from the retired Minecraft / Discord / Others flow.
                if (categoryKey !== "support") {
                    await interaction.user.send(
                        "<:warning_g:1561271566233501797> The support options have changed. Send me a new DM to open a ModMail ticket."
                    ).catch(() => {});
                    return;
                }

                let targetGuildId = buttonGuildId;

                if (!targetGuildId) {
                    // Old-style button from before multi-server support
                    const eligibleGuilds =
                        await getEligibleGuilds(client, userId);

                    if (eligibleGuilds.length === 1) {
                        targetGuildId = eligibleGuilds[0].id;
                    }
                }

                if (!targetGuildId) {
                    await interaction.user.send(
                        "<:warning_g:1561271566233501797> Please send me a new message to start your support ticket."
                    ).catch(() => {});

                    return;
                }

                const categoryName =
                    CATEGORY_NAMES[categoryKey] || categoryKey;

                const existingTicketSnapshot =
                    await db.collection("modmail_tickets")
                        .where("userId", "==", userId)
                        .where("status", "==", "open")
                        .get();

                if (!existingTicketSnapshot.empty) {
                    await interaction.user.send(
                        "<:warning_g:1561271566233501797> You already have an active support ticket."
                    ).catch(() => {});

                    return;
                }

                const guild =
                    await client.guilds
                        .fetch(targetGuildId)
                        .catch(() => null);

                if (!guild) {
                    await interaction.user.send(
                        "<:error_g:1561271715164721245> I could not access the support server. Please try again later."
                    ).catch(() => {});

                    return;
                }

                const cfg = await guildConfig.get(guild.id);

                if (!cfg.ticketCategory) {
                    await interaction.user.send(
                        "<:error_g:1561271715164721245> Support tickets aren't set up in that server yet."
                    ).catch(() => {});

                    return;
                }

                let ticketIdNum;

                try {
                    ticketIdNum =
                        await getNextTicketId();
                } catch (error) {
                    console.error(
                        "Ticket ID Error:",
                        error
                    );

                    await interaction.user.send(
                        "<:error_g:1561271715164721245> Something went wrong while creating your ticket. Please try again later."
                    ).catch(() => {});

                    return;
                }

                const formattedId =
                    padTicketId(ticketIdNum);

                const channelName = formattedId;

                const supportRoleId =
                    await getSupportRoleId(guild.id, categoryKey);

                const ticketCategory =
                    guild.channels.cache.get(cfg.ticketCategory) ||
                    await guild.channels
                        .fetch(cfg.ticketCategory)
                        .catch(() => null);

                let categoryOverwrites = [];

                if (
                    ticketCategory &&
                    ticketCategory.type === ChannelType.GuildCategory
                ) {
                    categoryOverwrites =
                        ticketCategory.permissionOverwrites.cache.map(
                            overwrite => ({
                                id: overwrite.id,
                                type: overwrite.type,
                                allow: overwrite.allow,
                                deny: overwrite.deny
                            })
                        );
                }

                mergeOverwrite(
                    categoryOverwrites,
                    guild.id,
                    [],
                    [PermissionFlagsBits.ViewChannel]
                );

                mergeOverwrite(
                    categoryOverwrites,
                    client.user.id,
                    [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.ReadMessageHistory,
                        PermissionFlagsBits.ManageChannels,
                        PermissionFlagsBits.ManageMessages,
                        PermissionFlagsBits.EmbedLinks,
                        PermissionFlagsBits.AttachFiles
                    ]
                );

                if (supportRoleId) {
                    mergeOverwrite(
                        categoryOverwrites,
                        supportRoleId,
                        [
                            PermissionFlagsBits.ViewChannel,
                            PermissionFlagsBits.SendMessages,
                            PermissionFlagsBits.ReadMessageHistory,
                            PermissionFlagsBits.EmbedLinks,
                            PermissionFlagsBits.AttachFiles
                        ]
                    );
                }

                let ticketChannel;

                try {
                    ticketChannel =
                        await guild.channels.create({
                            name: channelName,
                            type: ChannelType.GuildText,
                            parent: cfg.ticketCategory,
                            permissionOverwrites:
                                categoryOverwrites
                        });
                } catch (error) {
                    console.error(
                        "Ticket Channel Creation Error:",
                        error
                    );

                    await interaction.user.send(
                        "<:error_g:1561271715164721245> Failed to create your support ticket. Please try again later."
                    ).catch(() => {});

                    return;
                }

                const now =
                    new Date().toISOString();

                await db.collection("modmail_tickets")
                    .doc(ticketChannel.id)
                    .set({
                        ticketId: ticketIdNum,
                        channelId: ticketChannel.id,
                        guildId: guild.id,
                        userId,
                        category: categoryKey,
                        status: "open",
                        createdAt: now,
                        closedAt: null,
                        closedBy: null,
                        claimedBy: null,
                        hideStaffName: false
                    });

                const pendingRef =
                    db.collection("modmail_pending")
                        .doc(userId);

                const pendingDoc =
                    await pendingRef.get();

                if (pendingDoc.exists) {
                    const messagesList =
                        pendingDoc.data().messages || [];

                    for (const m of messagesList) {
                        const historyCard =
                            createCard({
                                color: COLORS.SKY_BLUE,
                                content:
`${interaction.user.tag}

${m.content || "*[No Text Content]*"}

-# Previous ModMail Message`,
                                avatarURL:
                                    getAvatarURL(interaction.user),
                                avatarDescription:
                                    `${interaction.user.username}'s avatar`
                            });

                        await sendWithAttachments(
                            ticketChannel,
                            historyCard,
                            m.attachments || []
                        ).catch(() => {});
                    }

                    await pendingRef.delete()
                        .catch(() => {});
                }

                const rolePing =
                    supportRoleId
                        ? `<@&${supportRoleId}>`
                        : "";

                const ticketContent =
`${rolePing}

# 📨 F.R.I.D.A.Y

**User**
<@${userId}>

**User ID**
\`${userId}\`

**Category**
${categoryName}

**Ticket**
#${formattedId}

**Status**
🟢 Open

-# Ticket created successfully`;

                const ticketCard =
                    createCard({
                        color: COLORS.GREEN,
                        content: ticketContent,
                        avatarURL:
                            getAvatarURL(interaction.user),
                        avatarDescription:
                            `${interaction.user.username}'s avatar`
                    });

                const actionRow =
                    new ActionRowBuilder()
                        .addComponents(
                            new ButtonBuilder()
                                .setCustomId("modmail_close")
                                .setLabel("Close Ticket")
                                .setStyle(ButtonStyle.Danger)
                                .setEmoji("🔒"),

                            new ButtonBuilder()
                                .setCustomId("modmail_claim")
                                .setLabel("Claim Ticket")
                                .setStyle(ButtonStyle.Primary)
                                .setEmoji("🙋"),

                            new ButtonBuilder()
                                .setCustomId("modmail_hide_staff")
                                .setLabel("Hide Staff Name")
                                .setStyle(ButtonStyle.Secondary)
                                .setEmoji("👤")
                        );

                await ticketChannel.send({
                    components: [
                        ticketCard,
                        actionRow
                    ],
                    flags: MessageFlags.IsComponentsV2
                }).catch(error => {
                    console.error(
                        "Ticket Message Error:",
                        error
                    );
                });

                const confirmationCard =
                    createCard({
                        color: COLORS.GREEN,
                        content:
`# <:success_g:1561271843346714777> Ticket Created

**Ticket:** #${formattedId}
**Category:** ${categoryName}

Our support team will get back to you soon.`,
                        avatarURL:
                            getAvatarURL(interaction.user),
                        avatarDescription:
                            `${interaction.user.username}'s avatar`
                    });

                await interaction.user.send({
                    components: [confirmationCard],
                    flags: MessageFlags.IsComponentsV2
                }).catch(() => {});

                const logsChannel =
                    await getTicketLogsChannel(client, interaction.guildId);

                if (logsChannel) {
                    const logCard =
                        createCard({
                            color: COLORS.GREEN,
                            content:
`# 🎫 Ticket Created

**Ticket:** #${formattedId}
**User:** ${interaction.user.tag}
**User ID:** \`${userId}\`
**Category:** ${categoryName}
**Channel:** <#${ticketChannel.id}>`,
                            avatarURL:
                                getAvatarURL(interaction.user),
                            avatarDescription:
                                `${interaction.user.username}'s avatar`
                        });

                    await logsChannel.send({
                        components: [logCard],
                        flags: MessageFlags.IsComponentsV2
                    }).catch(() => {});
                }

                return;
            }

            if (customId === "modmail_claim") {
                await interaction.deferUpdate().catch(() => {});

                const channelId =
                    interaction.channel.id;

                const ticketRef =
                    db.collection("modmail_tickets")
                        .doc(channelId);

                const ticketDoc =
                    await ticketRef.get();

                if (!ticketDoc.exists) return;

                const ticketData =
                    ticketDoc.data();

                if (ticketData.status !== "open") return;

                const guild =
                    interaction.guild;

                if (!guild) return;

                const member =
                    await guild.members
                        .fetch(interaction.user.id)
                        .catch(() => null);

                if (!member) return;

                const requiredRole =
                    (await getSupportRoleId(interaction.guildId, ticketData.category));

                const isAdmin =
                    member.permissions.has(
                        PermissionFlagsBits.Administrator
                    );

                const hasSupportRole =
                    requiredRole &&
                    member.roles.cache.has(requiredRole);

                if (!isAdmin && !hasSupportRole) {
                    await interaction.followUp({
                        content:
                            "<:error_g:1561271715164721245> You do not have the required support role to claim this ticket.",
                        ephemeral: true
                    }).catch(() => {});

                    return;
                }

                if (ticketData.claimedBy) {
                    await interaction.followUp({
                        content:
                            "<:warning_g:1561271566233501797> This ticket has already been claimed.",
                        ephemeral: true
                    }).catch(() => {});

                    return;
                }

                await ticketRef.update({
                    claimedBy: interaction.user.id
                });

                const claimCard =
                    createCard({
                        color: COLORS.GREEN,
                        content:
`# 🙋 Ticket Claimed

This ticket has been claimed by ${interaction.user}.`,
                        avatarURL:
                            getAvatarURL(interaction.user),
                        avatarDescription:
                            `${interaction.user.username}'s avatar`
                    });

                await interaction.channel.send({
                    components: [claimCard],
                    flags: MessageFlags.IsComponentsV2
                }).catch(() => {});

                const logsChannel =
                    await getTicketLogsChannel(client, interaction.guildId);

                if (logsChannel) {
                    const logCard =
                        createCard({
                            color: COLORS.SKY_BLUE,
                            content:
`# 🙋 Ticket Claimed

**Ticket:** #${padTicketId(ticketData.ticketId)}
**Claimed By:** ${interaction.user.tag}
**User ID:** \`${interaction.user.id}\``,
                            avatarURL:
                                getAvatarURL(interaction.user),
                            avatarDescription:
                                `${interaction.user.username}'s avatar`
                        });

                    await logsChannel.send({
                        components: [logCard],
                        flags: MessageFlags.IsComponentsV2
                    }).catch(() => {});
                }

                return;
            }

            if (customId === "modmail_hide_staff") {
                const channelId =
                    interaction.channel.id;

                const ticketRef =
                    db.collection("modmail_tickets")
                        .doc(channelId);

                const ticketDoc =
                    await ticketRef.get();

                if (!ticketDoc.exists) return;

                const ticketData =
                    ticketDoc.data();

                if (ticketData.status !== "open") return;

                const guild =
                    interaction.guild;

                if (!guild) return;

                const member =
                    await guild.members
                        .fetch(interaction.user.id)
                        .catch(() => null);

                if (!member) return;

                const requiredRole =
                    (await getSupportRoleId(interaction.guildId, ticketData.category));

                const isAdmin =
                    member.permissions.has(
                        PermissionFlagsBits.Administrator
                    );

                const hasSupportRole =
                    requiredRole &&
                    member.roles.cache.has(requiredRole);

                if (!isAdmin && !hasSupportRole) {
                    await interaction.reply({
                        content:
                            "<:error_g:1561271715164721245> You do not have the required support role to change this setting.",
                        ephemeral: true
                    }).catch(() => {});

                    return;
                }

                const currentHideState =
                    ticketData.hideStaffName === true;

                const newHideState =
                    !currentHideState;

                await ticketRef.update({
                    hideStaffName: newHideState
                });

                const confirmationCard =
                    createCard({
                        color: COLORS.SKY_BLUE,
                        content:
                            newHideState
                                ? `# 👤 Staff Name Hidden

Staff names will now be hidden from the user.`
                                : `# 👁️ Staff Name Visible

Staff names will now be shown to the user.`,
                        avatarURL:
                            getAvatarURL(interaction.user),
                        avatarDescription:
                            `${interaction.user.username}'s avatar`
                    });

                await interaction.reply({
                    components: [confirmationCard],
                    flags:
                        MessageFlags.IsComponentsV2 |
                        MessageFlags.Ephemeral
                }).catch(() => {});

                return;
            }

            if (customId === "modmail_close") {
                const channelId = interaction.channel.id;
                const ticketRef = db.collection("modmail_tickets").doc(channelId);
                const ticketDoc = await ticketRef.get();
                if (!ticketDoc.exists) return;

                const ticketData = ticketDoc.data();
                if (ticketData.status !== "open") return;

                const guild = interaction.guild;
                if (!guild) return;

                const member = await guild.members.fetch(interaction.user.id).catch(() => null);
                if (!member) return;

                const requiredRole = (await getSupportRoleId(interaction.guildId, ticketData.category));
                const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);
                const hasSupportRole = requiredRole && member.roles.cache.has(requiredRole);

                if (!isAdmin && !hasSupportRole) {
                    await interaction.reply({
                        content: "<:error_g:1561271715164721245> You do not have the required support role to close this ticket.",
                        ephemeral: true
                    }).catch(() => {});
                    return;
                }

                const formattedId = padTicketId(ticketData.ticketId);
                const confirmationCard = createCard({
                    color: COLORS.RED,
                    content:
                        "# 🔒 Close Support Ticket\n\n" +
                        "Are you sure you want to close ticket **#" + formattedId + "**?\n\n" +
                        "A transcript of this ticket will be generated and sent to the ModMail log channel before the ticket is deleted.\n\n" +
                        "-# This action cannot be undone.",
                    avatarURL: getAvatarURL(interaction.user),
                    avatarDescription: interaction.user.username + "'s avatar"
                });

                const confirmationRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId("modmail_close_confirm")
                        .setLabel("Confirm Close")
                        .setStyle(ButtonStyle.Success)
                        .setEmoji("🔒"),
                    new ButtonBuilder()
                        .setCustomId("modmail_close_cancel")
                        .setLabel("Cancel")
                        .setStyle(ButtonStyle.Danger)
                        .setEmoji("✖️")
                );

                await interaction.update({
                    components: [confirmationCard, confirmationRow],
                    flags: MessageFlags.IsComponentsV2
                }).catch(() => {});

                return;
            }

            if (customId === "modmail_close_cancel") {
                await interaction.deferUpdate().catch(() => {});

                const channelId = interaction.channel.id;
                const ticketDoc = await db.collection("modmail_tickets").doc(channelId).get();
                if (!ticketDoc.exists) return;

                const ticketData = ticketDoc.data();
                if (ticketData.status !== "open") return;

                const formattedId = padTicketId(ticketData.ticketId);
                const categoryName = CATEGORY_NAMES[ticketData.category] || ticketData.category;
                const ticketUser = await client.users.fetch(ticketData.userId).catch(() => null);

                const ticketCard = createCard({
                    color: COLORS.GREEN,
                    content:
                        "# 📨 F.R.I.D.A.Y\n\n" +
                        "**User**\n<@" + ticketData.userId + ">\n\n" +
                        "**User ID**\n`" + ticketData.userId + "`\n\n" +
                        "**Category**\n" + categoryName + "\n\n" +
                        "**Ticket**\n#" + formattedId + "\n\n" +
                        "**Status**\n🟢 Open\n\n" +
                        "-# Ticket closure cancelled",
                    avatarURL: ticketUser ? getAvatarURL(ticketUser) : getAvatarURL(client.user),
                    avatarDescription: ticketUser ? ticketUser.username + "'s avatar" : "F.R.I.D.A.Y avatar"
                });

                const actionRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId("modmail_close")
                        .setLabel("Close Ticket")
                        .setStyle(ButtonStyle.Danger)
                        .setEmoji("🔒"),
                    new ButtonBuilder()
                        .setCustomId("modmail_claim")
                        .setLabel("Claim Ticket")
                        .setStyle(ButtonStyle.Primary)
                        .setEmoji("🙋"),
                    new ButtonBuilder()
                        .setCustomId("modmail_hide_staff")
                        .setLabel("Hide Staff Name")
                        .setStyle(ButtonStyle.Secondary)
                        .setEmoji("👤")
                );

                await interaction.message.edit({
                    components: [ticketCard, actionRow],
                    flags: MessageFlags.IsComponentsV2
                }).catch(() => {});

                return;
            }

            if (customId === "modmail_close_confirm") {
                await interaction.deferUpdate().catch(() => {});

                const channelId = interaction.channel.id;
                const ticketRef = db.collection("modmail_tickets").doc(channelId);
                const ticketDoc = await ticketRef.get();
                if (!ticketDoc.exists) return;

                const ticketData = ticketDoc.data();
                if (ticketData.status !== "open") return;

                const guild = interaction.guild;
                if (!guild) return;

                const member = await guild.members.fetch(interaction.user.id).catch(() => null);
                if (!member) return;

                const requiredRole = (await getSupportRoleId(interaction.guildId, ticketData.category));
                const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);
                const hasSupportRole = requiredRole && member.roles.cache.has(requiredRole);

                if (!isAdmin && !hasSupportRole) {
                    await interaction.followUp({
                        content: "<:error_g:1561271715164721245> You do not have the required support role to close this ticket.",
                        ephemeral: true
                    }).catch(() => {});
                    return;
                }

                const now = new Date().toISOString();
                const formattedId = padTicketId(ticketData.ticketId);
                let transcript = "";
                let transcriptMessageCount = 0;

                try {
                    const allMessages = [];
                    let before;

                    while (true) {
                        const options = { limit: 100 };
                        if (before) options.before = before;
                        const batch = await interaction.channel.messages.fetch(options);
                        if (!batch.size) break;
                        allMessages.push(...batch.values());
                        before = batch.last().id;
                        if (batch.size < 100) break;
                    }

                    allMessages.reverse();

                    const lines = [
                        "F.R.I.D.A.Y • ModMail Transcript",
                        "==========================================",
                        "Ticket: #" + formattedId,
                        "Channel: " + interaction.channel.name,
                        "User ID: " + ticketData.userId,
                        "Category: " + (CATEGORY_NAMES[ticketData.category] || ticketData.category),
                        "Created: " + ticketData.createdAt,
                        "Closed: " + now,
                        "Closed By: " + interaction.user.tag + " (" + interaction.user.id + ")",
                        "",
                        "Messages",
                        "--------",
                        ""
                    ];

                    for (const msg of allMessages) {
                        transcriptMessageCount++;
                        const timestamp = msg.createdAt ? new Date(msg.createdAt).toISOString() : "Unknown time";
                        const author = (msg.author?.tag || msg.author?.username || "Unknown User") + " (" + (msg.author?.id || "unknown") + ")";
                        const msgContent = msg.content || "[No text content]";

                        lines.push("[" + timestamp + "] " + author, msgContent);

                        if (msg.attachments?.size) {
                            for (const attachment of msg.attachments.values()) {
                                lines.push("Attachment: " + (attachment.name || "file"), "URL: " + attachment.url);
                            }
                        }

                        lines.push("");
                    }

                    lines.push("--------", "Total messages: " + transcriptMessageCount);
                    transcript = lines.join("\n");
                } catch (error) {
                    console.error("ModMail transcript generation error:", error);
                    transcript = [
                        "F.R.I.D.A.Y • ModMail Transcript",
                        "==========================================",
                        "Ticket: #" + formattedId,
                        "User ID: " + ticketData.userId,
                        "Category: " + (CATEGORY_NAMES[ticketData.category] || ticketData.category),
                        "Created: " + ticketData.createdAt,
                        "Closed: " + now,
                        "Closed By: " + interaction.user.tag + " (" + interaction.user.id + ")",
                        "",
                        "Transcript generation encountered an error.",
                        "Please check the Render logs for details."
                    ].join("\n");
                }

                await ticketRef.update({
                    status: "closed",
                    closedAt: now,
                    closedBy: interaction.user.id
                });

                const ticketUser = await client.users.fetch(ticketData.userId).catch(() => null);

                if (ticketUser) {
                    const closeCard = createCard({
                        color: COLORS.RED,
                        content:
                            "# 🔒 Support Ticket Closed\n\n" +
                            "Your F.R.I.D.A.Y ticket **#" + formattedId + "** has been closed.\n\n" +
                            "A transcript has been saved to the support team's ModMail logs.\n\n" +
                            "If you need further assistance, you can send the bot a new DM.",
                        avatarURL: getAvatarURL(interaction.user),
                        avatarDescription: interaction.user.username + "'s avatar"
                    });

                    await ticketUser.send({
                        components: [closeCard],
                        flags: MessageFlags.IsComponentsV2
                    }).catch(() => {});
                }

                const logsChannel = await getTicketLogsChannel(client, interaction.guildId);

                if (logsChannel) {
                    const closeLogCard = createCard({
                        color: COLORS.RED,
                        content:
                            "# 🔒 Ticket Closed\n\n" +
                            "**Ticket:** #" + formattedId + "\n" +
                            "**User:** <@" + ticketData.userId + ">\n" +
                            "**User ID:** `" + ticketData.userId + "`\n" +
                            "**Closed By:** " + interaction.user.tag + "\n" +
                            "**Closed By ID:** `" + interaction.user.id + "`\n" +
                            "**Created:** " + ticketData.createdAt + "\n" +
                            "**Closed:** " + now + "\n" +
                            "**Transcript Messages:** " + transcriptMessageCount,
                        avatarURL: getAvatarURL(interaction.user),
                        avatarDescription: interaction.user.username + "'s avatar"
                    });

                    const transcriptFile = new AttachmentBuilder(
                        Buffer.from(transcript, "utf8"),
                        { name: "modmail-" + formattedId + "-transcript.txt" }
                    );

                    await logsChannel.send({
                        components: [closeLogCard],
                        files: [transcriptFile],
                        flags: MessageFlags.IsComponentsV2
                    }).catch(async error => {
                        console.error("ModMail transcript log send failed:", error);
                        await logsChannel.send({
                            content: "<:warning_g:1561271566233501797> Transcript upload failed for ticket #" + formattedId + ".",
                            files: [transcriptFile]
                        }).catch(() => {});
                    });
                }

                const closingCard = createCard({
                    color: COLORS.RED,
                    content: "# 🔒 Ticket Closed\n\nThis ticket will be deleted in **5 seconds**.",
                    avatarURL: getAvatarURL(interaction.user),
                    avatarDescription: interaction.user.username + "'s avatar"
                });

                await interaction.channel.send({
                    components: [closingCard],
                    flags: MessageFlags.IsComponentsV2
                }).catch(() => {});

                setTimeout(async () => {
                    const channel = await client.channels.fetch(channelId).catch(() => null);
                    if (channel) await channel.delete().catch(() => {});
                }, 5000);

                return;
            }
        } catch (error) {
            console.error(
                "Error in ModMail interactionCreate handler:",
                error
            );
        }
    });
}

module.exports = function (client) {
    setupHelpCommand(client);
    setupModMail(client);
};