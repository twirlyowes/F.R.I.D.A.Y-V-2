const {
    MessageFlags
} = require("discord.js");

const db = require("./firebase");

const {
    COLORS,
    createCard,
    getAvatarURL
} = require("./lib/pixelVillaUI");

const guildConfig = require("./lib/guildConfig");
const { parseCommand } = require("./lib/prefix");
const { extractSnowflake } = require("./lib/commandArgs");

// All tracking maps are keyed "guildId:userId" so servers never mix stats.
const trackKey = (guildId, userId) => `${guildId}:${userId}`;

function atlogsAllowed(message) {
    const roleId = guildConfig.peek(message.guild.id).atlogsRole;
    return Boolean(roleId && message.member.roles.cache.has(roleId));
}

const activeSessions = new Map();
const voiceSessions = new Map();

let dailyActiveTimes = new Map();
let dailyVoiceTimes = new Map();
let dailyMessageCounts = new Map();
let dailyCommandCounts = new Map();

let isSaving = false;
let savePending = false;

let lastResetDate = null;
let lastReportDate = null;

function formatHM(ms) {
    const totalMinutes = Math.floor(ms / 60000);
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;

    return `${h}h ${m}m`;
}

function noPingOptions(extra = {}) {
    return {
        ...extra,
        allowedMentions: {
            parse: []
        }
    };
}

async function loadSavedTimes() {
    try {
        const snapshot = await db.collection("activetime").get();

        snapshot.forEach(doc => {
            if (!doc.id.includes(":")) return; // legacy un-scoped record

            const data = doc.data();

            dailyActiveTimes.set(
                doc.id,
                data.activeTime || 0
            );

            dailyVoiceTimes.set(
                doc.id,
                data.voiceTime || 0
            );

            dailyMessageCounts.set(
                doc.id,
                data.messages || 0
            );

            dailyCommandCounts.set(
                doc.id,
                data.commands || 0
            );
        });

        console.log("<:success_g:1561271843346714777> Active times loaded from Firebase");
    } catch (error) {
        console.error(
            "<:error_g:1561271715164721245> Firebase load error:",
            error
        );
    }
}

async function loadLastResetDate() {
    try {
        const doc = await db
            .collection("meta")
            .doc("dailyReset")
            .get();

        if (doc.exists) {
            lastResetDate =
                doc.data().lastResetDate || null;

            lastReportDate =
                doc.data().lastReportDate || null;
        }

        console.log(
            `<:success_g:1561271843346714777> Last reset date loaded: ${lastResetDate || "(none recorded yet)"} | Last report date: ${lastReportDate || "(none recorded yet)"}`
        );
    } catch (error) {
        console.error(
            "<:error_g:1561271715164721245> Firebase loadLastResetDate error:",
            error
        );
    }
}

async function saveLastResetDate(dateStr) {
    try {
        await db
            .collection("meta")
            .doc("dailyReset")
            .set(
                {
                    lastResetDate: dateStr
                },
                {
                    merge: true
                }
            );

        lastResetDate = dateStr;
    } catch (error) {
        console.error(
            "<:error_g:1561271715164721245> Firebase saveLastResetDate error:",
            error
        );
    }
}

async function saveLastReportDate(dateStr) {
    try {
        await db
            .collection("meta")
            .doc("dailyReset")
            .set(
                {
                    lastReportDate: dateStr
                },
                {
                    merge: true
                }
            );

        lastReportDate = dateStr;
    } catch (error) {
        console.error(
            "<:error_g:1561271715164721245> Firebase saveLastReportDate error:",
            error
        );
    }
}

