const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, MessageFlags,
  PermissionFlagsBits, StringSelectMenuBuilder
} = require("discord.js");
const { db } = require("./firebase");
const guildConfig = require("./lib/guildConfig");
const { createCard, COLORS } = require("./lib/pixelVillaUI");
const { parseCommand } = require("./lib/prefix");

const SELECT_ID = "friday-modmail-select";
const pendingMessages = new Map();
const PENDING_TTL = 10 * 60 * 1000;
const ALLOW_USER = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks];
const ID = /^\d{17,20}$/;

function safeMentions(options = {}) { return { ...options, allowedMentions: { parse: [] } }; }
function cleanName(value) {
  return (String(value || "member").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "member").slice(0, 42);
}
function makeCard(guild, title, content, color = COLORS.SKY_BLUE) {
  return createCard({
    color,
    content: "# " + title + "\n\n" + content + "\n\n-# F.R.I.D.A.Y • ModMail",
    avatarURL: guild?.client?.user?.displayAvatarURL({ extension: "png", size: 128 }),
    avatarDescription: "F.R.I.D.A.Y"
  });
}
function contentOf(message) {
  return [String(message.content || "").trim(), ...[...message.attachments.values()].map(a => a.url)].filter(Boolean).join("\n").slice(0, 2000);
}
function attachmentsOf(message) {
  return [...message.attachments.values()].slice(0, 10).map(a => ({
    name: String(a.name || "attachment").slice(0, 200),
    url: String(a.url || "").slice(0, 2000),
    contentType: String(a.contentType || "").slice(0, 100)
  }));
}
function threadRef(guildId, threadId) {
  return db.collection("modmail_threads").doc(guildId).collection("threads").doc(threadId);
}
async function saveMessage(ref, message) {
  await ref.collection("messages").doc().set({ ...message, createdAt: Date.now() });
  await ref.set({ lastActivityAt: Date.now(), lastMessagePreview: String(message.content || "").slice(0, 180) }, { merge: true });
}
async function sendLogs(guild, cfg, text) {
  const channel = cfg.ticketLogs ? await guildConfig.resolveChannel(guild, cfg.ticketLogs) : null;
  if (channel?.isTextBased?.()) {
    await channel.send(safeMentions({ components: [makeCard(guild, "ModMail Activity", text)], flags: MessageFlags.IsComponentsV2 })).catch(err => console.warn("[ModMail] Log send failed:", err.message));
  }
}
async function availableGuilds(userId, client) {
  const found = [];
  for (const guild of client.guilds.cache.values()) {
    if (found.length >= 25) break;
    let cfg;
    try { cfg = await guildConfig.get(guild.id); } catch (err) { console.warn("[ModMail] Config read failed:", err.message); continue; }
    if (!cfg.ticketCategory || !cfg.supportRole) continue;
    let member = guild.members.cache.get(userId);
    if (!member) member = await guild.members.fetch(userId).catch(() => null);
    if (!member || member.user?.bot) continue;
    const category = await guildConfig.resolveChannel(guild, cfg.ticketCategory);
    const role = guild.roles.cache.get(cfg.supportRole) || await guild.roles.fetch(cfg.supportRole).catch(() => null);
    if (!category || category.type !== ChannelType.GuildCategory || !role || role.managed) continue;
    found.push({ guild, cfg });
  }
  return found;
}
async function showPicker(user, client, prompt) {
  const options = await availableGuilds(user.id, client);
  if (!options.length) {
    return user.send(safeMentions({
      components: [makeCard(null, "ModMail unavailable", "No server was found where you're a member and FRIDAY has a valid ModMail category and Support Role. Ask a server administrator to configure ticketCategory and supportRole.")],
      flags: MessageFlags.IsComponentsV2
    })).catch(() => {});
  }
  const menu = new StringSelectMenuBuilder().setCustomId(SELECT_ID).setPlaceholder("Choose the Discord server").setMinValues(1).setMaxValues(1)
    .addOptions(options.map(({ guild }) => ({ label: guild.name.slice(0, 100), description: "Open or continue a private support conversation", value: guild.id })));
  await user.send(safeMentions({
    components: [makeCard(null, "F.R.I.D.A.Y ModMail", (prompt || "Choose a server for your support request.") + "\n\nOnly servers where you're a member and ModMail is configured are shown."),
      new ActionRowBuilder().addComponents(menu)],
    flags: MessageFlags.IsComponentsV2
  })).catch(err => console.warn("[ModMail] Could not DM picker:", err.message));
}
async function sendTicketMessage(channel, author, content) {
  const text = "**" + String(author.tag || author.username || "Member").slice(0, 100) + "** · " + author.id + "\n" + String(content || "(attachment)").slice(0, 1800);
  return channel.send(safeMentions({ components: [makeCard(channel.guild, "ModMail Message", text)], flags: MessageFlags.IsComponentsV2 }));
}
async function relayDm(guild, user, thread, ticket, input) {
  const content = String(input.content || "").trim();
  const attachments = input.attachments || [];
  const combined = [content, ...attachments.map(a => a.url)].filter(Boolean).join("\n").slice(0, 2000);
  if (!combined) return;
  await sendTicketMessage(ticket, user, combined);
  await saveMessage(threadRef(guild.id, user.id), {
    authorId: user.id, authorName: user.globalName || user.username,
    authorType: "user", content: combined, attachments, source: "dm"
  });
}
async function startTicket(guild, user, cfg, initial = null) {
  const ref = threadRef(guild.id, user.id);
  const current = await ref.get();
  if (current.exists && current.data()?.status === "open") {
    const old = current.data();
    const channel = old.ticketChannelId ? await guild.channels.fetch(old.ticketChannelId).catch(() => null) : null;
    if (channel) {
      await db.collection("modmail_dm_sessions").doc(user.id).set({ guildId: guild.id, threadId: user.id, updatedAt: Date.now() });
      if (initial) await relayDm(guild, user, old, channel, initial);
      await user.send(safeMentions({ components: [makeCard(guild, "Ticket already open", "Your ticket in " + guild.name + " is already open. Send another DM to continue the conversation.")], flags: MessageFlags.IsComponentsV2 })).catch(() => {});
      return;
    }
  }

  const category = await guildConfig.resolveChannel(guild, cfg.ticketCategory);
  const support = guild.roles.cache.get(cfg.supportRole) || await guild.roles.fetch(cfg.supportRole).catch(() => null);
  if (!category || category.type !== ChannelType.GuildCategory) throw new Error("The configured ModMail category no longer exists.");
  if (!support || support.managed) throw new Error("The configured Support Role no longer exists or cannot be used.");
  const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
  if (!me?.permissions.has(PermissionFlagsBits.ManageChannels) || !me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    throw new Error("FRIDAY needs Manage Channels and Manage Roles to create private tickets.");
  }
  const ticket = await guild.channels.create({
    name: "ticket-" + cleanName(user.username) + "-" + user.id.slice(-4),
    type: ChannelType.GuildText,
    parent: category.id,
    topic: "F.R.I.D.A.Y ModMail · user " + user.id,
    permissionOverwrites: [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: user.id, allow: ALLOW_USER },
      { id: support.id, allow: ALLOW_USER }
    ],
    reason: "F.R.I.D.A.Y ModMail ticket for " + user.id
  });

  try {
    const data = {
      id: user.id, threadId: user.id, guildId: guild.id, guildName: guild.name,
      userId: user.id, userName: user.globalName || user.username, status: "open",
      ticketChannelId: ticket.id, createdAt: Date.now(), lastActivityAt: Date.now(),
      lastMessagePreview: String(initial?.content || "Support ticket opened").slice(0, 180)
    };
    await ref.set(data);
    await db.collection("modmail_ticket_channels").doc(ticket.id).set({ guildId: guild.id, userId: user.id, threadId: user.id, createdAt: Date.now() });
    await db.collection("modmail_dm_sessions").doc(user.id).set({ guildId: guild.id, threadId: user.id, updatedAt: Date.now() });
    await ticket.send(safeMentions({
      components: [
        makeCard(guild, "New ModMail Ticket", "Member: " + user.tag + " (" + user.id + ")\nServer: " + guild.name + "\n\nA private ticket was opened from the member's DMs."),
        new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("friday-modmail-close:" + guild.id + ":" + user.id).setLabel("Close Ticket").setStyle(ButtonStyle.Danger))
      ],
      flags: MessageFlags.IsComponentsV2
    }));
    if (initial) await relayDm(guild, user, data, ticket, initial);
    await sendLogs(guild, cfg, "Opened a ticket for " + user.tag + " (" + user.id + "): " + ticket.name + ".");
  } catch (err) {
    await ticket.delete("F.R.I.D.A.Y ModMail setup failed").catch(() => {});
    await ref.delete().catch(() => {});
    await db.collection("modmail_ticket_channels").doc(ticket.id).delete().catch(() => {});
    await db.collection("modmail_dm_sessions").doc(user.id).delete().catch(() => {});
    throw err;
  }
  await user.send(safeMentions({ components: [makeCard(guild, "Ticket opened", "Your private support ticket in " + guild.name + " is open. Send further messages in this DM and FRIDAY will forward them. Type new ticket to choose another server.")], flags: MessageFlags.IsComponentsV2 })).catch(() => {});
}
async function handleDm(message, client) {
  const body = String(message.content || "").trim();
  if (/^\s*(new ticket|switch server|start new support|new support ticket)\s*$/i.test(body)) {
    await db.collection("modmail_dm_sessions").doc(message.author.id).delete().catch(() => {});
    pendingMessages.delete(message.author.id);
    return showPicker(message.author, client, "Choose a server where you want to start a support ticket.");
  }
  const sessionSnap = await db.collection("modmail_dm_sessions").doc(message.author.id).get().catch(() => null);
  const session = sessionSnap?.exists ? sessionSnap.data() || {} : null;
  if (session?.guildId && session?.threadId) {
    const guild = client.guilds.cache.get(session.guildId);
    const ref = threadRef(session.guildId, session.threadId);
    const snap = await ref.get().catch(() => null);
    const thread = snap?.exists ? snap.data() || {} : null;
    const channel = guild && thread?.status === "open" && thread.ticketChannelId ? await guild.channels.fetch(thread.ticketChannelId).catch(() => null) : null;
    if (channel?.isTextBased?.()) {
      return relayDm(guild, message.author, thread, channel, { content: body, attachments: attachmentsOf(message) });
    }
    await db.collection("modmail_dm_sessions").doc(message.author.id).delete().catch(() => {});
  }
  const draft = { content: body, attachments: attachmentsOf(message), createdAt: Date.now() };
  pendingMessages.set(message.author.id, draft);
  setTimeout(() => {
    if (pendingMessages.get(message.author.id) === draft && Date.now() - draft.createdAt >= PENDING_TTL) pendingMessages.delete(message.author.id);
  }, PENDING_TTL);
  return showPicker(message.author, client, "Choose a server for your request. Your latest DM will be sent to its support team.");
}

