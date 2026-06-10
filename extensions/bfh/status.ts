import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { STEP_ORDER, type HarnessState } from "./types.ts";

type StatusContext = Pick<ExtensionContext, "ui">;

const STATUS_KEY = "bfh";
const BAR_WIDTH = 10;

function getStepProgress(state: HarnessState): { completedSteps: number; totalSteps: number; label: string } {
  const totalSteps = STEP_ORDER.length;

  if (state.currentStep === "done") {
    return { completedSteps: totalSteps, totalSteps, label: "done" };
  }

  if (state.currentStep === "failed") {
    return { completedSteps: totalSteps, totalSteps, label: "failed" };
  }

  const index = STEP_ORDER.indexOf(state.currentStep);
  const completedSteps = index >= 0 ? index + 1 : 1;
  return { completedSteps, totalSteps, label: state.currentStep };
}

function renderBar(completedSteps: number, totalSteps: number): string {
  const ratio = totalSteps > 0 ? completedSteps / totalSteps : 0;
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round(ratio * BAR_WIDTH)));
  return `${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}`;
}

export function isBfhWorkflowActive(state: HarnessState | undefined): state is HarnessState {
  return Boolean(state?.ticketKey && !["done", "failed"].includes(state.currentStep));
}

export function setBfhProgressStatus(ctx: StatusContext, state: HarnessState): void {
  if (!isBfhWorkflowActive(state)) {
    clearBfhProgressStatus(ctx);
    return;
  }

  const { completedSteps, totalSteps, label } = getStepProgress(state);
  const percent = Math.round((completedSteps / totalSteps) * 100);
  const bar = renderBar(completedSteps, totalSteps);
  const revision = `rev ${state.revisionCount}/${state.revisionLimit}`;

  ctx.ui.setStatus(
    STATUS_KEY,
    `BFH ${state.ticketKey} [${bar}] ${percent}% ${label} | ${revision}`,
  );
}

export function clearBfhProgressStatus(ctx: StatusContext): void {
  ctx.ui.setStatus(STATUS_KEY, undefined);
}
