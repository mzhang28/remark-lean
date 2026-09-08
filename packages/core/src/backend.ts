import escapeHtml from "escape-html";
import type { Token, GoalPosition, DiagnosticPosition, DiagnosticSpan } from "./lib.ts";

/**
 * Prefixed to every line of `#eval` / `#check` output so results read as output
 * rather than as more source code.
 */
export const OUTPUT_MARKER = ">> ";

/** Blank lines stay blank so trailing newlines don't leave a dangling marker. */
const markOutputLines = (text: string): string =>
  text
    .split("\n")
    .map((line) => (line ? OUTPUT_MARKER + line : line))
    .join("\n");

export interface LeanHighlightBackend {
  /** The name of the backend (used for cache isolation). */
  readonly name: string;

  /** Capabilities supported by this backend. */
  readonly capabilities?: {
    hovers?: boolean;
    definitions?: boolean;
    goals?: boolean;
    diagnostics?: boolean;
  };

  /** Escape text for this backend. */
  escape(text: string): string;

  /** Wrap the entire highlighted block of code. */
  wrapBlock(content: string): string;

  /** Join highlighted lines together. */
  joinLines(lines: string[]): string;

  /** Render the start of a token span. */
  renderTokenStart(token: Token): string;

  /** Render the end of a token span. */
  renderTokenEnd(token: Token): string;

  /** Render a goal marker. */
  renderGoal?(goal: GoalPosition): string;

  /** Render a diagnostic marker. */
  renderDiagnostic?(diagnostic: DiagnosticPosition): string;

  /** Render the start of a squiggly diagnostic span. */
  renderSquigglyStart?(span: DiagnosticSpan): string;

  /** Render the end of a squiggly diagnostic span. */
  renderSquigglyEnd?(span: DiagnosticSpan): string;
}

export class HtmlBackend implements LeanHighlightBackend {
  readonly name: string = "html";

  readonly capabilities = {
    hovers: true,
    definitions: true,
    goals: true,
    diagnostics: true,
  };

  escape(text: string): string {
    return escapeHtml(text);
  }

  wrapBlock(content: string): string {
    return `<pre><code class="language-lean">${content}</code></pre>`;
  }

  joinLines(lines: string[]): string {
    return lines.join("\n");
  }

  renderTokenStart(token: Token): string {
    let dataAttr = "";
    if (token.groupId) dataAttr += ` data-symbol="${token.groupId}"`;
    if (token.hoverId) dataAttr += ` data-hover-id="${token.hoverId}"`;
    if (token.permalink) dataAttr += ` data-permalink="${escapeHtml(token.permalink)}"`;
    if (token.isDefinition) dataAttr += ` data-is-definition="true"`;

    const cls = token.type ? `lean-${token.type}` : "lean-hover-span";
    return `<span class="${cls}"${dataAttr}>`;
  }

  renderTokenEnd(token: Token): string {
    return "</span>";
  }

  renderGoal(goal: GoalPosition): string {
    return `<span class="lean-goal-marker" data-hover-id="${goal.hoverId}">…</span>`;
  }

  renderDiagnostic(diagnostic: DiagnosticPosition): string {
    const severityClass =
      diagnostic.severity === 1
        ? "lean-diagnostic-error"
        : diagnostic.severity === 2
        ? "lean-diagnostic-warning"
        : "lean-diagnostic-info";

    if (diagnostic.isEvalOrCheck) {
      const msgLines = diagnostic.message.split(/\r?\n/);
      const firstLine = msgLines[0] || "";
      const restLines = msgLines.slice(1).join("\n");

      if (restLines) {
        return `<details class="lean-diagnostic-details"><summary class="lean-diagnostic-summary" data-hover-id="${
          diagnostic.hoverId
        }">${escapeHtml(
          markOutputLines(firstLine)
        )}</summary><span class="lean-diagnostic-expanded">\n${escapeHtml(
          markOutputLines(restLines)
        )}</span></details>`;
      } else {
        return `<span class="lean-diagnostic-inline" data-hover-id="${
          diagnostic.hoverId
        }">${escapeHtml(markOutputLines(firstLine))}</span>`;
      }
    }

    return `<span class="lean-diagnostic-marker ${severityClass}" data-hover-id="${
      diagnostic.hoverId
    }">…</span>`;
  }

  renderSquigglyStart(span: DiagnosticSpan): string {
    const severityClass =
      span.severity === 1 ? "lean-squiggly-error" : "lean-squiggly-warning";
    const hoverAttr = span.hoverId
      ? ` data-hover-id="${span.hoverId}"`
      : "";
    return `<span class="${severityClass}"${hoverAttr}>`;
  }

  renderSquigglyEnd(span: DiagnosticSpan): string {
    return "</span>";
  }
}

export class TypstBackend implements LeanHighlightBackend {
  readonly name = "typst";

  readonly capabilities = {
    hovers: false,
    definitions: true,
    goals: false,
    diagnostics: false,
  };

  escape(text: string): string {
    if (!text) return "";
    const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `#raw("${escaped}")`;
  }

  wrapBlock(content: string): string {
    return `#block(
  fill: rgb("f5f5f5"),
  inset: 8pt,
  radius: 4pt,
  width: 100%,
  [
    #set text(font: ("Liberation Mono", "DejaVu Sans Mono", "Courier New", "Courier", "monospace"), size: 9pt)
    ${content}
  ]
)\n`;
  }

  joinLines(lines: string[]): string {
    return lines.join("#linebreak()\n");
  }

  renderTokenStart(token: Token): string {
    if (!token.type && !token.groupId && !token.permalink) {
      return '#raw("';
    }

    const attrs: string[] = [];
    if (token.type) {
      attrs.push(`type: "${token.type}"`);
    }
    if (token.groupId) {
      const id = token.groupId.replace(/-/g, "_");
      attrs.push(`id: "${id}"`);
      if (token.isDefinition) {
        attrs.push(`isDef: true`);
      }
    }
    if (token.permalink) {
      attrs.push(`link: "${token.permalink}"`);
    }

    return `#lean-token(${attrs.join(", ")})[#raw("`;
  }

  renderTokenEnd(token: Token): string {
    if (!token.type && !token.groupId && !token.permalink) {
      return '")';
    }
    return '")]';
  }
}

export class MarkdownBackend extends HtmlBackend {
  override readonly name = "markdown";
}

