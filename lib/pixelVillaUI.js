const {
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SectionBuilder,
    ThumbnailBuilder
} = require("discord.js");

/*
 * F.R.I.D.A.Y
 * Shared Components V2 UI
 *
 * Default: Orange (#ED7117)
 * Success: Green
 * Error: Red
 */

const COLORS = {
    ORANGE: 0xED7117,
    SKY_BLUE: 0xED7117,
    GREEN: 0x57F287,
    RED: 0xED4245
};

/**
 * Creates an F.R.I.D.A.Y Components V2 card.
 *
 * A native Discord separator is added beneath a leading Markdown heading and
 * immediately before a trailing Components V2 small-text footer (-# ...).
 * Content without a clear title/footer is left structurally unchanged.
 *
 * @param {Object} options
 * @param {number} options.color - Accent color
 * @param {string} options.content - Main card content
 * @param {string|null} options.avatarURL - User avatar URL
 * @param {string} options.avatarDescription - Avatar alt text
 * @param {boolean} options.separators - Add separators between explicit sections
 * @returns {ContainerBuilder}
 */
function createCard({
    color = COLORS.ORANGE,
    content = "",
    avatarURL = null,
    avatarDescription = "User avatar",
    separators = false
} = {}) {
    const container = new ContainerBuilder()
        .setAccentColor(color);

    const sections = String(content).split("\n---SEPARATOR---\n");
    let firstText = true;

    function addText(text) {
        if (!text || !text.trim()) return;

        const display = new TextDisplayBuilder().setContent(text);

        if (avatarURL && firstText) {
            const thumbnail = new ThumbnailBuilder()
                .setURL(avatarURL)
                .setDescription(avatarDescription);

            const sectionComponent = new SectionBuilder()
                .addTextDisplayComponents(display)
                .setThumbnailAccessory(thumbnail);

            container.addSectionComponents(sectionComponent);
        } else {
            container.addTextDisplayComponents(display);
        }

        firstText = false;
    }

    function addDivider() {
        container.addSeparatorComponents(new SeparatorBuilder());
    }

    sections.forEach((section, index) => {
        let remaining = section;

        // Only treat an explicit Markdown heading at the beginning as a title.
        const titleMatch = remaining.match(/^(\s*#{1,3}\s+[^\n]+)(\n[\s\S]*)?$/);
        if (titleMatch) {
            addText(titleMatch[1]);
            remaining = titleMatch[2] || "";

            if (remaining.trim()) {
                addDivider();
            }
        }

        // Discord's "-# " syntax renders small footer text. Keep it as text,
        // but visually separate it from the main card content with a native divider.
        const footerMatch = remaining.match(/([\s\S]*?)(\n?\s*-#\s+[^\n]+\s*)$/);
        if (footerMatch && footerMatch[1].trim()) {
            addText(footerMatch[1].replace(/\s+$/, ""));
            addDivider();
            addText(footerMatch[2].trim());
        } else {
            addText(remaining);
        }

        // Preserve the existing opt-in separator-marker behavior.
        if (separators && index < sections.length - 1) {
            addDivider();
        }
    });

    return container;
}

function getAvatarURL(user) {
    if (!user) return null;

    const target = user.user || user;

    if (!target || typeof target.displayAvatarURL !== "function") {
        return null;
    }

    return target.displayAvatarURL({
        extension: "png",
        size: 128
    });
}

function messageOptions(container) {
    return {
        components: [container],
        flags: 32768
    };
}

module.exports = {
    COLORS,
    createCard,
    getAvatarURL,
    messageOptions
};
