import * as fs from "node:fs";
import * as path from "node:path";
import { ticketMarkerDir } from "./evidence-markers.ts";
import type { DifficultyLevel, HarnessState, HarnessStep } from "./types.ts";

export const METRICS_SCHEMA_VERSION = 1;

export type MetricsStepStats = {
  enterCount: number;
  wallMs: number;
  firstEnteredAt?: string;
  lastExitedAt?: string;
};

export type MetricsCounters = {
  bfhStateActions: Record<string, number>;
  commands: Record<string, number>;
  verifyReviewRuns: number;
  scoutRuns: number;
  implementLoops: number;
  closeLoops: number;
  prReviewLoops: number;
  clarifyRescoutLoops: number;
  designGateActions: number;
  humanGateEvents: number;
  resumeCount: number;
  markTested: number;
  closeAttempts: number;
  closeBlocked: number;
  closeSuccess: number;
  prSync: number;
  memoryUpdates: number;
  gateBlocks: number;
  transitionAttempts: number;
  transitionBlocked: number;
  subagentRuns: { scout: number; reviewer: number };
};

export type SubagentRoleMetrics = {
  runs: number;
  durationMs: number;
  failures: number;
  parseRetries?: number;
};

export type BfhMetrics = {
  schemaVersion: typeof METRICS_SCHEMA_VERSION;
  ticketKey: string;
  difficulty: DifficultyLevel;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  finalStep?: HarnessStep;
  finalVerdict?: HarnessState["finalVerdict"];
  wallTimeMs: number;
  openStep?: { step: HarnessStep; enteredAt: string };
  steps: Partial<Record<HarnessStep, MetricsStepStats>>;
  counters: MetricsCounters;
  humanWaitMs: {
    preImplement?: number;
    postReview?: number;
    preClose?: number;
    total: number;
  };
  subagent: {
    totalRuns: number;
    totalDurationMs: number;
    toolCalls: number;
    byRole: Record<string, SubagentRoleMetrics>;
  };
  models: string[];
  tokens?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  snapshot?: {
    currentStep: HarnessStep;
    revisionCount: number;
    humanRevisionCount: number;
    externalRevisionCount: number;
    designRevisionCount: number;
    evidenceCount: number;
    openQuestions: number;
  };
  startMeta?: {
    noJira?: boolean;
    autoGo?: boolean;
    source?: "bfh" | "resume";
  };
};

export type BfhMetricEvent =
  | {
      type: "run_started";
      at: string;
      difficulty: DifficultyLevel;
      step: HarnessStep;
      meta?: BfhMetrics["startMeta"];
    }
  | {
      type: "run_resumed";
      at: string;
      step: HarnessStep;
    }
  | {
      type: "step_enter";
      at: string;
      step: HarnessStep;
    }
  | {
      type: "step_exit";
      at: string;
      step: HarnessStep;
      wallMs: number;
    }
  | {
      type: "transition";
      at: string;
      from: HarnessStep;
      to: HarnessStep;
      allowed: boolean;
      reason?: string;
      trigger?: string;
    }
  | {
      type: "loop";
      at: string;
      kind: "implement" | "close" | "pr_review" | "clarify_rescout";
      from: HarnessStep;
      to: HarnessStep;
    }
  | {
      type: "bfh_action";
      at: string;
      action: string;
      step: HarnessStep;
      ok?: boolean;
      detail?: string;
    }
  | {
      type: "command";
      at: string;
      command: string;
      step: HarnessStep;
    }
  | {
      type: "human_gate";
      at: string;
      gate: string;
      decision: string;
      waitMs?: number;
      step: HarnessStep;
    }
  | {
      type: "design_gate";
      at: string;
      step: string;
      designStatus: string;
    }
  | {
      type: "subagent_run";
      at: string;
      role: "scout" | "reviewer";
      durationMs: number;
      exitCode: number;
      model?: string;
      toolCalls?: number;
      parseRetry?: boolean;
      stopReason?: string;
    }
  | {
      type: "gate_blocked";
      at: string;
      step: HarnessStep;
      action: string;
      reason: string;
    }
  | {
      type: "close_attempt";
      at: string;
      ok: boolean;
      reasons?: string[];
    }
  | {
      type: "model";
      at: string;
      model: string;
      context?: string;
    }
  | {
      type: "tokens";
      at: string;
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      context?: string;
    };

