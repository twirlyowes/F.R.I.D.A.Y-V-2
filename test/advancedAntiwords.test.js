"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { detectAdvancedAbuse, normalizeText } = require("../lib/advancedAntiwords");

test("detects family-targeted Hindi/Hinglish sexual abuse", () => {
  assert.ok(detectAdvancedAbuse("teri ma ke chutado pe gandi baat kar dunga"));
});

test("detects sexual humiliation involving nudity and coerced performance", () => {
  assert.ok(detectAdvancedAbuse("teri mummy ko bina kapdo ke mujra karwa ke beizzat karunga"));
});

test("detects obfuscated and elongated insult spellings", () => {
  assert.ok(detectAdvancedAbuse("c.h.u.t.i.y.a"));
  assert.ok(detectAdvancedAbuse("chuuutttado"));
});

test("detects the reported spaced Hindi/Hinglish sexual-abuse variants", () => {
  assert.ok(detectAdvancedAbuse("Dekho bat esi he bate tumhari ma chuda ne vali he behen vo hmm cho dd denge"));
  assert.ok(detectAdvancedAbuse("tumhari ma chuda ne wali hai"));
  assert.ok(detectAdvancedAbuse("teri behen ko chod denge"));
});

test("detects directly targeted English abuse", () => {
  assert.ok(detectAdvancedAbuse("go fuck yourself"));
});

test("normalization handles common character substitutions", () => {
  assert.match(normalizeText("m0th3r"), /mother/);
});

test("does not flag ordinary family references or unrelated swearing", () => {
  assert.equal(detectAdvancedAbuse("my mother likes dancing"), null);
  assert.equal(detectAdvancedAbuse("we watched a mujra performance"), null);
  assert.equal(detectAdvancedAbuse("what the fuck is this bug"), null);
  assert.equal(detectAdvancedAbuse("your mother is a doctor"), null);
});
