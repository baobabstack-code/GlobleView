import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatLocalTime,
  formatLocalTimestamp,
  formatUtcOffset,
} from './hudClock.js';

/** A Date whose local fields and offset are fixed, independent of the host TZ. */
function fakeDate({ y, mo, d, h, mi, s, offsetMinutes }) {
  return {
    getFullYear: () => y,
    getMonth: () => mo - 1,
    getDate: () => d,
    getHours: () => h,
    getMinutes: () => mi,
    getSeconds: () => s,
    getTimezoneOffset: () => -offsetMinutes,
  };
}

const harare = fakeDate({
  y: 2026,
  mo: 10,
  d: 13,
  h: 18,
  mi: 17,
  s: 42,
  offsetMinutes: 120,
});

test('the REC timestamp reads local time with its UTC offset', () => {
  assert.equal(formatLocalTimestamp(harare), '2026-10-13 18:17:42 UTC+2');
});

test('the COLL time reads local HH:MM:SS', () => {
  assert.equal(formatLocalTime(harare), '18:17:42');
});

test('offset labels cover zero, negative and half-hour zones', () => {
  assert.equal(formatUtcOffset(fakeDate({ offsetMinutes: 0 })), 'UTC');
  assert.equal(formatUtcOffset(fakeDate({ offsetMinutes: -300 })), 'UTC-5');
  assert.equal(formatUtcOffset(fakeDate({ offsetMinutes: 330 })), 'UTC+5:30');
  assert.equal(formatUtcOffset(fakeDate({ offsetMinutes: -210 })), 'UTC-3:30');
});

test('single-digit fields are zero-padded', () => {
  const early = fakeDate({
    y: 2026,
    mo: 1,
    d: 2,
    h: 3,
    mi: 4,
    s: 5,
    offsetMinutes: 60,
  });
  assert.equal(formatLocalTimestamp(early), '2026-01-02 03:04:05 UTC+1');
});
