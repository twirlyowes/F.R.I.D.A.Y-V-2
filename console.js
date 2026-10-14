const { ChannelType } = require("discord.js");

// Optional: set CONSOLE_LOG_CHANNEL_ID (env) to mirror the bot's console into one
// Discord channel (bot-owner debugging). Leave unset to disable.
const LOG_CHANNEL_ID = process.env.CONSOLE_LOG_CHANNEL_ID || null;

let client = null;
let queue = [];
let sending = false;

const MAX_MESSAGE_LENGTH = 1900;

function formatValue(value) {
    if (typeof value === "string") {
        return value;
    }

    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}

function getTimestamp() {
    return new Date().toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        hour12: false
    });
}

async function sendToDiscord(type, args) {
    if (!client) return;

    const output = args
        .map(formatValue)
        .join(" ");

    if (!output.trim()) return;

    const message = `[${getTimestamp()}] [${type}] ${output}`;

    // Discord message limit protection
    for (let i = 0; i < message.length; i += MAX_MESSAGE_LENGTH) {
        queue.push(message.slice(i, i + MAX_MESSAGE_LENGTH));
    }

    processQueue();
}

async function processQueue() {
    if (!LOG_CHANNEL_ID) {
        queue = [];
        return;
    }

    if (sending || queue.length === 0 || !client) {
        return;
    }

    sending = true;

    try {
        const channel = await client.channels.fetch(LOG_CHANNEL_ID);

        if (!channel || channel.type !== ChannelType.GuildText) {
            process.stderr.write(
                "[Console Logger] Console log channel was not found or is not a text channel.\n"
            );

            queue = [];
            sending = false;
            return;
        }

        while (queue.length > 0) {
            const message = queue.shift();

            await channel.send({
                content: `\`\`\`ansi\n${message}\n\`\`\``
            });

            // Prevent excessive Discord API requests
            await new Promise(resolve => setTimeout(resolve, 250));
        }
    } catch (error) {
        // IMPORTANT:
        // Do not use console.error here because console.error
        // is being captured by this logger.
        process.stderr.write(
            `[Console Logger] Failed to send console message: ${error.message}\n`
        );
    }

    sending = false;

    if (queue.length > 0) {
        processQueue();
    }
}

function connect(discordClient) {
    client = discordClient;

    if (!client) {
        process.stderr.write(
            "[Console Logger] Discord client was not provided.\n"
        );
        return;
    }

    const originalLog = console.log;
    const originalInfo = console.info;
    const originalWarn = console.warn;
    const originalError = console.error;
    const originalDebug = console.debug;

    console.log = (...args) => {
        originalLog(...args);
        sendToDiscord("LOG", args);
    };

    console.info = (...args) => {
        originalInfo(...args);
        sendToDiscord("INFO", args);
    };

    console.warn = (...args) => {
        originalWarn(...args);
        sendToDiscord("WARN", args);
    };

    console.error = (...args) => {
        originalError(...args);
        sendToDiscord("ERROR", args);
    };

    console.debug = (...args) => {
        originalDebug(...args);
        sendToDiscord("DEBUG", args);
    };

    originalLog(
        "[Console Logger] Discord console logging enabled."
    );
}

module.exports = {
    connect
};