function createEmptyCounters(): MetricsCounters {
  return {
    bfhStateActions: {},
    commands: {},
    verifyReviewRuns: 0,
    scoutRuns: 0,
    implementLoops: 0,
    closeLoops: 0,
    prReviewLoops: 0,
    clarifyRescoutLoops: 0,
    designGateActions: 0,
    humanGateEvents: 0,
    resumeCount: 0,
    markTested: 0,
    closeAttempts: 0,
    closeBlocked: 0,
    closeSuccess: 0,
    prSync: 0,
    memoryUpdates: 0,
    gateBlocks: 0,
    transitionAttempts: 0,
    transitionBlocked: 0,
    subagentRuns: { scout: 0, reviewer: 0 },
  };
}

export function metricsFilePath(statePath: string): string {
  return path.join(ticketMarkerDir(statePath), "metrics.json");
}

export function eventsFilePath(statePath: string): string {
  return path.join(ticketMarkerDir(statePath), "events.jsonl");
}

function ensureTicketDir(statePath: string): void {
  fs.mkdirSync(ticketMarkerDir(statePath), { recursive: true });
}

function isoNow(): string {
  return new Date().toISOString();
}

function msBetween(startIso: string, endIso: string): number {
  const delta = Date.parse(endIso) - Date.parse(startIso);
  return Number.isFinite(delta) && delta > 0 ? delta : 0;
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function ensureStepStats(metrics: BfhMetrics, step: HarnessStep): MetricsStepStats {
  if (!metrics.steps[step]) {
    metrics.steps[step] = { enterCount: 0, wallMs: 0 };
  }
  return metrics.steps[step]!;
}

function closeOpenStep(metrics: BfhMetrics, at: string): void {
  if (!metrics.openStep) return;
  const stats = ensureStepStats(metrics, metrics.openStep.step);
  const wallMs = msBetween(metrics.openStep.enteredAt, at);
  stats.wallMs += wallMs;
  stats.lastExitedAt = at;
  delete metrics.openStep;
}

function openStep(metrics: BfhMetrics, step: HarnessStep, at: string): void {
  const stats = ensureStepStats(metrics, step);
  stats.enterCount += 1;
  if (!stats.firstEnteredAt) stats.firstEnteredAt = at;
  metrics.openStep = { step, enteredAt: at };
}

function trackModel(metrics: BfhMetrics, model?: string): void {
  const trimmed = model?.trim();
  if (!trimmed) return;
  if (!metrics.models.includes(trimmed)) metrics.models.push(trimmed);
}

function applyEvent(metrics: BfhMetrics, event: BfhMetricEvent): void {
  metrics.updatedAt = event.at;

  switch (event.type) {
    case "run_started":
      metrics.difficulty = event.difficulty;
      if (event.meta) metrics.startMeta = event.meta;
      if (!metrics.openStep) openStep(metrics, event.step, event.at);
      break;

    case "run_resumed":
      metrics.counters.resumeCount += 1;
      if (!metrics.openStep) openStep(metrics, event.step, event.at);
      break;

    case "step_enter":
      if (metrics.openStep?.step !== event.step) {
        closeOpenStep(metrics, event.at);
        openStep(metrics, event.step, event.at);
      }
      break;

    case "step_exit":
      if (metrics.openStep?.step === event.step) {
        const stats = ensureStepStats(metrics, event.step);
        stats.wallMs += event.wallMs;
        stats.lastExitedAt = event.at;
        delete metrics.openStep;
      }
      break;

    case "transition":
      metrics.counters.transitionAttempts += 1;
      if (!event.allowed) {
        metrics.counters.transitionBlocked += 1;
        return;
      }
      closeOpenStep(metrics, event.at);
      openStep(metrics, event.to, event.at);
      if (event.to === "done" || event.to === "failed") {
        metrics.completedAt = event.at;
        metrics.finalStep = event.to;
      }
      break;

    case "loop":
      if (event.kind === "implement") metrics.counters.implementLoops += 1;
      if (event.kind === "close") metrics.counters.closeLoops += 1;
      if (event.kind === "pr_review") metrics.counters.prReviewLoops += 1;
      if (event.kind === "clarify_rescout") metrics.counters.clarifyRescoutLoops += 1;
      break;

    case "bfh_action":
      bump(metrics.counters.bfhStateActions, event.action);
      if (event.action === "verify_review") metrics.counters.verifyReviewRuns += 1;
      if (event.action === "scout_auto") metrics.counters.scoutRuns += 1;
      if (event.action === "mark_tested") metrics.counters.markTested += 1;
      if (event.action === "pr_sync") metrics.counters.prSync += 1;
      if (event.action === "update_memory") metrics.counters.memoryUpdates += 1;
      break;

    case "command":
      bump(metrics.counters.commands, event.command);
      break;

    case "human_gate":
      metrics.counters.humanGateEvents += 1;
      if (typeof event.waitMs === "number" && event.waitMs > 0) {
        metrics.humanWaitMs.total += event.waitMs;
        if (event.gate === "pre_implement") {
          metrics.humanWaitMs.preImplement = (metrics.humanWaitMs.preImplement ?? 0) + event.waitMs;
        }
        if (event.gate === "pre_close") {
          metrics.humanWaitMs.preClose = (metrics.humanWaitMs.preClose ?? 0) + event.waitMs;
        }
        if (event.gate === "post_review") {
          metrics.humanWaitMs.postReview = (metrics.humanWaitMs.postReview ?? 0) + event.waitMs;
        }
      }
      break;

    case "design_gate":
      metrics.counters.designGateActions += 1;
      break;

    case "subagent_run": {
      metrics.subagent.totalRuns += 1;
      metrics.subagent.totalDurationMs += event.durationMs;
      if (event.toolCalls) metrics.subagent.toolCalls += event.toolCalls;
      const role = event.role;
      if (!metrics.subagent.byRole[role]) {
        metrics.subagent.byRole[role] = { runs: 0, durationMs: 0, failures: 0 };
      }
      const bucket = metrics.subagent.byRole[role]!;
      bucket.runs += 1;
      bucket.durationMs += event.durationMs;
      if (event.exitCode !== 0) bucket.failures += 1;
      if (event.parseRetry) bucket.parseRetries = (bucket.parseRetries ?? 0) + 1;
      metrics.counters.subagentRuns[role] += 1;
      trackModel(metrics, event.model);
      break;
    }

    case "gate_blocked":
      metrics.counters.gateBlocks += 1;
      break;

    case "close_attempt":
      metrics.counters.closeAttempts += 1;
      if (event.ok) metrics.counters.closeSuccess += 1;
      else metrics.counters.closeBlocked += 1;
      break;

    case "model":
      trackModel(metrics, event.model);
      break;

    case "tokens":
      metrics.tokens ??= { input: 0, output: 0 };
      metrics.tokens.input += event.input ?? 0;
      metrics.tokens.output += event.output ?? 0;
      metrics.tokens.cacheRead = (metrics.tokens.cacheRead ?? 0) + (event.cacheRead ?? 0);
      metrics.tokens.cacheWrite = (metrics.tokens.cacheWrite ?? 0) + (event.cacheWrite ?? 0);
      break;

    default:
      break;
  }
}

function refreshDerived(metrics: BfhMetrics, state?: HarnessState): void {
  const endIso = metrics.completedAt ?? metrics.updatedAt;
  metrics.wallTimeMs = msBetween(metrics.startedAt, endIso);

  if (state) {
    metrics.difficulty = state.difficulty;
    metrics.finalVerdict = state.finalVerdict;
    if (state.currentStep === "done" || state.currentStep === "failed") {
      metrics.finalStep = state.currentStep;
    }
    metrics.snapshot = {
      currentStep: state.currentStep,
      revisionCount: state.revisionCount,
      humanRevisionCount: state.humanRevisionCount,
      externalRevisionCount: state.pr.externalRevisionCount ?? 0,
      designRevisionCount: state.designReview.revisionCount,
      evidenceCount: state.evidence.length,
      openQuestions: state.openQuestions.length,
    };
  }
}

function loadMetrics(statePath: string): BfhMetrics | null {
  const file = metricsFilePath(statePath);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as BfhMetrics;
  } catch {
    return null;
  }
}

