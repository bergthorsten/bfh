#!/usr/bin/env bun
import { runHarnessSelfTest } from "./selftest.ts";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

const cwd = mkdtempSync(join(tmpdir(), "lean-bfh-selftest-"));
const report = runHarnessSelfTest(cwd);
console.log(report);
