#!/usr/bin/env bun
/**
 * Validates sample harness state fixtures against bfh-state.schema.json (Ajv).
 */
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { initHarnessMetrics, readMetrics } from "./metrics.ts";
import { createState } from "./state.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCHEMA_PATH = path.join(ROOT, "bfh-state.schema.json");
const METRICS_SCHEMA_PATH = path.join(ROOT, "bfh-metrics.schema.json");

const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

const sample = createState({
  key: "PC-1",
  title: "Schema fixture",
  type: "task",
  status: "todo",
  description: "Acceptance criteria:\n- [ ] Tests pass",
  linkedTickets: [],
  labels: [],
});

if (!validate(sample)) {
  console.error("State fixture failed schema validation:");
  console.error(validate.errors);
  process.exit(1);
}

console.log("bfh-state.schema.json: OK (sample state validates)");

const metricsSchema = JSON.parse(fs.readFileSync(METRICS_SCHEMA_PATH, "utf8"));
const validateMetrics = ajv.compile(metricsSchema);
const metricsFixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "bfh-metrics-schema-"));
const metricsStatePath = path.join(metricsFixtureDir, "PC-1.state.json");
fs.writeFileSync(metricsStatePath, `${JSON.stringify(sample, null, 2)}\n`, "utf8");
initHarnessMetrics(metricsStatePath, sample, { source: "bfh" });
const metricsSample = readMetrics(metricsStatePath);
fs.rmSync(metricsFixtureDir, { recursive: true, force: true });

if (!metricsSample || !validateMetrics(metricsSample)) {
  console.error("Metrics fixture failed schema validation:");
  console.error(validateMetrics.errors);
  process.exit(1);
}

console.log("bfh-metrics.schema.json: OK (sample metrics validates)");
