/** Minimal JSONC to JSON without extra dependencies (line/block comments, trailing commas). */

function stripTrailingCommas(json: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let escaped = false;

  while (i < json.length) {
    const ch = json[i];

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }

    if (ch === ",") {
      let j = i + 1;
      while (j < json.length && /\s/.test(json[j]!)) j++;
      if (json[j] === "}" || json[j] === "]") {
        i++;
        continue;
      }
    }

    out += ch;
    i++;
  }

  return out;
}

/** Strip JSONC comments while preserving string contents. */
export function stripJsoncComments(input: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let escaped = false;

  while (i < input.length) {
    const ch = input[i];
    const next = input[i + 1];

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }

    if (ch === "/" && next === "/") {
      i += 2;
      while (i < input.length && jsoncNewline(input[i]!) === null) i++;
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i < input.length) {
        if (input[i] === "*" && input[i + 1] === "/") {
          i += 2;
          break;
        }
        i++;
      }
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

function jsoncNewline(ch: string): "\n" | "\r" | null {
  if (ch === "\n" || ch === "\r") return ch;
  return null;
}

export function parseJsonc(text: string): unknown {
  const withoutComments = stripJsoncComments(text);
  const withoutTrailingCommas = stripTrailingCommas(withoutComments);
  return JSON.parse(withoutTrailingCommas);
}