async function executeSaveWithRetry() {
    try {
        const batch = db.batch();

        const users = new Set([
            ...dailyActiveTimes.keys(),
            ...dailyVoiceTimes.keys(),
            ...dailyMessageCounts.keys(),
            ...dailyCommandCounts.keys()
        ]);

        for (const userId of users) {
            const ref = db
                .collection("activetime")
                .doc(userId);

            batch.set(
                ref,
                {
                    activeTime:
                        dailyActiveTimes.get(userId) || 0,

                    voiceTime:
                        dailyVoiceTimes.get(userId) || 0,

                    messages:
                        dailyMessageCounts.get(userId) || 0,

                    commands:
                        dailyCommandCounts.get(userId) || 0,

                    updatedAt: new Date()
                },
                {
                    merge: true
                }
            );
        }

        await batch.commit();

        return true;
    } catch (error) {
        console.error(
            "<:error_g:1561271715164721245> Firebase save error:",
            error
        );

        return false;
    }
}

async function saveTimesToFileWithQueue() {
    if (isSaving) {
        savePending = true;
        return;
    }

    isSaving = true;

    try {
        await executeSaveWithRetry();
    } finally {
        isSaving = false;

        if (savePending) {
            savePending = false;

            await saveTimesToFileWithQueue();
        }
    }
}

async function performDailyReset(guildId = null) {
    try {
        const allKnownIds = new Set([
            ...dailyActiveTimes.keys(),
            ...dailyVoiceTimes.keys(),
            ...dailyMessageCounts.keys(),
            ...dailyCommandCounts.keys(),
            ...activeSessions.keys(),
            ...voiceSessions.keys()
        ]);
        if (guildId) {
            for (const key of [...allKnownIds]) {
                if (!key.startsWith(`${guildId}:`)) allKnownIds.delete(key);
            }
        }

        const batch = db.batch();

        for (const userId of allKnownIds) {
            const ref = db
                .collection("activetime")
                .doc(userId);

            batch.set(
                ref,
                {
                    activeTime: 0,
                    voiceTime: 0,
                    messages: 0,
                    commands: 0,
                    updatedAt: new Date()
                },
                {
                    merge: true
                }
            );
        }

        await batch.commit();

        const freshNow = Date.now();

        for (const userId of allKnownIds) {
            dailyActiveTimes.set(userId, 0);
            dailyVoiceTimes.set(userId, 0);
            dailyMessageCounts.set(userId, 0);
            dailyCommandCounts.set(userId, 0);

            if (activeSessions.has(userId)) {
                activeSessions.set(
                    userId,
                    freshNow
                );
            }

            if (voiceSessions.has(userId)) {
                voiceSessions.set(
                    userId,
                    freshNow
                );
            }
        }

        console.log(
            `<:success_g:1561271843346714777> Daily reset complete: zeroed stats for ${allKnownIds.size} tracked member(s). Nothing was deleted.`
        );
    } catch (error) {
        console.error(
            "<:error_g:1561271715164721245> [DailyReset] Error:",
            error && error.stack
                ? error.stack
                : error
        );
    }
}

async function removeUserRecord(guildId, rawUserId) {
    const userId = trackKey(guildId, rawUserId);
    try {
        await db
            .collection("activetime")
            .doc(userId)
            .delete();
    } catch (error) {
        console.error(
            `<:error_g:1561271715164721245> [RemoveUser] Firebase delete error for ${rawUserId}:`,
            error
        );

        throw error;
    }

    dailyActiveTimes.delete(userId);
    dailyVoiceTimes.delete(userId);
    dailyMessageCounts.delete(userId);
    dailyCommandCounts.delete(userId);

    activeSessions.delete(userId);
    voiceSessions.delete(userId);
}

