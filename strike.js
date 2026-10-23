const { MessageFlags } = require("discord.js");
const admin = require("firebase-admin");
const guildConfig = require("./lib/guildConfig");
const { parseCommand } = require("./lib/prefix");
const { db } = require("./firebase");
const { makeRecorder } = require("./lib/dashboardEvents");
const dashboardEvents = makeRecorder(db);
const { COLORS, createCard, getAvatarURL } = require("./lib/pixelVillaUI");

/*
 * F.R.I.D.A.Y — Strike System
 *
 * Commands:
 *   <prefix>strike @user <reason>
 *   <prefix>strikes @user
 *   <prefix>unstrike @user <strike_id>
 *
 * Firestore:
 *   strikes/{autoId}
 *   strikeCounters/{guildId_userId}
 *
 * Strike numbers are kept COMPACT: removing a strike renumbers every
 * strike after it down by one, so the numbering never has gaps.
 *
 * Example:
 *   #1
 *   #2
 *   #3
 *
 * Remove #2:
 *   #1
 *   #2   (was #3)
 *
 * Next strike:
 *   #3
 *
 * If a user's last remaining strike is removed, their strike count
 * (and the next strike number) resets back to #1.
 */

// =============================================================
// COLORS
// =============================================================

const ERROR_RED = 0xE74C3C;
const STRIKE_ORANGE = 0xE67E22;

// =============================================================
// MODULE
// =============================================================

