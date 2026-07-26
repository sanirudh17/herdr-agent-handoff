"use strict";

// A transcript is handed over as ordered line ranges rather than copied part
// files. The reason is the same one the part files had: a single 568KB file
// invites a partial read. These are instructions, so they cost nothing on disk.
const PER_RANGE = 1200;
const MAX_LISTED = 40;

function ranges(totalLines, opts = {}) {
  const { perRange = PER_RANGE, maxListed = MAX_LISTED } = opts;
  const list = [];
  for (let first = 1; first <= totalLines; first += perRange) {
    list.push({ first, last: Math.min(first + perRange - 1, totalLines) });
  }
  const truncated = list.length > maxListed;
  return {
    list: truncated ? list.slice(0, maxListed) : list,
    truncated,
    perRange,
    total: totalLines,
  };
}

module.exports = { ranges, PER_RANGE, MAX_LISTED };
