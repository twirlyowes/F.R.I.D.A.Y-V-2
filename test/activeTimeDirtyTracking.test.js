"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  setMetricValue,
  snapshotMetrics,
  matchesSnapshot
} = require("../lib/activeTimeDirtyTracking");

function fixture() {
  return {
    maps: {
      activeTime: new Map(),
      voiceTime: new Map(),
      messages: new Map(),
      commands: new Map()
    },
    dirty: new Set()
  };
}

test("unchanged metrics do not mark a user dirty", () => {
  const { maps, dirty } = fixture();
  assert.equal(setMetricValue(maps.activeTime, "guild:user", 0, dirty), false);
  assert.equal(dirty.has("guild:user"), false);

  setMetricValue(maps.activeTime, "guild:user", 120, dirty);
  assert.equal(setMetricValue(maps.activeTime, "guild:user", 120, dirty), false);
  assert.equal(dirty.has("guild:user"), true);
});

test("a save snapshot is acknowledged only if no newer metric arrived", () => {
  const { maps, dirty } = fixture();
  setMetricValue(maps.messages, "guild:user", 3, dirty);
  const snapshot = snapshotMetrics("guild:user", maps);

  assert.equal(matchesSnapshot("guild:user", snapshot, maps), true);
  setMetricValue(maps.messages, "guild:user", 4, dirty);
  assert.equal(matchesSnapshot("guild:user", snapshot, maps), false);
  assert.equal(dirty.has("guild:user"), true);
});

test("snapshots include all metrics and treat absent counters as zero", () => {
  const { maps } = fixture();
  maps.voiceTime.set("guild:user", 500);
  assert.deepEqual(snapshotMetrics("guild:user", maps), {
    activeTime: 0,
    voiceTime: 500,
    messages: 0,
    commands: 0
  });
});
