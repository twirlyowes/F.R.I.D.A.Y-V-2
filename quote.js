const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');
const {
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  PermissionFlagsBits,
} = require('discord.js');
const { parseCommand, getPrefix } = require('./lib/prefix');
const fs = require('fs');
const path = require('path');

const COOLDOWN_MS = 5000;
const STATE_TTL_MS = 60 * 60 * 1000;
const MAX_CHARS = 400;

const W = 1200;
const H = 630;

const FONT_DIR = path.join(__dirname, 'fonts');

const FONT_DEFS = {
  mplus: {
    label: 'M PLUS Rounded 1c (mplus)',
    family: 'PV MPLUS Rounded',
    files: [
      'MPLUSRounded1c-Regular.ttf',
      'MPLUSRounded1c-Bold.ttf',
    ],
  },

  dmserif: {
    label: 'DM Serif Display (dmserif)',
    family: 'PV DM Serif',
    files: [
      'DMSerifDisplay-Regular.ttf',
    ],
  },

  spacemono: {
    label: 'Space Mono (spacemono)',
    family: 'PV Space Mono',
    files: [
      'SpaceMono-Regular.ttf',
      'SpaceMono-Bold.ttf',
    ],
  },

  pacifico: {
    label: 'Pacifico (pacifico)',
    family: 'PV Pacifico',
    files: [
      'Pacifico-Regular.ttf',
    ],
  },

  bebas: {
    label: 'Bebas Neue (bebas)',
    family: 'PV Bebas Neue',
    files: [
      'BebasNeue-Regular.ttf',
    ],
  },
};

const availableFonts = [];

for (const [key, def] of Object.entries(FONT_DEFS)) {
  const found = def.files.filter((file) =>
    fs.existsSync(path.join(FONT_DIR, file))
  );

  if (!found.length) continue;

  for (const file of found) {
    GlobalFonts.registerFromPath(
      path.join(FONT_DIR, file),
      def.family
    );
  }

  availableFonts.push(key);
}

if (!availableFonts.length) {
  FONT_DEFS.system = {
    label: 'System (system)',
    family: 'sans-serif',
    files: [],
  };

  availableFonts.push('system');
}

const DEFAULT_FONT = availableFonts[0];

const THEMES = {
  bw: {
    label: 'Black/White (default)',
    emoji: '⬛',
    bg: '#000000',
    fg: '#ffffff',
  },

  wb: {
    label: 'White/Black',
    emoji: '⬜',
    bg: '#ffffff',
    fg: '#000000',
  },

  midnight: {
    label: 'Midnight/Ice',
    emoji: '🟦',
    bg: '#0b1020',
    fg: '#e8ecff',
  },

  cream: {
    label: 'Cream/Charcoal',
    emoji: '🟫',
    bg: '#f5efe0',
    fg: '#2b2b2b',
  },

  rose: {
    label: 'Wine/Rose',
    emoji: '🟥',
    bg: '#1a0b12',
    fg: '#ffd6e7',
  },

  forest: {
    label: 'Forest/Mint',
    emoji: '🟩',
    bg: '#08150d',
    fg: '#d5ffe0',
  },

  grape: {
    label: 'Grape/White',
    emoji: '🟪',
    bg: '#1e1740',
    fg: '#ffffff',
  },
};

const BRIGHTNESS = [1, 0.65, 1.35];

const hexToRgb = (hex) =>
  [1, 3, 5].map((i) =>
    parseInt(hex.slice(i, i + 2), 16)
  );

const cooldowns = new Map();
const states = new Map();

/* ----------------------------- */
/* TEXT HELPERS                   */
/* ----------------------------- */

function wrapLines(ctx, text, maxWidth) {
  const lines = [];

  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);

    let line = '';

    for (const word of words) {
      const test = line
        ? `${line} ${word}`
        : word;

      if (
        ctx.measureText(test).width > maxWidth &&
        line
      ) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    }

    lines.push(line);
  }

  return lines.length ? lines : [''];
}

