// Segment derivation is the one piece of audit logic with no browser in it, and
// the piece the whole viewer is built on: it turns a flat action log into the
// "tab A, then tab B, then back to tab A" timeline a reviewer scrubs through.
//
// It is worth testing precisely because the tempting implementation — group by
// tabId — is wrong. Returning to a tab must produce a THIRD segment, not merge
// back into the first, or the replay jumps backwards in time.

import { segmentsOf } from "../extension/audit/index.js";

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) {
    pass++;
    console.log("  PASS " + name);
  } else {
    fail++;
    console.log("  FAIL " + name);
  }
}

const A = "sA";
const B = "sB";

console.log("== consecutive actions on one tab collapse into one segment ==");
{
  const segs = segmentsOf({
    actions: [
      { t: 1, tabId: 1, streamId: A },
      { t: 2, tabId: 1, streamId: A },
      { t: 3, tabId: 1, streamId: A }
    ]
  });
  check("one segment", segs.length === 1);
  check("spans first to last action", segs[0].tStart === 1 && segs[0].tEnd === 3);
  check("keeps every action", segs[0].actions.length === 3);
}

console.log("== switching tabs divides the timeline ==");
{
  const segs = segmentsOf({
    actions: [
      { t: 1, tabId: 1, streamId: A },
      { t: 2, tabId: 2, streamId: B }
    ]
  });
  check("two segments", segs.length === 2);
  check("in action order", segs[0].streamId === A && segs[1].streamId === B);
}

console.log("== RETURNING to a tab opens a new segment, never merges backwards ==");
{
  const segs = segmentsOf({
    actions: [
      { t: 1, tabId: 1, streamId: A },
      { t: 2, tabId: 2, streamId: B },
      { t: 3, tabId: 1, streamId: A }
    ]
  });
  check("three segments, not two", segs.length === 3);
  check("third points back at the same stream", segs[2].streamId === A);
  check(
    "segments are monotonic in time",
    segs.every((s, i) => i === 0 || s.tStart >= segs[i - 1].tEnd)
  );
  check("the revisit is its own window", segs[2].tStart === 3 && segs[0].tEnd === 1);
}

console.log("== a navigation mid-tab starts a new stream, so a new segment ==");
{
  // Same tabId, different streamId: the document was replaced, so its rrweb
  // node ids belong to a different snapshot and cannot be replayed as one.
  const segs = segmentsOf({
    actions: [
      { t: 1, tabId: 1, streamId: "s1_early" },
      { t: 2, tabId: 1, streamId: "s1_late" }
    ]
  });
  check("split by stream, not by tab", segs.length === 2);
}

console.log("== actions with no stream are skipped, not crashed on ==");
{
  const segs = segmentsOf({
    actions: [
      { t: 1, tabId: null, streamId: null }, // e.g. a restricted page
      { t: 2, tabId: 1, streamId: A }
    ]
  });
  check("only the recorded action survives", segs.length === 1 && segs[0].streamId === A);
}

console.log("== empty and malformed input ==");
{
  check("no actions", segmentsOf({ actions: [] }).length === 0);
  check("missing actions key", segmentsOf({}).length === 0);
}

console.log(`\n${fail === 0 ? "ALL AUDIT SEGMENT TESTS PASSED" : fail + " FAILED"} (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
