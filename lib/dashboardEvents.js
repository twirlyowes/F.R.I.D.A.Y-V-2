const crypto = require("crypto");

const ID = /^\d{17,20}$/;

function makeRecorder(db = null) {
  const store = db || require("../firebase");

  // Live dashboard audit events are intentionally disabled to reduce Firestore
  // writes. Keep this no-op for compatibility with any existing callers.
  async function recordEvent() {
    return null;
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
    return ref.id;
  }

  async function recordVerificationReview(guildId, userId, input = {}) {
    if (!ID.test(String(guildId || "")) || !ID.test(String(userId || ""))) return null;
    const ref = store.collection("friday_verification_reviews").doc(guildId).collection("items").doc(userId);
    const previous = await ref.get();
    const prior = previous.exists ? previous.data() || {} : {};
    const review = {
      userId,
      status: "pending",
      reason: String(input.reason || "Repeated CAPTCHA verification failures").slice(0, 500),
      attempts: Math.max(0, Number(input.attempts) || 0),
      updatedAt: Date.now(),
      ...(prior.createdAt ? {} : { createdAt: Date.now() })
    };
    await ref.set(review, { merge: true });
    return userId;
  }

  return { recordEvent, recordCase, recordVerificationReview };
}

function attachDashboardEvents(client, db = null) {
  const store = db || require("../firebase");

  // Preserve voice-room state synchronisation; it powers voice-room controls
  // and is separate from the optional live audit-log feed.
  const voiceRoomMemberCache = new Map();
  const voiceRoomSyncQueues = new Map();

  function sameMemberIds(left, right) {
    return Array.isArray(left) && left.length === right.length &&
      left.every((memberId, index) => memberId === right[index]);
  }

  async function syncVoiceRoomNow(guild, channelId, cacheKey) {
    const recordRef = store.collection("voiceChannels").doc(channelId);
    const tracked = await recordRef.get();
    if (!tracked.exists || tracked.data()?.guildId !== guild.id) {
      voiceRoomMemberCache.delete(cacheKey);
      return;
    }

    const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
    const ref = store.collection("voice_room_state").doc(guild.id).collection("channels").doc(channelId);
    if (!channel || !channel.isVoiceBased?.()) {
      if (voiceRoomMemberCache.get(cacheKey) !== null) {
        try {
          await ref.delete();
          voiceRoomMemberCache.set(cacheKey, null);
        } catch {
          // Do not memoize a failed delete; a later event can retry it.
          voiceRoomMemberCache.delete(cacheKey);
        }
      }
      return;
    }

    const memberIds = [...channel.members.keys()].sort();
    if (sameMemberIds(voiceRoomMemberCache.get(cacheKey), memberIds)) return;

    await ref.set({
      channelId,
      guildId: guild.id,
      memberIds,
      updatedAt: Date.now()
    }, { merge: true });
    voiceRoomMemberCache.set(cacheKey, memberIds);
  }

  function syncVoiceRoom(guild, channelId) {
    if (!guild || !channelId) return Promise.resolve();
    const cacheKey = `${guild.id}:${channelId}`;
    const previous = voiceRoomSyncQueues.get(cacheKey) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => syncVoiceRoomNow(guild, channelId, cacheKey));
    let queued;
    queued = current.finally(() => {
      if (voiceRoomSyncQueues.get(cacheKey) === queued) voiceRoomSyncQueues.delete(cacheKey);
    });
    voiceRoomSyncQueues.set(cacheKey, queued);
    return queued;
  }

  client.on("voiceStateUpdate", async (oldState, newState) => {
    const guild = newState.guild || oldState.guild;
    const ids = new Set([oldState.channelId, newState.channelId].filter(Boolean));
    await Promise.all([...ids].map(channelId =>
      syncVoiceRoom(guild, channelId).catch(error =>
        console.error("[Voice Room State] Sync failed:", error.message)
      )
    ));
  });

  return { recordEvent: async () => null, ...makeRecorder(store) };
}

module.exports = { makeRecorder, attachDashboardEvents };
