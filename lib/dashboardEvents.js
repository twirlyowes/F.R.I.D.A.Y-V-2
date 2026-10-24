const crypto = require("crypto");

const ID = /^\d{17,20}$/;
const SEVERITIES = new Set(["info", "success", "warning", "error"]);
const pruneCounter = new Map();

function makeRecorder(db = null) {
  const store = db || require("../firebase");
  async function recordEvent(guildId, input = {}) {
    if (!ID.test(String(guildId || ""))) return null;
    const ref = store.collection("friday_events").doc(guildId).collection("items");
    const id = crypto.randomUUID();
    const event = {
      id,
      type: String(input.type || "activity").slice(0, 80),
      title: String(input.title || input.type || "FRIDAY activity").slice(0, 160),
      detail: String(input.detail || "").slice(0, 500),
      severity: SEVERITIES.has(input.severity) ? input.severity : "info",
      actorId: ID.test(String(input.actorId || "")) ? String(input.actorId) : null,
      actorName: String(input.actorName || "").slice(0, 80),
      targetId: ID.test(String(input.targetId || "")) ? String(input.targetId) : null,
      targetName: String(input.targetName || "").slice(0, 80),
      source: "bot",
      createdAt: Date.now()
    };
    await ref.doc(id).set(event);
    // Prune only every 100 events to keep write-time Firestore reads bounded.
    // The feed endpoint itself reads only the newest 100 events.
    const count = (pruneCounter.get(guildId) || 0) + 1;
    pruneCounter.set(guildId, count);
    if (count % 100 === 0) {
      const old = await ref.orderBy("createdAt", "desc").limit(251).get();
      if (old.docs.length > 250) {
        const batch = store.batch();
        old.docs.slice(250).forEach(doc => batch.delete(doc.ref));
        await batch.commit();
      }
    }
    return id;
  }

  async function recordCase(guildId, input = {}) {
    if (!ID.test(String(guildId || "")) || !ID.test(String(input.targetId || ""))) return null;
    const ref = store.collection("friday_cases").doc(guildId).collection("items").doc(input.caseId || crypto.randomUUID());
    const data = {
      caseId: ref.id,
      guildId,
      action: String(input.action || "note").slice(0, 32).toLowerCase(),
      targetId: String(input.targetId),
      targetName: String(input.targetName || "").slice(0, 100),
      moderatorId: ID.test(String(input.moderatorId || "")) ? String(input.moderatorId) : null,
      moderatorName: String(input.moderatorName || "").slice(0, 100),
      reason: String(input.reason || "No reason provided").slice(0, 2000),
      status: "active",
      source: "friday",
      sourceRecordId: input.sourceRecordId ? String(input.sourceRecordId).slice(0, 128) : null,
      createdAt: Date.now()
    };
    await ref.set(data, { merge: true });
    await recordEvent(guildId, {
      type: "moderation." + data.action,
      title: "Moderation case created · " + data.action,
      detail: data.reason,
      severity: "warning",
      actorId: data.moderatorId,
      actorName: data.moderatorName,
      targetId: data.targetId,
      targetName: data.targetName
    }).catch(error => console.error("[Dashboard Events] Case event failed:", error.message));
    return ref.id;
  }

  async function recordVerificationReview(guildId, userId, input = {}) {
    if (!ID.test(String(guildId || "")) || !ID.test(String(userId || ""))) return null;
    const ref = store.collection("friday_verification_reviews").doc(guildId).collection("items").doc(userId);
    const previous = await ref.get();
    const prior = previous.exists ? previous.data() || {} : {};
    const review = {
      userId,
      status: prior.status === "pending" ? "pending" : "pending",
      reason: String(input.reason || "Repeated CAPTCHA verification failures").slice(0, 500),
      attempts: Math.max(0, Number(input.attempts) || 0),
      updatedAt: Date.now(),
      ...(prior.createdAt ? {} : { createdAt: Date.now() })
    };
    await ref.set(review, { merge: true });
    await recordEvent(guildId, {
      type: "verification.review",
      title: "Verification needs review",
      detail: review.reason,
      severity: "warning",
      targetId: userId
    }).catch(error => console.error("[Dashboard Events] Verification event failed:", error.message));
    return userId;
  }

  return { recordEvent, recordCase, recordVerificationReview };
}

