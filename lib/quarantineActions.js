// Short-lived in-process suppression for role changes explicitly initiated by .q/.uq.
// No Firestore reads or writes are used for this coordination.
const EXPECTED_CHANGE_TTL_MS = 15_000;
const expected = new Map();

function key(guildId, memberId) {
  return `${guildId}:${memberId}`;
}

function expectRoleChange(guildId, memberId) {
  const id = key(guildId, memberId);
  expected.set(id, Date.now() + EXPECTED_CHANGE_TTL_MS);
}

function isExpectedRoleChange(guildId, memberId) {
  const id = key(guildId, memberId);
  const expiresAt = expected.get(id);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    expected.delete(id);
    return false;
  }
  return true;
}

module.exports = { expectRoleChange, isExpectedRoleChange };