module.exports = client => {
  client.on("messageCreate", async message => {
    if (message.author.bot) return;
    if (!message.guild) {
      try { await handleDm(message, client); }
      catch (err) {
        console.error("[ModMail] DM handler failed:", err);
        await message.author.send(safeMentions({ components: [makeCard(null, "Could not start ModMail", "FRIDAY couldn't open a ticket. Try again or contact a server administrator.", COLORS.RED)], flags: MessageFlags.IsComponentsV2 })).catch(() => {});
      }
      return;
    }

    const parsed = await parseCommand(message).catch(() => null);
    if (!parsed || parsed.command !== "modmail") return;
    if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return message.reply(safeMentions({ components: [makeCard(message.guild, "Permission Denied", "You need Manage Server to inspect this server's ModMail settings.", COLORS.RED)], flags: MessageFlags.IsComponentsV2 }));
    }
    const cfg = await guildConfig.get(message.guild.id);
    return message.reply(safeMentions({ components: [makeCard(message.guild, "ModMail Configuration",
      "Ticket category: " + (cfg.ticketCategory ? "<#" + cfg.ticketCategory + ">" : "not set") +
      "\nSupport role: " + (cfg.supportRole ? "<@&" + cfg.supportRole + ">" : "not set") +
      "\nTicket logs: " + (cfg.ticketLogs ? "<#" + cfg.ticketLogs + ">" : "not set") +
      "\n\nConfigure ticketCategory and supportRole in .config to enable private support tickets.")], flags: MessageFlags.IsComponentsV2 }));
  });

  client.on("interactionCreate", async interaction => {
    if (interaction.isStringSelectMenu() && interaction.customId === SELECT_ID) {
      try {
        const selected = (await availableGuilds(interaction.user.id, client)).find(item => item.guild.id === interaction.values[0]);
        if (!selected) return interaction.update({ components: [makeCard(null, "Server unavailable", "You are no longer a member of that server or its ModMail settings changed. Send another DM to choose again.")], flags: MessageFlags.IsComponentsV2 });
        await interaction.update({ components: [makeCard(selected.guild, "Opening ticket", "FRIDAY is creating your private ticket in " + selected.guild.name + ".")], flags: MessageFlags.IsComponentsV2 });
        const draft = pendingMessages.get(interaction.user.id) || null;
        pendingMessages.delete(interaction.user.id);
        await startTicket(selected.guild, interaction.user, selected.cfg, draft);
        return interaction.editReply({ components: [makeCard(selected.guild, "Support ready", "Your ticket in " + selected.guild.name + " is open. Continue by sending messages in this DM.")], flags: MessageFlags.IsComponentsV2 });
      } catch (err) {
        console.error("[ModMail] Server selection failed:", err);
        return interaction.editReply({ components: [makeCard(null, "Could not open ticket", String(err.message || "Setup failed").slice(0, 1000), COLORS.RED)], flags: MessageFlags.IsComponentsV2 }).catch(() => {});
      }
    }

    if (interaction.isButton() && interaction.customId.startsWith("friday-modmail-close:")) {
      try {
        const parts = interaction.customId.split(":");
        const guildId = parts[1], userId = parts[2];
        if (!interaction.guild || interaction.guild.id !== guildId) return interaction.reply({ content: "This ticket control belongs to its original server.", flags: MessageFlags.Ephemeral });
        const cfg = await guildConfig.get(guildId);
        const member = interaction.member;
        const allowed = member?.permissions?.has(PermissionFlagsBits.ManageGuild) ||
          member?.permissions?.has(PermissionFlagsBits.Administrator) ||
          Boolean(cfg.supportRole && member?.roles?.cache?.has(cfg.supportRole));
        if (!allowed) return interaction.reply({ content: "Only support staff can close this ticket.", flags: MessageFlags.Ephemeral });
        const ref = threadRef(guildId, userId);
        const snap = await ref.get();
        if (!snap.exists || snap.data()?.status !== "open") return interaction.reply({ content: "This ticket is already closed or its record is missing.", flags: MessageFlags.Ephemeral });
        await interaction.channel.permissionOverwrites.edit(userId, { ViewChannel: false, SendMessages: false }, { reason: "F.R.I.D.A.Y ModMail ticket closed" });
        await ref.set({ status: "closed", updatedAt: Date.now(), statusChangedBy: interaction.user.id, lastActivityAt: Date.now() }, { merge: true });
        await db.collection("modmail_dm_sessions").doc(userId).delete().catch(() => {});
        const user = await client.users.fetch(userId).catch(() => null);
        await user?.send(safeMentions({ components: [makeCard(interaction.guild, "Ticket closed", "Your ModMail ticket in " + interaction.guild.name + " was closed. Send new ticket if you need further help.")], flags: MessageFlags.IsComponentsV2 })).catch(() => {});
        await sendLogs(interaction.guild, cfg, "Ticket for " + userId + " was closed by " + interaction.user.tag + ".");
        return interaction.update({ components: [makeCard(interaction.guild, "Ticket Closed", "Closed by " + interaction.user.tag + ". The user can no longer view this ticket channel.")], flags: MessageFlags.IsComponentsV2 });
      } catch (err) {
        console.error("[ModMail] Close button failed:", err);
        return interaction.reply({ content: "Could not close the ticket. Check FRIDAY's permissions.", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  });

  client.on("messageCreate", async message => {
    if (!message.guild || message.author.bot || !message.channel?.id) return;
    try {
      const map = await db.collection("modmail_ticket_channels").doc(message.channel.id).get();
      if (!map.exists) return;
      const { guildId, userId, threadId } = map.data() || {};
      if (guildId !== message.guild.id || !userId || !threadId) return;
      const ref = threadRef(guildId, threadId);
      const snap = await ref.get();
      const thread = snap.exists ? snap.data() || {} : null;
      if (!thread || thread.status !== "open") return;
      const content = contentOf(message);
      const attachments = attachmentsOf(message);
      await saveMessage(ref, {
        authorId: message.author.id,
        authorName: message.author.tag || message.author.username,
        authorType: message.author.id === userId ? "user" : "staff",
        content, attachments, source: "ticket-channel"
      });
      if (message.author.id !== userId) {
        const user = await client.users.fetch(userId).catch(() => null);
        if (user) await user.send(safeMentions({ components: [makeCard(message.guild, "Support Reply · " + message.guild.name, content || "A support team member sent an attachment.")], flags: MessageFlags.IsComponentsV2 })).catch(err => console.warn("[ModMail] Could not DM user:", err.message));
      }
    } catch (err) {
      console.error("[ModMail] Ticket relay failed:", err.message);
    }
  });

  client.on("channelDelete", async channel => {
    if (!channel.guild) return;
    try {
      const mapRef = db.collection("modmail_ticket_channels").doc(channel.id);
      const snap = await mapRef.get();
      if (!snap.exists) return;
      const { guildId, userId, threadId } = snap.data() || {};
      if (guildId && userId && threadId) {
        await threadRef(guildId, threadId).set({ status: "closed", ticketChannelId: null, updatedAt: Date.now(), closeReason: "ticket-channel-deleted" }, { merge: true });
        await db.collection("modmail_dm_sessions").doc(userId).delete().catch(() => {});
      }
      await mapRef.delete();
    } catch (err) { console.warn("[ModMail] Could not reconcile deleted ticket channel:", err.message); }
  });
};