function attachDashboardEvents(client, db = null) {
  const store = db || require("../firebase");
  const { recordEvent } = makeRecorder(store);
  const log = (promise, label) => promise.catch(error => console.error("[Dashboard Events] " + label + " failed:", error.message));

  client.on("guildMemberAdd", member => {
    log(recordEvent(member.guild.id, {
      type: "member.join",
      title: "Member joined",
      detail: "A member joined the server.",
      severity: "info",
      targetId: member.id,
      targetName: member.user?.tag || member.user?.username
    }), "member join");
  });
  client.on("guildMemberRemove", member => {
    log(recordEvent(member.guild.id, {
      type: "member.leave",
      title: "Member left",
      detail: "A member left or was removed from the server.",
      severity: "info",
      targetId: member.id,
      targetName: member.user?.tag || member.user?.username
    }), "member leave");
  });
  client.on("guildBanAdd", ban => {
    log(recordEvent(ban.guild.id, {
      type: "moderation.ban",
      title: "Member banned",
      detail: "Discord reported a new ban. Actor and reason are unknown unless recorded by the command handler.",
      severity: "warning",
      targetId: ban.user?.id,
      targetName: ban.user?.tag || ban.user?.username
    }), "ban event");
  });
  client.on("guildBanRemove", ban => {
    log(recordEvent(ban.guild.id, {
      type: "moderation.unban",
      title: "Member unbanned",
      detail: "Discord reported an unban.",
      severity: "info",
      targetId: ban.user?.id,
      targetName: ban.user?.tag || ban.user?.username
    }), "unban event");
  });
  client.on("channelCreate", channel => {
    if (!channel.guild) return;
    log(recordEvent(channel.guild.id, {
      type: "channel.create", title: "Channel created",
      detail: "Channel #" + String(channel.name || channel.id).slice(0, 100) + " (" + channel.type + ").",
      severity: "info", actorId: null
    }), "channel create");
  });
  client.on("channelDelete", channel => {
    if (!channel.guild) return;
    log(recordEvent(channel.guild.id, {
      type: "channel.delete", title: "Channel deleted",
      detail: "Channel #" + String(channel.name || channel.id).slice(0, 100) + " (" + channel.type + ") was deleted.",
      severity: "warning"
    }), "channel delete");
  });
  client.on("messageDelete", message => {
    if (!message.guild || !message.author || message.author.bot) return;
    log(recordEvent(message.guild.id, {
      type: "message.delete", title: "Message deleted",
      detail: "A user message was deleted in #" + String(message.channel?.name || message.channelId || "unknown").slice(0, 100) + ". Message content is not stored.",
      severity: "info", targetId: message.author.id,
      targetName: message.author.tag || message.author.username
    }), "message delete");
  });

  async function syncVoiceRoom(guild, channelId) {
    if (!guild || !channelId) return;
    const recordRef = store.collection("voiceChannels").doc(channelId);
    const tracked = await recordRef.get();
    if (!tracked.exists || tracked.data()?.guildId !== guild.id) return;
    const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
    const ref = store.collection("voice_room_state").doc(guild.id).collection("channels").doc(channelId);
    if (!channel || !channel.isVoiceBased?.()) {
      await ref.delete().catch(() => {});
      return;
    }
    await ref.set({
      channelId,
      guildId: guild.id,
      memberIds: [...channel.members.keys()],
      updatedAt: Date.now()
    }, { merge: true });
  }

  client.on("voiceStateUpdate", (oldState, newState) => {
    const guild = newState.guild || oldState.guild;
    const ids = new Set([oldState.channelId, newState.channelId].filter(Boolean));
    for (const channelId of ids) {
      log(syncVoiceRoom(guild, channelId), "voice room state");
    }
  });

  return { recordEvent, ...makeRecorder(store) };
}

module.exports = { makeRecorder, attachDashboardEvents };