module.exports = client => {

    // =============================================================
    // CARD HELPERS
    // =============================================================

    function makeCard(color, title, text, avatarURL = null) {
        return createCard({
            color,
            content: `# ${title}\n\n${text}\n-# F.R.I.D.A.Y • Strike System`,
            avatarURL,
            avatarDescription: avatarURL
                ? "User avatar"
                : "F.R.I.D.A.Y"
        });
    }

    function cardReply(color, title, text, avatarURL = null) {
        return {
            components: [
                makeCard(color, title, text, avatarURL)
            ],
            flags: MessageFlags.IsComponentsV2
        };
    }

    // =============================================================
    // EXPLICIT MENTION CHECK
    // =============================================================
    //
    // Only accepts:
    //
    // +strike @User reason
    //
    // Replying to someone does NOT count as an explicit mention.
    //
    // =============================================================

    function getExplicitMentionedMember(message, args) {

        if (!args[0]) return null;

        const match = args[0].match(/^<@!?(\d+)>$/);

        if (!match) return null;

        return message.mentions.members.get(match[1]) || null;
    }

    // =============================================================
    // DATE FORMATTER
    // =============================================================

    function formatDate(date) {

        if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
            return "Unknown date";
        }

        const day = date.getDate();

        const month = date.toLocaleString("en-US", {
            month: "long"
        });

        const year = date.getFullYear();

        return `${day} ${month} ${year}`;
    }

    // =============================================================
    // STAFF LOG
    // =============================================================

    async function sendLog(message, options) {

        try {

            const logChannel = await guildConfig.getLogChannel(message.guild);

            if (!logChannel) return;

            await logChannel.send(options);

        } catch (err) {

            console.error(
                "Failed to fetch or send to staff log channel:",
                err
            );
        }
    }

    // =============================================================
    // PERMISSION CHECK
    // =============================================================

    async function hasPermission(message) {
        return guildConfig.isStaff(message.member);
    }

    // =============================================================
    // COMMAND LISTENER
    // =============================================================

    client.on("messageCreate", async message => {

        // Ignore bots and DMs
        if (message.author.bot || !message.guild) {
            return;
        }

        const parsed = await parseCommand(message);

        if (!parsed) return;

        const PREFIX = parsed.prefix;

        const COMMANDS = {
            strike: "strike",
            strikes: "strikes",
            unstrike: "unstrike",
            removestrike: "unstrike"
        };

        const command = COMMANDS[parsed.command];

        if (!command) return;

        const args = parsed.args;

        // =========================================================
        // PERMISSION CHECK
        // =========================================================

        if (!await hasPermission(message)) {

            return message.channel.send(
                cardReply(
                    ERROR_RED,
                    "<a:error:1532986765105696778> Permission Denied",
                    "You do not have permission to use this command."
                )
            );
        }

        try {

            // =====================================================
            // +strike
            // =====================================================

            if (command === "strike") {

                const user = getExplicitMentionedMember(
                    message,
                    args
                );

                // -------------------------------------------------
                // USER MENTION REQUIRED
                // -------------------------------------------------

                if (!user) {

                    return message.channel.send(
                        cardReply(
                            ERROR_RED,
                            "<a:error:1532986765105696778> Invalid Usage",
                            "You must **explicitly ping the user** you want to strike.\n\n" +
                            "**Usage:** `" + PREFIX + "strike @user <reason>`\n\n" +
                            "Replying to a message does **not** count — you must type the @mention."
                        )
                    );
                }

                // -------------------------------------------------
                // BOT CHECK
                // -------------------------------------------------

                if (user.user.bot) {

                    return message.channel.send(
                        cardReply(
                            ERROR_RED,
                            "<a:error:1532986765105696778> Invalid Target",
                            "Bots cannot receive strikes."
                        )
                    );
                }

                // -------------------------------------------------
                // SELF CHECK
                // -------------------------------------------------

                if (user.id === message.author.id) {

                    return message.channel.send(
                        cardReply(
                            ERROR_RED,
                            "<a:error:1532986765105696778> Invalid Target",
                            "You cannot give yourself a strike."
                        )
                    );
                }

                // -------------------------------------------------
                // REASON
                // -------------------------------------------------

                const reason = args
                    .slice(1)
                    .join(" ")
                    .trim();

                if (!reason) {

                    return message.channel.send(
                        cardReply(
                            ERROR_RED,
                            "<a:error:1532986765105696778> Invalid Usage",
                            "A reason is required.\n\n" +
                            "**Usage:** `" + PREFIX + "strike @user <reason>`"
                        )
                    );
                }

                // -------------------------------------------------
                // FIREBASE REFERENCES
                // -------------------------------------------------

                const guildId = message.guild.id;
                const userId = user.id;

                const counterRef = db
                    .collection("strikeCounters")
                    .doc(`${guildId}_${userId}`);

                const strikeRef = db
                    .collection("strikes")
                    .doc();

                // -------------------------------------------------
                // ATOMIC STRIKE NUMBER
                // -------------------------------------------------
                //
                // The transaction guarantees that two moderators
                // issuing a strike at nearly the same time cannot
                // accidentally receive the same strike number.
                //
                // The counter is kept in sync with the compacted
                // numbering by -strike (see below), so this always
                // hands out "count of active strikes + 1".
                //
                // -------------------------------------------------

                const strikeNumber = await db.runTransaction(
                    async transaction => {

                        const counterDoc =
                            await transaction.get(counterRef);

                        let nextNumber = 1;

                        if (counterDoc.exists) {

                            const storedNext =
                                counterDoc.data().nextNumber;

                            if (
                                Number.isInteger(storedNext) &&
                                storedNext > 0
                            ) {
                                nextNumber = storedNext;
                            }
                        }

                        transaction.set(
                            counterRef,
                            {
                                guildId,
                                userId,
                                nextNumber: nextNumber + 1
                            },
                            {
                                merge: true
                            }
                        );

                        transaction.set(
                            strikeRef,
                            {
                                guildId,
                                userId,
                                strikeNumber: nextNumber,
                                strikeId: String(nextNumber),
                                reason,
                                moderatorId: message.author.id,
                                createdAt:
                                    admin.firestore.FieldValue.serverTimestamp()
                            }
                        );

                        return nextNumber;
                    }
                );

                dashboardEvents.recordCase(message.guild.id, {
                    action: "strike",
                    targetId: user.id,
                    targetName: user.user.tag,
                    moderatorId: message.author.id,
                    moderatorName: message.author.tag,
                    reason,
                    sourceRecordId: strikeRef.id
                }).catch(error => console.error("[Dashboard Events] Strike case could not be recorded:", error.message));

                // -------------------------------------------------
                // RESPONSE
                // -------------------------------------------------

                const options = cardReply(
                    STRIKE_ORANGE,

                    `<a:Warning:1532986372716236932> Strike ${strikeNumber}/3 — ${user.user.username}`,

                    `<a:LP_Message:1532991009066324049> **Reason**\n` +
                    `${reason}\n\n` +

                    `<:Shield_2:1532989398642327594> **Strike ID**\n` +
                    `#${strikeNumber}\n\n` +

                    `<a:settings:1532990547394957393> **Moderator**\n` +
                    `${message.author}`,

                    getAvatarURL(user)
                );

                await message.channel.send(options);

                await sendLog(message, options);

                return;
            }

            // =====================================================
            // +strikes
            // =====================================================

            if (command === "strikes") {

                const user = getExplicitMentionedMember(
                    message,
                    args
                );

                // -------------------------------------------------
                // USER REQUIRED
                // -------------------------------------------------

                if (!user) {

                    return message.channel.send(
                        cardReply(
                            ERROR_RED,
                            "<a:error:1532986765105696778> Invalid Usage",
                            "You must **explicitly ping the user** you want to check.\n\n" +
                            "**Usage:** `" + PREFIX + "strikes @user`\n\n" +
                            "Replying to a message does **not** count — you must type the @mention."
                        )
                    );
                }

                // -------------------------------------------------
                // FETCH STRIKES
                // -------------------------------------------------
                //
                // Query by guild only and filter userId in JS.
                // This avoids depending on a Firestore composite
                // index for guildId + userId.
                //
                // -------------------------------------------------

                const snapshot = await db
                    .collection("strikes")
                    .where(
                        "guildId",
                        "==",
                        message.guild.id
                    )
                    .get();

                const strikes = snapshot.docs
                    .map(doc => ({
                        docId: doc.id,
                        ...doc.data()
                    }))
                    .filter(
                        strike =>
                            strike.userId === user.id
                    )
                    .sort(
                        (a, b) =>
                            Number(a.strikeNumber) -
                            Number(b.strikeNumber)
                    );

                // -------------------------------------------------
                // NO STRIKES
                // -------------------------------------------------

                if (strikes.length === 0) {

                    return message.channel.send(
                        cardReply(
                            COLORS.GREEN,
                            "<a:success:1532986625343099050> Clean Record",

                            `<:Shield_2:1532989398642327594> **User**\n` +
                            `${user}\n\n` +

                            `No active strikes found for ${user}.`,

                            getAvatarURL(user)
                        )
                    );
                }

                // -------------------------------------------------
                // BUILD HISTORY
                // -------------------------------------------------

                const historyBlocks = strikes
                    .map(strike => {

                        let createdDate;

                        if (
                            strike.createdAt &&
                            typeof strike.createdAt.toDate === "function"
                        ) {

                            createdDate =
                                strike.createdAt.toDate();

                        } else if (
                            strike.createdAt instanceof Date
                        ) {

                            createdDate =
                                strike.createdAt;

                        } else {

                            createdDate = null;
                        }

                        const dateText =
                            createdDate
                                ? formatDate(createdDate)
                                : "Unknown date";

                        return (

                            `**#${strike.strikeNumber}**\n\n` +

                            `<a:LP_Message:1532991009066324049> **Reason**\n` +
                            `${strike.reason || "No reason provided"}\n\n` +

                            `<:Shield_2:1532989398642327594> **Moderator**\n` +
                            `<@${strike.moderatorId}>\n\n` +

                            `<a:Clock:1532990759371018372> **Date**\n` +
                            `${dateText}`
                        );
                    })
                    .join("\n\n");

                // -------------------------------------------------
                // SEND HISTORY
                // -------------------------------------------------

                return message.channel.send(
                    cardReply(
                        STRIKE_ORANGE,

                        `<a:Warning:1532986372716236932> Strikes for ${user.user.username}`,

                        `<:Stats:1532990723408793661> **Active Strikes**\n` +
                        `${strikes.length}\n\n` +

                        historyBlocks,

                        getAvatarURL(user)
                    )
                );
            }

            // =====================================================
            // -strike
            // =====================================================

            if (command === "unstrike") {

                const user = getExplicitMentionedMember(
                    message,
                    args
                );

                // -------------------------------------------------
                // USER REQUIRED
                // -------------------------------------------------

                if (!user) {

                    return message.channel.send(
                        cardReply(
                            ERROR_RED,
                            "<a:error:1532986765105696778> Invalid Usage",
                            "**Usage:** `" + PREFIX + "unstrike @user <strike_id>`\n\n" +
                            "Replying to a message does **not** count — you must type the @mention."
                        )
                    );
                }

                // -------------------------------------------------
                // STRIKE ID
                // -------------------------------------------------
                //
                // IMPORTANT:
                // Only args[1] is accepted.
                //
                // This prevents:
                //
                // -strike @user something 2 random
                //
                // from accidentally deleting Strike #2.
                //
                // -------------------------------------------------

                const strikeIdArg = args[1];

                if (
                    !strikeIdArg ||
                    !/^\d+$/.test(strikeIdArg)
                ) {

                    return message.channel.send(
                        cardReply(
                            ERROR_RED,
                            "<a:error:1532986765105696778> Invalid Usage",
                            "A valid strike ID is required.\n\n" +
                            "**Usage:** `" + PREFIX + "unstrike @user <strike_id>`\n\n" +
                            "**Example:** `" + PREFIX + "unstrike @user 2`"
                        )
                    );
                }

                const strikeNumber =
                    Number(strikeIdArg);

                if (
                    !Number.isSafeInteger(strikeNumber) ||
                    strikeNumber <= 0
                ) {

                    return message.channel.send(
                        cardReply(
                            ERROR_RED,
                            "<a:error:1532986765105696778> Invalid Strike ID",
                            "The strike ID must be a positive number."
                        )
                    );
                }

                // -------------------------------------------------
                // FETCH ALL OF THIS USER'S STRIKES
                // -------------------------------------------------
                //
                // Query by guild only and filter userId in JS, same
                // as +strikes, to avoid needing a composite index.
                // We need every strike (not just the target) because
                // removal renumbers everything that comes after it.
                //
                // -------------------------------------------------

                const snapshot = await db
                    .collection("strikes")
                    .where(
                        "guildId",
                        "==",
                        message.guild.id
                    )
                    .get();

                const userStrikes = snapshot.docs
                    .filter(
                        doc => doc.data().userId === user.id
                    )
                    .map(doc => ({
                        ref: doc.ref,
                        ...doc.data()
                    }))
                    .sort(
                        (a, b) =>
                            Number(a.strikeNumber) -
                            Number(b.strikeNumber)
                    );

                const target = userStrikes.find(
                    strike =>
                        Number(strike.strikeNumber) ===
                        strikeNumber
                );

                // -------------------------------------------------
                // NOT FOUND
                // -------------------------------------------------

                if (!target) {

                    return message.channel.send(
                        cardReply(
                            ERROR_RED,
                            "<a:error:1532986765105696778> Strike Not Found",
                            `Strike #${strikeNumber} was not found for ${user}.`
                        )
                    );
                }

                const removed = target;

                // -------------------------------------------------
                // DELETE + RENUMBER (COMPACT)
                // -------------------------------------------------
                //
                // Every strike that came after the removed one moves
                // down by one, so numbering never has a gap. If this
                // was the user's last strike, the counter resets so
                // their next strike starts back at #1.
                //
                // -------------------------------------------------

                const remaining = userStrikes.filter(
                    strike => strike.ref.id !== target.ref.id
                );

                const batch = db.batch();

                batch.delete(target.ref);

                remaining.forEach((strike, index) => {

                    const newNumber = index + 1;

                    if (Number(strike.strikeNumber) !== newNumber) {

                        batch.update(strike.ref, {
                            strikeNumber: newNumber,
                            strikeId: String(newNumber)
                        });
                    }
                });

                const counterRef = db
                    .collection("strikeCounters")
                    .doc(`${message.guild.id}_${user.id}`);

                batch.set(
                    counterRef,
                    {
                        guildId: message.guild.id,
                        userId: user.id,
                        nextNumber: remaining.length + 1
                    },
                    {
                        merge: true
                    }
                );

                await batch.commit();

                // -------------------------------------------------
                // RESPONSE
                // -------------------------------------------------

                const options = cardReply(
                    COLORS.GREEN,

                    "<a:success:1532986625343099050> Strike Removed",

                    `<:Shield_2:1532989398642327594> **User**\n` +
                    `${user}\n\n` +

                    `<a:Warning:1532986372716236932> **Removed Strike**\n` +
                    `#${removed.strikeNumber}\n\n` +

                    `<a:LP_Message:1532991009066324049> **Reason**\n` +
                    `${removed.reason || "No reason provided"}\n\n` +

                    `<a:settings:1532990547394957393> **Removed By**\n` +
                    `${message.author}\n\n` +

                    `<a:sparkles:1532986077651140620> ` +
                    (
                        remaining.length === 0
                            ? "That was their last strike — numbering has reset, so their next strike will be #1."
                            : "Remaining strikes have been renumbered so there are no gaps."
                    ),

                    getAvatarURL(user)
                );

                await message.channel.send(options);

                await sendLog(message, options);

                return;
            }

        } catch (error) {

            console.error(
                "Error executing strike system:",
                error
            );

            return message.channel
                .send(
                    cardReply(
                        ERROR_RED,
                        "<a:error:1532986765105696778> Error",
                        "An error occurred inside the strike system. Please try again."
                    )
                )
                .catch(() => {});
        }
    });
};
