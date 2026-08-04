"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ranges, PER_RANGE, MAX_LISTED } = require("../lib/ranges.js");

test("a session shorter than one range is a single range", () => {
  const r = ranges(500);
  assert.deepEqual(r.list, [{ first: 1, last: 500 }]);
  assert.equal(r.truncated, false);
  assert.equal(r.total, 500);
});

test("an exact multiple of the range size produces no empty trailing range", () => {
  const r = ranges(2400);
  assert.deepEqual(r.list, [
    { first: 1, last: 1200 },
    { first: 1201, last: 2400 },
  ]);
});

test("ranges cover every line exactly once with no gap and no overlap", () => {
  const total = 9_733;
  const r = ranges(total);
  assert.equal(r.list[0].first, 1);
  assert.equal(
    r.list[r.list.length - 1].last,
    total,
    "the last range ends at N",
  );
  for (let i = 1; i < r.list.length; i += 1) {
    assert.equal(
      r.list[i].first,
      r.list[i - 1].last + 1,
      `range ${i} starts right after ${i - 1}`,
    );
  }
  const covered = r.list.reduce((sum, x) => sum + (x.last - x.first + 1), 0);
  assert.equal(covered, total, "every line is covered exactly once");
});

test("past the listing cap the enumeration truncates rather than growing without bound", () => {
  const total = PER_RANGE * (MAX_LISTED + 15);
  const r = ranges(total);
  assert.equal(r.truncated, true);
  assert.equal(r.list.length, MAX_LISTED);
  assert.equal(r.total, total);
});

test("a session at the cap is not truncated", () => {
  const r = ranges(PER_RANGE * MAX_LISTED);
  assert.equal(r.truncated, false);
  assert.equal(r.list.length, MAX_LISTED);
});

test("an empty session yields no ranges", () => {
  assert.deepEqual(ranges(0).list, []);
});