function fontStr({
  italic,
  bold,
  size,
  family,
}) {
  return `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${size}px "${family}", sans-serif`;
}

/* ----------------------------- */
/* CANVAS RENDERING               */
/* ----------------------------- */

async function render(state, botName) {
  const theme =
    THEMES[state.themeKey] ||
    THEMES.bw;

  const family =
    (FONT_DEFS[state.fontKey] ||
      FONT_DEFS[DEFAULT_FONT]).family;

  const bg = hexToRgb(theme.bg);
  const fg = hexToRgb(theme.fg);

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  /* Background */
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, W, H);

  /* Avatar position */
  const ax = state.flip
    ? W - H
    : 0;

  const av = state.avatar;

  const scale = Math.max(
    H / av.width,
    H / av.height
  );

  const dw = av.width * scale;
  const dh = av.height * scale;

  const tmp = createCanvas(H, H);
  const tctx = tmp.getContext('2d');

  tctx.drawImage(
    av,
    (H - dw) / 2,
    (H - dh) / 2,
    dw,
    dh
  );

  /* Brightness / grayscale */
  const bright =
    BRIGHTNESS[
      state.brightness % BRIGHTNESS.length
    ];

  if (!state.color || bright !== 1) {
    const img = tctx.getImageData(
      0,
      0,
      H,
      H
    );

    const px = img.data;

    for (let i = 0; i < px.length; i += 4) {
      let r = px[i];
      let g = px[i + 1];
      let b = px[i + 2];

      if (!state.color) {
        const gray =
          r * 0.299 +
          g * 0.587 +
          b * 0.114;

        r = gray;
        g = gray;
        b = gray;
      }

      px[i] =
        Math.min(255, r * bright);

      px[i + 1] =
        Math.min(255, g * bright);

      px[i + 2] =
        Math.min(255, b * bright);
    }

    tctx.putImageData(img, 0, 0);
  }

  ctx.drawImage(
    tmp,
    ax,
    0
  );

  /* Gradient */
  const bgStr = bg.join(',');
  const fgStr = fg.join(',');

  const fadeFrom =
    state.flip
      ? W - H * 0.4
      : H * 0.4;

  const fadeTo =
    state.flip
      ? W - H * 0.9
      : H * 0.9;

  const fade =
    ctx.createLinearGradient(
      fadeFrom,
      0,
      fadeTo,
      0
    );

  fade.addColorStop(
    0,
    `rgba(${bgStr},0)`
  );

  fade.addColorStop(
    1,
    `rgba(${bgStr},1)`
  );

  ctx.fillStyle = fade;

  ctx.fillRect(
    ax,
    0,
    H,
    H
  );

  /* Text */
  const cx =
    state.flip
      ? W * 0.28
      : W * 0.715;

  const boxW = 520;
  const maxTextH = 290;

  let size = 58;
  let lines;
  let lineH;

  do {
    ctx.font = fontStr({
      italic: state.italic,
      bold: state.bold,
      size,
      family,
    });

    lines = wrapLines(
      ctx,
      state.text,
      boxW
    );

    lineH = size * 1.2;

    if (
      lines.length * lineH <=
      maxTextH
    ) {
      break;
    }

    size -= 2;
  } while (size >= 20);

  const quoteH =
    lines.length * lineH;

  const authorH = 30;
  const handleH = 22;

  const gap1 = 22;
  const gap2 = 4;

  const y0 =
    H * 0.5 -
    (
      quoteH +
      gap1 +
      authorH +
      gap2 +
      handleH
    ) / 2 +
    8;

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  ctx.fillStyle =
    theme.fg;

  ctx.font = fontStr({
    italic: state.italic,
    bold: state.bold,
    size,
    family,
  });

  lines.forEach((line, i) => {
    ctx.fillText(
      line,
      cx,
      y0 + i * lineH
    );
  });

  /* Author */
  ctx.font = fontStr({
    italic: true,
    bold: false,
    size: 25,
    family,
  });

  ctx.letterSpacing = '2px';

  ctx.fillText(
    `- ${state.displayName.toUpperCase()}`,
    cx,
    y0 + quoteH + gap1
  );

  ctx.letterSpacing = '0px';

  /* Username */
  ctx.fillStyle =
    `rgba(${fgStr},0.62)`;

  ctx.font = fontStr({
    italic: false,
    bold: false,
    size: 20,
    family,
  });

  ctx.fillText(
    `@${state.username}`,
    cx,
    y0 +
      quoteH +
      gap1 +
      authorH +
      gap2
  );

  /* Bot name */
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';

  ctx.fillStyle =
    `rgba(${fgStr},0.55)`;

  ctx.font = fontStr({
    italic: false,
    bold: false,
    size: 22,
    family,
  });

  ctx.fillText(
    botName,
    W - 18,
    H - 16
  );

  return canvas;
}

