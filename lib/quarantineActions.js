// Tracks narrowly scoped role deltas explicitly initiated by .uq.
// In-memory coordination avoids extra Firestore reads/writes.
const EXPECTED_CHANGE_TTL_MS = 15_000;
const expected = new Map();

function key(guildId, memberId) {
  return `${guildId}:${memberId}`;
}

function expectUnquarantine(guildId, memberId, quarantineRoleId, allowedRoleIds) {
  expected.set(key(guildId, memberId), {
    expiresAt: Date.now() + EXPECTED_CHANGE_TTL_MS,
    quarantineRoleId,
    allowedRoleIds: new Set(allowedRoleIds || [])
  });
}

function isExpectedRoleChange(guildId, memberId, oldMember, newMember, quarantineRoleId) {
  const id = key(guildId, memberId);
  const item = expected.get(id);
  if (!item) return false;
  if (item.expiresAt <= Date.now()) {
    expected.delete(id);
    return false;
  }
  if (item.quarantineRoleId !== quarantineRoleId) return false;

  const oldIds = new Set(oldMember.roles.cache.keys());
  const newIds = new Set(newMember.roles.cache.keys());
  const removed = [...oldIds].filter(roleId => !newIds.has(roleId) && roleId !== guildId);
  const added = [...newIds].filter(roleId => !oldIds.has(roleId) && roleId !== guildId);
  const quarantineRemoved = oldIds.has(quarantineRoleId) && !newIds.has(quarantineRoleId);
  const onlyExpectedAdds = added.every(roleId => item.allowedRoleIds.has(roleId));
  const noUnexpectedRemovals = removed.every(roleId => roleId === quarantineRoleId);

  // Allow quarantine removal and restoration of only the saved roles. If an
  // unrelated role is added/removed, don't suppress the security handler.
  const expected = onlyExpectedAdds && noUnexpectedRemovals &&
    (quarantineRemoved || added.length > 0);
  if (expected && quarantineRemoved) expected.delete(id);
  return expected;
}

module.exports = { expectUnquarantine, isExpectedRoleChange };
