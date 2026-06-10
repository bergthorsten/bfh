import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { KICKOFF_EDITOR_HINT } from "./prompts.ts";

export function deliverHarnessPrompt(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  prompt: string,
  options: { autoGo: boolean },
): void {
  if (options.autoGo || !ctx.hasUI) {
    pi.sendUserMessage(prompt);
    return;
  }

  ctx.ui.setEditorText(`${prompt}${KICKOFF_EDITOR_HINT}`);
  ctx.ui.notify(
    "Kickoff loaded in the editor. Add context with @files, then press Enter to start.",
    "info",
  );
}