/* ----------------------------- */
/* IMAGE ENCODING                 */
/* ----------------------------- */

function encode(canvas, format) {
  /*
   * PNG
   *
   * Leave PNG generation exactly as before.
   */
  if (format !== 'gif') {
    return canvas.toBuffer('image/png');
  }

  /*
   * GIF
   *
   * Discord/mobile clients can be less forgiving with
   * single-frame GIFs. Instead of writing only one frame,
   * we create a tiny two-frame looping GIF.
   *
   * Both frames contain the same image, so visually it
   * remains exactly the same quote.
   */

  const ctx = canvas.getContext('2d');

  const imageData =
    ctx.getImageData(
      0,
      0,
      W,
      H
    );

  const { data } = imageData;

  /*
   * Generate a proper 256-color palette.
   */
  const palette =
    quantize(data, 256);

  /*
   * Convert RGBA pixels to indexed
   * GIF palette pixels.
   */
  const index =
    applyPalette(
      data,
      palette
    );

  const gif =
    GIFEncoder();

  /*
   * Frame 1
   *
   * delay is specified explicitly.
   * repeat: 0 means loop forever.
   */
  gif.writeFrame(
    index,
    W,
    H,
    {
      palette,
      delay: 100,
      repeat: 0,
    }
  );

  /*
   * Frame 2
   *
   * Identical to frame 1.
   * This makes the file a proper animated
   * looping GIF rather than a single-frame GIF.
   */
  gif.writeFrame(
    index,
    W,
    H,
    {
      palette,
      delay: 100,
    }
  );

  gif.finish();

  return Buffer.from(
    gif.bytes()
  );
}

/* ----------------------------- */
/* DISCORD COMPONENTS             */
/* ----------------------------- */

function buildComponents(state) {
  const row1 =
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('quote:brightness')
        .setEmoji('☀️')
        .setStyle(
          ButtonStyle.Secondary
        ),

      new ButtonBuilder()
        .setCustomId('quote:color')
        .setEmoji('🎨')
        .setStyle(
          state.color
            ? ButtonStyle.Primary
            : ButtonStyle.Secondary
        ),

      new ButtonBuilder()
        .setCustomId('quote:flip')
        .setEmoji('🔄')
        .setStyle(
          state.flip
            ? ButtonStyle.Primary
            : ButtonStyle.Secondary
        ),

      new ButtonBuilder()
        .setCustomId('quote:bold')
        .setLabel('B')
        .setStyle(
          state.bold
            ? ButtonStyle.Primary
            : ButtonStyle.Secondary
        ),

      new ButtonBuilder()
        .setCustomId('quote:italic')
        .setEmoji('🆕')
        .setStyle(
          state.italic
            ? ButtonStyle.Primary
            : ButtonStyle.Secondary
        )
    );

  const row2 =
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('quote:font')
        .setPlaceholder('Font')
        .addOptions(
          availableFonts.map(
            (key) => ({
              label:
                FONT_DEFS[key].label,
              value: key,
              default:
                state.fontKey === key,
            })
          )
        )
    );

  const row3 =
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('quote:theme')
        .setPlaceholder('Theme')
        .addOptions(
          Object.entries(THEMES).map(
            ([key, theme]) => ({
              label: theme.label,
              value: key,
              emoji: theme.emoji,
              default:
                state.themeKey === key,
            })
          )
        )
    );

  const row4 =
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('quote:remove')
        .setLabel('Remove my Quote')
        .setEmoji('🗑️')
        .setStyle(
          ButtonStyle.Danger
        ),

      new ButtonBuilder()
        .setCustomId('quote:format')
        .setLabel(
          state.format === 'gif'
            ? 'to PNG'
            : 'to GIF'
        )
        .setEmoji('🖼️')
        .setStyle(
          ButtonStyle.Secondary
        )
    );

  return [
    row1,
    row2,
    row3,
    row4,
  ];
}

