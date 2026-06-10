import type { DesignReview, DifficultyLevel, HarnessState } from "./types.ts";

export const DEFAULT_DIFFICULTY: DifficultyLevel = 2;

const DIFFICULTY_LABELS: Record<DifficultyLevel, string> = {
  1: "easy (hands-off)",
  2: "medium (agent decides when to involve human)",
  3: "hard (mandatory design review before implement)",
};

export function parseDifficultyLevel(raw: string | undefined): DifficultyLevel | undefined {
  if (!raw) return undefined;
  const n = Number(raw.trim());
  if (n === 1 || n === 2 || n === 3) return n;
  return undefined;
}

export function difficultyLabel(level: DifficultyLevel): string {
  return DIFFICULTY_LABELS[level];
}

export function isHandsOffLevel(state: HarnessState): boolean {
  return state.difficulty === 1;
}

export function requiresMandatoryDesignReview(state: HarnessState): boolean {
  return state.difficulty === 3;
}

export function createInitialDesignReview(
  difficulty: DifficultyLevel,
  revisionLimit = 3,
): DesignReview {
  if (difficulty !== 3) {
    return {
      status: "not_applicable",
      options: [],
      revisionCount: 0,
      revisionLimit,
    };
  }
  return {
    status: "awaiting_options",
    options: [],
    revisionCount: 0,
    revisionLimit,
  };
}

/** Level 1: bypass internal human checkpoints (former --autonomous). */
export function applyHandsOffHumanBypass(state: HarnessState, reason: string): void {
  const now = new Date().toISOString();
  state.human.preImplement = {
    required: false,
    status: "not_needed",
    comment: reason,
    decidedAt: now,
  };
  state.human.preClose = {
    status: "approved",
    comment: reason,
    requestedAt: now,
    decidedAt: now,
  };
  state.human.postReview = {
    status: "not_needed",
    comment: reason,
    decidedAt: now,
  };
}

export function designReviewBlocksImplement(state: HarnessState): boolean {
  if (!requiresMandatoryDesignReview(state)) return false;
  return state.designReview.status !== "approved";
}

export function designReviewStatusLabel(state: HarnessState): string {
  if (!requiresMandatoryDesignReview(state)) return "n/a";
  return state.designReview.status;
}