function writeMetrics(statePath: string, metrics: BfhMetrics): void {
  ensureTicketDir(statePath);
  fs.writeFileSync(metricsFilePath(statePath), `${JSON.stringify(metrics, null, 2)}\n`, "utf8");
}

function createMetrics(state: HarnessState, startedAt: string): BfhMetrics {
  return {
    schemaVersion: METRICS_SCHEMA_VERSION,
    ticketKey: state.ticketKey,
    difficulty: state.difficulty,
    startedAt,
    updatedAt: startedAt,
    wallTimeMs: 0,
    steps: {},
    counters: createEmptyCounters(),
    humanWaitMs: { total: 0 },
    subagent: { totalRuns: 0, totalDurationMs: 0, toolCalls: 0, byRole: {} },
    models: [],
  };
}

export function appendMetricEvent(
  statePath: string,
  event: BfhMetricEvent,
  state?: HarnessState,
): void {
  try {
    ensureTicketDir(statePath);
    fs.appendFileSync(eventsFilePath(statePath), `${JSON.stringify(event)}\n`, "utf8");

    const at = event.at;
    let metrics = loadMetrics(statePath);
    if (!metrics && state) {
      metrics = createMetrics(state, state.createdAt);
    }
    if (!metrics) return;

    applyEvent(metrics, event);
    refreshDerived(metrics, state);
    writeMetrics(statePath, metrics);
  } catch {
    // Metrics must never break the harness workflow.
  }
}