/* ----------------------------- */
/* PAYLOAD                         */
/* ----------------------------- */

async function buildPayload(
  state,
  botName
) {
  const canvas =
    await render(
      state,
      botName
    );

  const isGif =
    state.format === 'gif';

  const name =
    isGif
      ? 'quote.gif'
      : 'quote.png';

  const buffer =
    encode(
      canvas,
      state.format
    );

  /*
   * Keep the attachment filename explicitly
   * matched to the actual image format.
   *
   * Discord.js v14 uses the filename to identify
   * the attachment format.
   */
  const attachment =
    new AttachmentBuilder(
      buffer,
      {
        name,
      }
    );

  return {
    files: [
      attachment,
    ],

    components:
      buildComponents(state),
  };
}

/* ----------------------------- */
/* COMMAND                         */
/* ----------------------------- */

module.exports = (client) => {
  const botName = () =>
    client.user?.username ||
    'F.R.I.D.A.Y';

  /*
   * Clean expired quote states.
   */
  setInterval(
    () => {
      const now =
        Date.now();

      for (
        const [
          id,
          state,
        ] of states
      ) {
        if (
          now -
            state.createdAt >
          STATE_TTL_MS
        ) {
          states.delete(id);
        }
      }
    },
    10 * 60 * 1000
  ).unref();

  /* ----------------------------- */
  /* .quote                         */
  /* ----------------------------- */

  client.on(
    'messageCreate',
    async (message) => {
      try {
        if (
          message.author.bot ||
          !message.guild
        ) {
          return;
        }

        const parsed = await parseCommand(message);

        if (
          !parsed ||
          parsed.command !== 'quote'
        ) {
          return;
        }

        if (parsed.args.length > 0) {
          return message.reply({ content: 'Usage: ' + parsed.prefix + 'quote (reply to a message; no extra arguments).', allowedMentions: { repliedUser: false } });
        }

        if (
          !message.reference?.messageId
        ) {
          return message.reply({
            content:
              `Reply to a message with \`${parsed.prefix}quote\` to quote it.`,
            allowedMentions: {
              repliedUser: false,
            },
          });
        }

        const last =
          cooldowns.get(
            message.author.id
          ) || 0;

        if (
          Date.now() - last <
          COOLDOWN_MS
        ) {
          return;
        }

        cooldowns.set(
          message.author.id,
          Date.now()
        );

        const target =
          await message.channel.messages
            .fetch(
              message.reference.messageId
            )
            .catch(() => null);

        if (!target) {
          return;
        }

        const text =
          (
            target.cleanContent ||
            ''
          )
            .replace(
              /<a?:(\w+):\d+>/g,
              ':$1:'
            )
            .trim();

        if (!text) {
          return message.reply({
            content:
              'That message has no text to quote.',
            allowedMentions: {
              repliedUser: false,
            },
          });
        }

        const member =
          await message.guild.members
            .fetch(
              target.author.id
            )
            .catch(() => null);

        const displayName =
          member?.displayName ||
          target.author.globalName ||
          target.author.username;

        const avatarURL =
          (
            member ||
            target.author
          ).displayAvatarURL({
            extension: 'png',
            size: 1024,
            forceStatic: true,
          });

        const state = {
          text:
            text.slice(
              0,
              MAX_CHARS
            ),

          displayName,

          username:
            target.author.username,

          avatar:
            await loadImage(
              avatarURL
            ),

          themeKey:
            'bw',

          fontKey:
            DEFAULT_FONT,

          color:
            false,

          flip:
            false,

          bold:
            false,

          italic:
            false,

          brightness:
            0,

          format:
            'png',

          requesterId:
            message.author.id,

          createdAt:
            Date.now(),
        };

        const sent =
          await message.reply({
            ...await buildPayload(
              state,
              botName()
            ),

            allowedMentions: {
              repliedUser: false,
            },
          });

        states.set(
          sent.id,
          state
        );

      } catch (err) {
        console.error(
          '[quote] failed:',
          err
        );
      }
    }
  );

  /* ----------------------------- */
  /* BUTTONS / MENUS                */
  /* ----------------------------- */

  client.on(
    'interactionCreate',
    async (interaction) => {
      try {
        if (
          !interaction.isButton() &&
          !interaction.isStringSelectMenu()
        ) {
          return;
        }

        if (
          !interaction.customId.startsWith(
            'quote:'
          )
        ) {
          return;
        }

        const state =
          states.get(
            interaction.message.id
          );

        if (!state) {
          const hintPrefix = await getPrefix(interaction.guildId);

          return interaction.reply({
            content:
              `This quote has expired, so make a new one with \`${hintPrefix}quote\`.`,
            ephemeral: true,
          });
        }

        const canEdit =
          interaction.user.id ===
            state.requesterId ||
          interaction.memberPermissions?.has(
            PermissionFlagsBits.ManageMessages
          );

        if (!canEdit) {
          return interaction.reply({
            content:
              'Only the person who made this quote can edit it.',
            ephemeral: true,
          });
        }

        const action =
          interaction.customId.split(
            ':'
          )[1];

        /* Remove quote */
        if (
          action === 'remove'
        ) {
          states.delete(
            interaction.message.id
          );

          await interaction.message
            .delete()
            .catch(() => {});

          return interaction
            .deferUpdate()
            .catch(() => {});
        }

        /* Brightness */
        if (
          action === 'brightness'
        ) {
          state.brightness =
            (
              state.brightness +
              1
            ) %
            BRIGHTNESS.length;
        }

        /* Color */
        else if (
          action === 'color'
        ) {
          state.color =
            !state.color;
        }

        /* Flip */
        else if (
          action === 'flip'
        ) {
          state.flip =
            !state.flip;
        }

        /* Bold */
        else if (
          action === 'bold'
        ) {
          state.bold =
            !state.bold;
        }

        /* Italic */
        else if (
          action === 'italic'
        ) {
          state.italic =
            !state.italic;
        }

        /* PNG/GIF */
        else if (
          action === 'format'
        ) {
          state.format =
            state.format === 'gif'
              ? 'png'
              : 'gif';
        }

        /* Font */
        else if (
          action === 'font' &&
          FONT_DEFS[
            interaction.values[0]
          ]
        ) {
          state.fontKey =
            interaction.values[0];
        }

        /* Theme */
        else if (
          action === 'theme' &&
          THEMES[
            interaction.values[0]
          ]
        ) {
          state.themeKey =
            interaction.values[0];
        }

        await interaction.deferUpdate();

        await interaction.editReply({
          ...await buildPayload(
            state,
            botName()
          ),

          /*
           * Remove the previous attachment
           * before replacing it.
           */
          attachments: [],
        });

      } catch (err) {
        console.error(
          '[quote] interaction failed:',
          err
        );
      }
    }
  );
};

/* ----------------------------- */
/* TEST EXPORTS                   */
/* ----------------------------- */

module.exports._test = {
  render,
  encode,
  availableFonts,
  THEMES,
  W,
  H,
};