module.exports = (client) => {
    client.on("guildCreate", guild => {
        guildConfig.get(guild.id).catch(() => {});
    });

    // Active Time tracks the "activityRole" if one is set, otherwise the staff role.
    const isStaff = (member) =>
        guildConfig.isStaffSync(
            member,
            member?.guild && guildConfig.peek(member.guild.id).activityRole
                ? "activityRole"
                : "staffRole"
        );

    client.once("ready", async () => {
        console.log(
            "[DEBUG] Client ready event triggered. Loading saved times..."
        );

        await loadSavedTimes();
        await loadLastResetDate();

        for (const g of client.guilds.cache.values()) {
            await guildConfig.get(g.id);
        }

        const now = Date.now();

        for (const guild of client.guilds.cache.values()) {
            guild.members.cache.forEach(member => {
                if (
                    !member.user.bot &&
                    isStaff(member)
                ) {
                    const status =
                        member.presence
                            ? member.presence.status
                            : "offline";

                    if (status !== "offline") {
                        activeSessions.set(trackKey(member.guild.id, member.id), now);
                    }

                    if (
                        member.voice &&
                        member.voice.channel
                    ) {
                        voiceSessions.set(trackKey(member.guild.id, member.id), now);
                    }
                }
            });
        }

        startClockChecker(client);

        setInterval(
            async () => {
                const currentTimestamp =
                    Date.now();

                for (
                    const [
                        userId,
                        startTime
                    ] of activeSessions.entries()
                ) {
                    const duration =
                        currentTimestamp -
                        startTime;

                    dailyActiveTimes.set(
                        userId,
                        (
                            dailyActiveTimes.get(
                                userId
                            ) || 0
                        ) + duration
                    );

                    activeSessions.set(
                        userId,
                        currentTimestamp
                    );
                }

                for (
                    const [
                        userId,
                        startTime
                    ] of voiceSessions.entries()
                ) {
                    const duration =
                        currentTimestamp -
                        startTime;

                    dailyVoiceTimes.set(
                        userId,
                        (
                            dailyVoiceTimes.get(
                                userId
                            ) || 0
                        ) + duration
                    );

                    voiceSessions.set(
                        userId,
                        currentTimestamp
                    );
                }

                await saveTimesToFileWithQueue();
            },
            15 * 60 * 1000
        );
    });

    function startClockChecker(clientInstance) {
        let cycleRunning = false;

        setInterval(
            async () => {
                if (cycleRunning) return;

                const nowOptions = {
                    timeZone: "Asia/Kolkata",
                    hour12: false
                };

                const istDateString =
                    new Intl.DateTimeFormat(
                        "en-US",
                        {
                            ...nowOptions,
                            dateStyle: "short"
                        }
                    ).format(new Date());

                const istTimeStr =
                    new Intl.DateTimeFormat(
                        "en-US",
                        {
                            ...nowOptions,
                            hour: "numeric",
                            minute: "numeric"
                        }
                    ).format(new Date());

                const [
                    istHours,
                    istMinutes
                ] = istTimeStr
                    .split(":")
                    .map(Number);

                const pastReportTime =
                    istHours > 3 ||
                    (
                        istHours === 3 &&
                        istMinutes >= 0
                    );

                const pastResetTime =
                    istHours > 3 ||
                    (
                        istHours === 3 &&
                        istMinutes >= 5
                    );

                const reportDueOrOverdue =
                    pastReportTime &&
                    lastReportDate !==
                        istDateString;

                const resetDueOrOverdue =
                    pastResetTime &&
                    lastReportDate ===
                        istDateString &&
                    lastResetDate !==
                        istDateString;

                if (
                    !reportDueOrOverdue &&
                    !resetDueOrOverdue
                ) {
                    return;
                }

                cycleRunning = true;

                try {
                    if (reportDueOrOverdue) {
                        const overdue =
                            istHours > 3 ||
                            istMinutes > 0;

                        console.log(
                            overdue
                                ? `[Auto-Sender] Missed 3:00 AM IST report for ${istDateString} — sending catch-up report now...`
                                : "[Auto-Sender] Triggering 3:00 AM IST Daily Report..."
                        );

                        for (const guild of clientInstance.guilds.cache.values()) {
                            if (!guildConfig.peek(guild.id).logs) continue;

                            const reportSent =
                                await sendDailyReport(guild);

                            if (!reportSent) {
                                console.error(
                                    `<:warning_g:1561271566233501797> [Auto-Sender] Daily report FAILED for ${guild.name} (${guild.id}).`
                                );
                            }
                        }

                        await saveLastReportDate(
                            istDateString
                        );

                        return;
                    }

                    if (resetDueOrOverdue) {
                        console.log(
                            `[Auto-Sender] Running 3:05 AM IST reset for ${istDateString}...`
                        );

                        await performDailyReset();

                        await saveLastResetDate(
                            istDateString
                        );

                        console.log(
                            `<:success_g:1561271843346714777> Daily tracking data has been safely reset and saved for ${istDateString} IST.`
                        );
                    }
                } finally {
                    cycleRunning = false;
                }
            },
            60 * 1000
        );
    }

    async function sendDailyReport(guild) {
        try {
            const channel =
                await guildConfig.getLogChannel(guild);

            if (!channel) {
                console.error(
                    `<:error_g:1561271715164721245> [DailyReport] No log channel configured for ${guild.name} (${guild.id}). Use the config command: config set logs #channel`
                );
                return false;
            }

            const now = Date.now();

            for (
                const [
                    userId,
                    startTime
                ] of activeSessions.entries()
            ) {
                dailyActiveTimes.set(
                    userId,
                    (
                        dailyActiveTimes.get(
                            userId
                        ) || 0
                    ) +
                        (
                            now -
                            startTime
                        )
                );

                activeSessions.set(
                    userId,
                    now
                );
            }

            for (
                const [
                    userId,
                    startTime
                ] of voiceSessions.entries()
            ) {
                dailyVoiceTimes.set(
                    userId,
                    (
                        dailyVoiceTimes.get(
                            userId
                        ) || 0
                    ) +
                        (
                            now -
                            startTime
                        )
                );

                voiceSessions.set(
                    userId,
                    now
                );
            }

            const allKnownIds = new Set([
                ...dailyActiveTimes.keys(),
                ...dailyVoiceTimes.keys(),
                ...dailyMessageCounts.keys(),
                ...dailyCommandCounts.keys()
            ]);

            const eligible =
                Array.from(allKnownIds).filter(key => key.startsWith(`${guild.id}:`))
                    .filter(userId => {
                        const activeTime =
                            dailyActiveTimes.get(
                                userId
                            ) || 0;

                        const voiceTime =
                            dailyVoiceTimes.get(
                                userId
                            ) || 0;

                        const messages =
                            dailyMessageCounts.get(
                                userId
                            ) || 0;

                        const commands =
                            dailyCommandCounts.get(
                                userId
                            ) || 0;

                        return (
                            activeTime > 0 ||
                            voiceTime > 0 ||
                            messages > 0 ||
                            commands > 0
                        );
                    });

            const sortedStaff =
                eligible.sort((a, b) => {
                    return (
                        (
                            dailyActiveTimes.get(
                                b
                            ) || 0
                        ) -
                        (
                            dailyActiveTimes.get(
                                a
                            ) || 0
                        )
                    );
                });

            const reportLines = [];

            if (sortedStaff.length === 0) {
                reportLines.push(
                    "No active staff activity recorded today."
                );
            } else {
                for (const userId of sortedStaff) {
                    const activeTime =
                        dailyActiveTimes.get(
                            userId
                        ) || 0;

                    const voiceTime =
                        dailyVoiceTimes.get(
                            userId
                        ) || 0;

                    const messages =
                        dailyMessageCounts.get(
                            userId
                        ) || 0;

                    const commands =
                        dailyCommandCounts.get(
                            userId
                        ) || 0;

                    reportLines.push(
                        `<@${userId.split(":")[1]}> • 🟢 **${formatHM(activeTime)}** • 🎙️ **${formatHM(voiceTime)}** • 💬 **${messages}** • ⚙️ **${commands}**`
                    );
                }
            }

     const chunks = [];

            let currentFieldValue = "";

            for (const line of reportLines) {
                if (
                    (
                        currentFieldValue +
                        line +
                        "\n"
                    ).length > 3800
                ) {
                    chunks.push(
                        currentFieldValue
                    );

                    currentFieldValue = "";
                }

                currentFieldValue +=
                    line + "\n";
            }

            if (currentFieldValue) {
                chunks.push(
                    currentFieldValue
                );
            }

            for (
                let i = 0;
                i < chunks.length;
                i++
            ) {
                const card =
                    createCard({
                        color:
                            COLORS.SKY_BLUE,

                        avatarURL:
                            client.user.displayAvatarURL({
                                extension: "png",
                                size: 128
                            }),

                        avatarDescription:
                            "F.R.I.D.A.Y",

                        content:
                            `# ${
                                i === 0
                                    ? "Daily Staff Activity Report"
                                    : "Daily Staff Activity Report (continued)"
                            }\n\n${
                                chunks[i]
                            }\n-# F.R.I.D.A.Y • Activity Module`
                    });

                await channel.send(
                    noPingOptions({
                        components: [card],
                        flags:
                            MessageFlags.IsComponentsV2
                    })
                );
            }

            console.log(
                `<:success_g:1561271843346714777> [DailyReport] Sent successfully to #${channel.name || channel.id} (${chunks.length} card(s), ${sortedStaff.length} staff member(s)).`
            );

            await saveTimesToFileWithQueue();

            return true;
        } catch (err) {
            console.error(
                "<:error_g:1561271715164721245> [DailyReport] Error sending daily report:",
                err && err.stack
                    ? err.stack
                    : err
            );

            return false;
        }
    }

    client.on(
        "presenceUpdate",
        async (
            oldPresence,
            newPresence
        ) => {
            const member =
                newPresence.member;

            if (
                !member ||
                member.user.bot ||
                !isStaff(member)
            ) {
                return;
            }

            const userId = trackKey(member.guild.id, member.id);

            const oldStatus =
                oldPresence
                    ? oldPresence.status
                    : "offline";

            const newStatus =
                newPresence
                    ? newPresence.status
                    : "offline";

            const isNowActive =
                newStatus !== "offline";

            const wasActive =
                oldStatus !== "offline";

            if (
                isNowActive &&
                !wasActive
            ) {
                if (
                    !activeSessions.has(
                        userId
                    )
                ) {
                    activeSessions.set(
                        userId,
                        Date.now()
                    );
                }
            } else if (
                !isNowActive &&
                wasActive
            ) {
                if (
                    activeSessions.has(
                        userId
                    )
                ) {
                    const duration =
                        Date.now() -
                        activeSessions.get(
                            userId
                        );

                    dailyActiveTimes.set(
                        userId,
                        (
                            dailyActiveTimes.get(
                                userId
                            ) || 0
                        ) + duration
                    );

                    activeSessions.delete(
                        userId
                    );
                }
            }
        }
    );

    client.on(
        "voiceStateUpdate",
        (
            oldState,
            newState
        ) => {
            const member =
                newState.member ||
                oldState.member;

            if (
                !member ||
                member.user.bot ||
                !isStaff(member)
            ) {
                return;
            }

            const userId = trackKey(member.guild.id, member.id);

            const oldChannel =
                oldState.channelId;

            const newChannel =
                newState.channelId;

            if (
                !oldChannel &&
                newChannel
            ) {
                if (
                    !voiceSessions.has(
                        userId
                    )
                ) {
                    voiceSessions.set(
                        userId,
                        Date.now()
                    );
                }
            } else if (
                oldChannel &&
                !newChannel
            ) {
                if (
                    voiceSessions.has(
                        userId
                    )
                ) {
                    const duration =
                        Date.now() -
                        voiceSessions.get(
                            userId
                        );

                    dailyVoiceTimes.set(
                        userId,
                        (
                            dailyVoiceTimes.get(
                                userId
                            ) || 0
                        ) + duration
                    );

                    voiceSessions.delete(
                        userId
                    );
                }
            }
        }
    );

    client.on(
        "messageCreate",
        async message => {
            if (
                message.author.bot ||
                !message.guild
            ) {
                return;
            }

            const member =
                message.member;

            if (
                member &&
                isStaff(member)
            ) {
                const userId = trackKey(member.guild.id, member.id);

                dailyMessageCounts.set(
                    userId,
                    (
                        dailyMessageCounts.get(
                            userId
                        ) || 0
                    ) + 1
                );
            }

            const parsed =
                await parseCommand(message);

            const words =
                parsed ? parsed.args : [];

            const commandName =
                parsed ? parsed.command : "";

            const modCommands = [
                "warn",
                "mute",
                "unmute",
                "kick",
                "ban",
                "unban",
                "nick",
                "wlist",
                "wremove",
                "wreset",
                "strike",
                "unstrike"
            ];

            if (
                modCommands.includes(
                    commandName
                ) &&
                member &&
                isStaff(member)
            ) {
                const userId = trackKey(member.guild.id, member.id);

                dailyCommandCounts.set(
                    userId,
                    (
                        dailyCommandCounts.get(
                            userId
                        ) || 0
                    ) + 1
                );
            }

            if (
                commandName ===
                "atlogs"
            ) {
                if (words.length !== 0) return message.reply("Usage: " + parsed.prefix + "atlogs (no arguments).");
                const hasAdmin =
                    message.member.permissions.has(
                        "Administrator"
                    );

                const hasRole =
                    atlogsAllowed(message);

                if (
                    !hasAdmin &&
                    !hasRole
                ) {
                    const card =
                        createCard({
                            color:
                                COLORS.RED,

                            content:
                                "<:error_g:1561271715164721245> **Permission Denied**\nYou do not have permission to use this command."
                        });

                    return message.reply(
                        noPingOptions({
                            components: [
                                card
                            ],
                            flags:
                                MessageFlags.IsComponentsV2
                        })
                    );
                }

                const loadingCard =
                    createCard({
                        color:
                            COLORS.SKY_BLUE,

                        content:
                            "🔄 **Generating Staff Activity Report**\nPlease wait while the report is generated..."
                    });

                await message.reply(
                    noPingOptions({
                        components: [
                            loadingCard
                        ],
                        flags:
                            MessageFlags.IsComponentsV2
                    })
                );

                await sendDailyReport(
                    message.guild
                );

                return;
            }

            if (
                commandName ===
                "resetactivetime"
            ) {
                if (words.length !== 0) return message.reply("Usage: " + parsed.prefix + "resetactivetime resets activity tracking for the whole server; no user argument is accepted.");
                const hasAdmin =
                    message.member.permissions.has(
                        "Administrator"
                    );

                const hasRole =
                    atlogsAllowed(message);

                if (
                    !hasAdmin &&
                    !hasRole
                ) {
                    const card =
                        createCard({
                            color:
                                COLORS.RED,

                            content:
                                "<:error_g:1561271715164721245> **Permission Denied**\nYou do not have permission to use this command."
                        });

                    return message.reply(
                        noPingOptions({
                            components: [
                                card
                            ],
                            flags:
                                MessageFlags.IsComponentsV2
                        })
                    );
                }

                const loadingCard =
                    createCard({
                        color:
                            COLORS.SKY_BLUE,

                        content:
                            "🔄 **Resetting Activity Tracking**\nSending the current activity snapshot before resetting..."
                    });

                await message.reply(
                    noPingOptions({
                        components: [
                            loadingCard
                        ],
                        flags:
                            MessageFlags.IsComponentsV2
                    })
                );

                await sendDailyReport(
                    message.guild
                );

                await performDailyReset(message.guild.id);

                const nowOptions = {
                    timeZone: "Asia/Kolkata",
                    hour12: false
                };

                const istDateString =
                    new Intl.DateTimeFormat(
                        "en-US",
                        {
                            ...nowOptions,
                            dateStyle: "short"
                        }
                    ).format(new Date());

                await saveLastReportDate(
                    istDateString
                );

                await saveLastResetDate(
                    istDateString
                );

                console.log(
                    `<:success_g:1561271843346714777> [ManualReset] Activity data force-reset by ${message.author.tag} at ${new Date().toISOString()} (marked as reset for ${istDateString} IST).`
                );

                const successCard =
                    createCard({
                        color:
                            COLORS.GREEN,

                        content:
                            "<:success_g:1561271843346714777> **Activity Tracking Reset**\nActivity tracking has been reset. Fresh tracking starts now."
                    });

                await message.channel.send(
                    noPingOptions({
                        components: [
                            successCard
                        ],
                        flags:
                            MessageFlags.IsComponentsV2
                    })
                );

                return;
            }

            if (
                commandName ===
                "removeuser"
            ) {
                const hasAdmin =
                    message.member.permissions.has(
                        "Administrator"
                    );

                const hasRole =
                    atlogsAllowed(message);

                if (
                    !hasAdmin &&
                    !hasRole
                ) {
                    const card =
                        createCard({
                            color:
                                COLORS.RED,

                            content:
                                "<:error_g:1561271715164721245> **Permission Denied**\nYou do not have permission to use this command."
                        });

                    return message.reply(
                        noPingOptions({
                            components: [
                                card
                            ],
                            flags:
                                MessageFlags.IsComponentsV2
                        })
                    );
                }

                const targetId = words.length === 1 ? extractSnowflake(words[0]) : null;

                if (!targetId) {
                    const card =
                        createCard({
                            color:
                                COLORS.RED,
                            content:
                                "<:error_g:1561271715164721245> **Invalid User ID**\nUsage: `" + parsed.prefix + "removeuser <userID>` — provide a valid Discord user ID or mention."
                        });

                    return message.reply(
                        noPingOptions({
                            components: [
                                card
                            ],
                            flags:
                                MessageFlags.IsComponentsV2
                        })
                    );
                }

                try {
                    await removeUserRecord(message.guild.id, targetId);

                    console.log(
                        `<:success_g:1561271843346714777> [RemoveUser] ${message.author.tag} removed activetime record for ${targetId}.`
                    );

                    const card =
                        createCard({
                            color:
                                COLORS.GREEN,
                            content:
                                `<:success_g:1561271843346714777> **Activity Record Removed**\nRemoved activetime record for \`${targetId}\`.`
                        });

                    return message.reply(
                        noPingOptions({
                            components: [
                                card
                            ],
                            flags:
                                MessageFlags.IsComponentsV2
                        })
                    );
                } catch (err) {
                    const card =
                        createCard({
                            color:
                                COLORS.RED,
                            content:
                                `<:error_g:1561271715164721245> **Removal Failed**\nFailed to remove the record for \`${targetId}\`. Check the logs.`
                        });

                    return message.reply(
                        noPingOptions({
                            components: [
                                card
                            ],
                            flags:
                                MessageFlags.IsComponentsV2
                        })
                    );
                }
            }

            if (
                commandName ===
                "activetime"
            ) {
                let targetMember = null;
                if (words.length === 0) {
                    targetMember = message.member;
                } else if (words.length === 1 && extractSnowflake(words[0])) {
                    const targetId = extractSnowflake(words[0]);
                    targetMember = message.guild.members.cache.get(targetId) || await message.guild.members.fetch(targetId).catch(() => null);
                } else {
                    const query = words.join(" ").trim().toLowerCase();
                    const members = [...message.guild.members.cache.values()];
                    const names = member => [member.user.username, member.user.globalName, member.displayName, member.nickname].filter(Boolean).map(value => value.toLowerCase());
                    const uniqueById = list => [...new Map(list.map(member => [member.id, member])).values()];
                    const exact = uniqueById(members.filter(member => names(member).some(name => name === query)));
                    const candidates = exact.length ? exact : uniqueById(members.filter(member => names(member).some(name => name.includes(query))));
                    if (candidates.length > 1) return message.reply(noPingOptions({ components: [createCard({ color: COLORS.RED, content: "That name matches multiple members. Please mention the exact member or use their user ID." })], flags: MessageFlags.IsComponentsV2 }));
                    targetMember = candidates.length === 1 ? candidates[0] : null;
                }
                if (!targetMember) return message.reply(noPingOptions({ components: [createCard({ color: COLORS.RED, content: "Could not find that member. Use an exact name, a mention, or a user ID." })], flags: MessageFlags.IsComponentsV2 }));
                if (
                    !isStaff(
                        targetMember
                    )
                ) {
                    const card =
                        createCard({
                            color:
                                COLORS.RED,
                            content:
                                "<:error_g:1561271715164721245> **Not a Staff Member**\nThat user is not a staff member or does not have the specified staff role."
                        });

                    return message.reply(
                        noPingOptions({
                            components: [
                                card
                            ],
                            flags:
                                MessageFlags.IsComponentsV2
                        })
                    );
                }

                const userId = trackKey(targetMember.guild.id, targetMember.id);

                const now =
                    Date.now();

                let totalActive =
                    dailyActiveTimes.get(
                        userId
                    ) || 0;

                if (
                    activeSessions.has(
                        userId
                    )
                ) {
                    totalActive +=
                        now -
                        activeSessions.get(
                            userId
                        );
                } else if (
                    targetMember.presence &&
                    targetMember.presence.status !==
                        "offline"
                ) {
                    activeSessions.set(
                        userId,
                        now
                    );
                }

                let totalVoice =
                    dailyVoiceTimes.get(
                        userId
                    ) || 0;

                if (
                    voiceSessions.has(
                        userId
                    )
                ) {
                    totalVoice +=
                        now -
                        voiceSessions.get(
                            userId
                        );
                } else if (
                    targetMember.voice &&
                    targetMember.voice.channel
                ) {
                    voiceSessions.set(
                        userId,
                        now
                    );
                }

                const messages =
                    dailyMessageCounts.get(
                        userId
                    ) || 0;

                const commands =
                    dailyCommandCounts.get(
                        userId
                    ) || 0;

                const status =
                    targetMember.presence
                        ? targetMember.presence.status
                        : "offline";

                let statusFormatted =
                    "<a:error:1532986765105696778> Offline";

                if (
                    status ===
                    "online"
                ) {
                    statusFormatted =
                        "<a:ONLINE:1532986890519711815> Online";
                } else if (
                    status ===
                    "idle"
                ) {
                    statusFormatted =
                        "<a:Moon:1532988257338527835> Idle";
                } else if (
                    status ===
                    "dnd"
                ) {
                    statusFormatted =
                        "<a:error:1532986765105696778> Do Not Disturb";
                }

                const card = createCard({
                    color: COLORS.SKY_BLUE,
                    content:
                        `## F.R.I.D.A.Y • Activity Tracker\n` +
                        `<:Shield_2:1532989398642327594> **${targetMember}**\n` +
                        `<a:Clock:1532990759371018372> Online: **${formatHM(totalActive)}**\n` +
                        `<a:voice:1532987137199440003> Voice: **${formatHM(totalVoice)}**\n` +
                        `<:Stats:1532990723408793661> Commands: **${commands}**\n` +
                        `<a:LP_Message:1532991009066324049> Messages: **${messages}**\n` +
                        `${statusFormatted}\n` +
                        `*F.R.I.D.A.Y • Activity Module*`,
                    avatarURL: getAvatarURL(targetMember),
                    avatarDescription: `${targetMember.user.username}'s avatar`
                });

                return message.reply(
                    noPingOptions({
                        components: [card],
                        flags: MessageFlags.IsComponentsV2
                    })
                );

                return message.reply(
                    noPingOptions({
                        components: [
                            card
                        ],
                        flags:
                            MessageFlags.IsComponentsV2
                    })
                );
            }
        }
    );
};

process.on("SIGINT", async () => {
    try {
        await saveTimesToFileWithQueue();
    } catch (error) {
        console.error("<:error_g:1561271715164721245> Error saving active times:", error);
    }
    process.exit(0);
});

process.on("SIGTERM", async () => {
    try {
        await saveTimesToFileWithQueue();
    } catch (error) {
        console.error("<:error_g:1561271715164721245> Error saving active times:", error);
    }
    process.exit(0);
});