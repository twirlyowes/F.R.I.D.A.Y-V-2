"use strict";

function setMetricValue(map, userId, value, dirtyUserIds) {
  const current = map.has(userId) ? map.get(userId) : 0;
  if (Object.is(current, value)) return false;
  map.set(userId, value);
  dirtyUserIds.add(userId);
  return true;
}

function snapshotMetrics(userId, maps) {
  const snapshot = {};
  for (const [field, map] of Object.entries(maps)) {
    snapshot[field] = map.has(userId) ? map.get(userId) : 0;
  }
  return snapshot;
}

function matchesSnapshot(userId, snapshot, maps) {
  return Object.entries(snapshot).every(([field, value]) => {
    const map = maps[field];
    const current = map && map.has(userId) ? map.get(userId) : 0;
    return Object.is(current, value);
  });
}

module.exports = { setMetricValue, snapshotMetrics, matchesSnapshot };
