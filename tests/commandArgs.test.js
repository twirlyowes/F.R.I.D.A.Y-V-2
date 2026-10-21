const test = require('node:test');
const assert = require('node:assert/strict');
const { extractSnowflake, parseDuration, parseMuteArguments, parseStrictInteger } = require('../lib/commandArgs');
const userId = '12345678901234567';
test('extractSnowflake accepts mentions and raw IDs, not arbitrary text', () => {
  assert.equal(extractSnowflake('<@' + userId + '>'), userId);
  assert.equal(extractSnowflake('<@!' + userId + '>'), userId);
  assert.equal(extractSnowflake(userId), userId);
  assert.equal(extractSnowflake('user-' + userId), null);
  assert.equal(extractSnowflake('<@&' + userId + '>'), null);
});
test('parseDuration accepts common, spaced, decimal and compound durations', () => {
  assert.equal(parseDuration('35m'), 2100000); assert.equal(parseDuration('35M'), 2100000);
  assert.equal(parseDuration('35 minutes'), 2100000); assert.equal(parseDuration('1.5h'), 5400000);
  assert.equal(parseDuration('1h30m'), 5400000); assert.equal(parseDuration('45s'), 45000);
});
test('parseDuration rejects malformed, zero, negative and over-limit values', () => {
  assert.equal(parseDuration('35months'), null); assert.equal(parseDuration('5people'), null);
  assert.equal(parseDuration('-5m'), null); assert.equal(parseDuration('0m'), null);
  assert.equal(parseDuration('29d'), null); assert.equal(parseDuration('1.5'), null);
});
test('parseMuteArguments accepts target-first and duration-first layouts with reasons', () => {
  const a = parseMuteArguments(['<@' + userId + '>', '35', 'minutes', 'sheh', 'ge']);
  assert.deepEqual(a, { userId, durationMs: 2100000, durationLabel: '35 minutes', reason: 'sheh ge' });
  const b = parseMuteArguments(['35m', '<@!' + userId + '>', 'very', 'loud']);
  assert.deepEqual(b, { userId, durationMs: 2100000, durationLabel: '35m', reason: 'very loud' });
  const c = parseMuteArguments(['for', '35m', userId, 'spamming', 'links']);
  assert.deepEqual(c, { userId, durationMs: 2100000, durationLabel: '35m', reason: 'spamming links' });
  assert.equal(parseMuteArguments(['<@' + userId + '>', '35months', 'bad reason']), null);
});
test('strict integers reject suffixes and decimals', () => {
  assert.equal(parseStrictInteger('99', 0, 99), 99); assert.equal(parseStrictInteger('0', 0, 99), 0);
  assert.equal(parseStrictInteger('5people', 0, 99), null); assert.equal(parseStrictInteger('5.9', 0, 99), null);
  assert.equal(parseStrictInteger('100', 0, 99), null);
});