export function initHarnessMetrics(
  statePath: string,
  state: HarnessState,
  meta?: BfhMetrics["startMeta"],
): void {
  if (loadMetrics(statePath)) {
    syncMetricsSnapshot(statePath, state);
    return;
  }
  const at = state.createdAt;
  const metrics = createMetrics(state, at);
  metrics.startMeta = meta;
  refreshDerived(metrics, state);
  writeMetrics(statePath, metrics);
  appendMetricEvent(
    statePath,
    { type: "run_started", at, difficulty: state.difficulty, step: state.currentStep, meta },
    state,
  );
}

export function recordRunResumed(statePath: string, state: HarnessState): void {
  appendMetricEvent(statePath, { type: "run_resumed", at: isoNow(), step: state.currentStep }, state);
}

export function recordHarnessCommand(statePath: string, state: HarnessState, command: string): void {
  appendMetricEvent(statePath, { type: "command", at: isoNow(), command, step: state.currentStep }, state);
}

export function recordBfhAction(
  statePath: string,
  state: HarnessState,
  action: string,
  detail?: { ok?: boolean; detail?: string },
): void {
  appendMetricEvent(
    statePath,
    {
      type: "bfh_action",
      at: isoNow(),
      action,
      step: state.currentStep,
      ok: detail?.ok,
      detail: detail?.detail,
    },
    state,
  );
}

export function recordModelUse(statePath: string, model: string | undefined, context?: string): void {
  if (!model?.trim()) return;
  appendMetricEvent(statePath, { type: "model", at: isoNow(), model: model.trim(), context });
}

export function recordGateBlocked(
  statePath: string,
  state: HarnessState,
  action: string,
  reason: string,
): void {
  appendMetricEvent(
    statePath,
    { type: "gate_blocked", at: isoNow(), step: state.currentStep, action, reason },
    state,
  );
}

export function recordCloseAttempt(
  statePath: string,
  state: HarnessState,
  ok: boolean,
  reasons?: string[],
): void {
  appendMetricEvent(statePath, { type: "close_attempt", at: isoNow(), ok, reasons }, state);
}

