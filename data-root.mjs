#!/usr/bin/env node
// data-root.mjs — print the career-ops data root: the folder holding the user's
// files (cv.md, config/profile.yml, modes/_profile.md, portals.yml, data/,
// reports/ ...). Resolved by path-resolver.mjs: CAREER_OPS_DATA_DIR /
// CAREER_OPS_ROOT, then the .career-ops-data marker, then this checkout.
//
//   node data-root.mjs
import { getCareerOpsRoot } from './path-resolver.mjs';

console.log(getCareerOpsRoot());
