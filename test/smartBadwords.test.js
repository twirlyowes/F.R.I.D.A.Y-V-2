const test = require("node:test");
const assert = require("node:assert/strict");
const { findNormalizedBadword, normalizeWord } = require("../lib/smartBadwords");

test("normalizes common leetspeak", () => {
  assert.equal(normalizeWord("b@dw0rd"), "badword");
});

test("matches configured words with punctuation and short spacing gaps", () => {
  assert.equal(findNormalizedBadword("you said b@d-w0rd!", ["badword"]), "badword");
  assert.equal(findNormalizedBadword("b a d w o r d", ["badword"]), "badword");
});

test("does not match a configured word embedded in a larger word", () => {
  assert.equal(findNormalizedBadword("notbadwordish", ["badword"]), null);
});

test("ignores very short configured words in normalized mode", () => {
  assert.equal(findNormalizedBadword("class", ["ass"]), null);
});

test("returns null when no configured word matches", () => {
  assert.equal(findNormalizedBadword("hello everyone", ["badword", "otherword"]), null);
});