export function recordHumanGate(
  statePath: string,
  state: HarnessState,
  gate: string,
  decision: string,
  waitMs?: number,
): void {
  appendMetricEvent(
    statePath,
    { type: "human_gate", at: isoNow(), gate, decision, waitMs, step: state.currentStep },
    state,
  );
}

export function recordDesignGate(statePath: string, state: HarnessState, step: string): void {
  appendMetricEvent(
    statePath,
    {
      type: "design_gate",
      at: isoNow(),
      step,
      designStatus: state.designReview.status,
    },
    state,
  );
}

export function recordSubagentRun(
  statePath: string,
  state: HarnessState | undefined,
  options: {
    role: "scout" | "reviewer";
    durationMs: number;
    exitCode: number;
    model?: string;
    toolCalls?: number;
    parseRetry?: boolean;
    stopReason?: string;
  },
): void {
  appendMetricEvent(
    statePath,
    {
      type: "subagent_run",
      at: isoNow(),
      role: options.role,
      durationMs: options.durationMs,
      exitCode: options.exitCode,
      model: options.model,
      toolCalls: options.toolCalls,
      parseRetry: options.parseRetry,
      stopReason: options.stopReason,
    },
    state,
  );
}

export function humanGateWaitMs(requestedAt?: string, decidedAt?: string): number | undefined {
  if (!requestedAt || !decidedAt) return undefined;
  const ms = msBetween(requestedAt, decidedAt);
  return ms > 0 ? ms : undefined;
}

function loopKind(
  from: HarnessStep,
  to: HarnessStep,
): "implement" | "close" | "pr_review" | "clarify_rescout" | undefined {
  if (from === "verify_review" && to === "implement") return "implement";
  if (from === "close" && to === "implement") return "close";
  if (from === "pr_review" && to === "implement") return "pr_review";
  if (from === "clarify" && to === "scout") return "clarify_rescout";
  return undefined;
}

export function recordHarnessTransition(
  statePath: string,
  state: HarnessState,
  from: HarnessStep,
  to: HarnessStep,
  options?: { allowed?: boolean; reason?: string; trigger?: string },
): void {
  const at = isoNow();
  const allowed = options?.allowed !== false;

  appendMetricEvent(
    statePath,
    { type: "transition", at, from, to, allowed, reason: options?.reason, trigger: options?.trigger },
    allowed ? state : undefined,
  );

  if (!allowed) return;

  const kind = loopKind(from, to);
  if (kind) {
    appendMetricEvent(
      statePath,
      { type: "loop", at, kind, from, to },
      state,
    );
  }
}

export function syncMetricsSnapshot(statePath: string, state: HarnessState): void {
  try {
    const metrics = loadMetrics(statePath);
    if (!metrics) return;
    refreshDerived(metrics, state);
    writeMetrics(statePath, metrics);
  } catch {
    // Non-fatal.
  }
}

export function readMetrics(statePath: string): BfhMetrics | null {
  return loadMetrics(statePath);
}

export function formatMetricsSummary(metrics: BfhMetrics): string {
  const loops =
    metrics.counters.implementLoops +
    metrics.counters.closeLoops +
    metrics.counters.prReviewLoops +
    metrics.counters.clarifyRescoutLoops;
  const humanMin = Math.round(metrics.humanWaitMs.total / 60_000);
  return [
    `Metrics: wall ${Math.round(metrics.wallTimeMs / 60_000)}m, human wait ${humanMin}m`,
    `Loops: implement ${metrics.counters.implementLoops}, close ${metrics.counters.closeLoops}, PR ${metrics.counters.prReviewLoops}`,
    `Reviews: ${metrics.counters.verifyReviewRuns}, scout: ${metrics.counters.scoutRuns}, subagents: ${metrics.subagent.totalRuns}`,
    `Gate blocks: ${metrics.counters.gateBlocks}, transitions blocked: ${metrics.counters.transitionBlocked}`,
  ].join(" · ");
}
