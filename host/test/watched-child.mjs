#!/usr/bin/env node
//
// A minimal process running the real watchParent, used by parent-watch.test.mjs.
// It exits only if the reaper tells it to, so its survival is the assertion.

import { watchParent } from "../parent-watch.js";

watchParent(() => process.exit(7));
process.stdin.resume();
setInterval(() => {}, 1 << 30);
