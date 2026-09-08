import escapeHtml from "escape-html";

export interface Token {
  line: number;
  start: number;
  length: number;
  type: string;
  groupId?: string;
  hoverId?: string;
  permalink?: string;
  isDefinition?: boolean;
}

export interface QueryToken {
  line: number;
  startChar: number;
  length: number;
  word: string;
}

export interface DiscoveredToken {
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
  defUri: string | null;
  defLine: number | null;
  defChar: number | null;
  hoverText: string;
  permalink?: string;
}

export interface GoalPosition {
  character: number;
  hoverId: string;
}

export interface DiagnosticPosition {
  character: number;
  severity: number;
  message: string;
  hoverId: string;
  isEvalOrCheck?: boolean;
}

export interface DiagnosticSpan {
  startChar: number;
  endChar: number;
  severity: number;
  hoverId: string;
}

export interface LineEvent {
  index: number;
  kind: "start" | "end" | "goal" | "diagnostic" | "squiggly-start" | "squiggly-end";
  data: any;
  length?: number;
  id?: number;
}

/**
 * Generates a base-36 hash representation of a given string.
 */
export const hashString = (str: string): string =>
  Math.abs(
    Array.from(str).reduce(
      (hash, char) => ((hash << 5) - hash + char.charCodeAt(0)) | 0,
      0
    )
  ).toString(36);

/**
 * Extracts the hover Markdown text content from an LSP hover response.
 */
export const extractHoverText = (hoverRes: any): string => {
  const contents = hoverRes?.result?.contents;
  if (!contents) return "";
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) {
    return contents
      .map((c) => (typeof c === "string" ? c : c?.value || ""))
      .filter(Boolean)
      .join("\n\n");
  }
  return typeof contents === "object" && "value" in contents
    ? contents.value
    : "";
};

/**
 * Replaces anchor elements in HTML to ensure they open in a new tab/window.
 */
export const addTargetBlank = (html: string): string =>
  html.replace(/<a\b([^>]*)/gi, (match, p1) =>
    /target\s*=/i.test(p1)
      ? match
      : `<a${p1} target="_blank" rel="noopener noreferrer"`
  );

/**
 * Applies syntax highlighting matching `wordMap` metadata inside Lean code block elements.
 */
export const highlightGoalHtml = (
  html: string,
  words: Record<
    string,
    { type: string; groupId?: string; hoverId?: string; permalink?: string }
  >
): string =>
  html.replace(
    /<code class="language-lean">([\s\S]*?)<\/code>/g,
    (_, codeText) => {
      const entityOrIdentRegex =
        /&[a-zA-Z0-9#]+;|([a-zA-Z_α-ωΑ-Ω][a-zA-Z0-9_α-ωΑ-Ω']*)/g;
      const highlightedCode = codeText.replace(
        entityOrIdentRegex,
        (m: string, word: string | undefined) => {
          if (!word) return m;
          const info = words[word];
          if (!info) return word;

          const attrs = [
            info.groupId && `data-symbol="${info.groupId}"`,
            info.hoverId && `data-hover-id="${info.hoverId}"`,
            info.permalink && `data-permalink="${escapeHtml(info.permalink)}"`,
          ]
            .filter(Boolean)
            .join(" ");

          const dataAttr = attrs ? ` ${attrs}` : "";
          const cls = info.type ? `lean-${info.type}` : "lean-hover-span";
          return `<span class="${cls}"${dataAttr}>${word}</span>`;
        }
      );
      return `<code class="language-lean">${highlightedCode}</code>`;
    }
  );

interface SemanticTokensAcc {
  currentLine: number;
  currentCol: number;
  tokens: Token[];
}

/**
 * Parses raw LSP semantic token delta integers into structured Token objects.
 */
export const parseSemanticTokens = (
  data: number[],
  legend: string[],
  prependLines: number
): Token[] => {
  const chunks = Array.from({ length: Math.floor(data.length / 5) }, (_, i) =>
    data.slice(i * 5, i * 5 + 5)
  );

  return chunks.reduce<SemanticTokensAcc>(
    (acc, [deltaLine, deltaStartChar, length, tokenTypeIndex]) => {
      const newLine = acc.currentLine + deltaLine!;
      const newCol =
        deltaLine! > 0 ? deltaStartChar! : acc.currentCol + deltaStartChar!;
      const type = legend[tokenTypeIndex!] || "variable";

      if (newLine >= prependLines) {
        acc.tokens.push({
          line: newLine - prependLines,
          start: newCol,
          length: length!,
          type,
        });
      }

      acc.currentLine = newLine;
      acc.currentCol = newCol;
      return acc;
    },
    { currentLine: 0, currentCol: 0, tokens: [] }
  ).tokens;
};

/**
 * Finds Lean comments and returns them as `comment` tokens, one per line.
 *
 * Lean's LSP leaves comments out of its semantic tokens, so they have to be
 * recognized lexically: `--` runs to the end of the line, `/- -/` blocks nest
 * (covering `/-- -/` doc comments and `/-! -/` module docs) and may span lines,
 * and string literals are tracked so `"-- not a comment"` stays code.
 */
export const findCommentTokens = (lines: string[]): Token[] => {
  const tokens: Token[] = [];
  let blockDepth = 0;
  let inString = false;

  lines.forEach((lineText, line) => {
    const text = lineText || "";
    // Where the comment covering the current position began on this line; a
    // block comment carried over from an earlier line starts at column 0.
    let commentStart: number | null = blockDepth > 0 ? 0 : null;

    const emit = (end: number) => {
      if (commentStart !== null && end > commentStart) {
        tokens.push({
          line,
          start: commentStart,
          length: end - commentStart,
          type: "comment",
        });
      }
      commentStart = null;
    };

    let col = 0;
    while (col < text.length) {
      if (blockDepth > 0) {
        if (text.startsWith("-/", col)) {
          blockDepth--;
          col += 2;
          if (blockDepth === 0) emit(col);
        } else if (text.startsWith("/-", col)) {
          blockDepth++;
          col += 2;
        } else {
          col++;
        }
      } else if (inString) {
        if (text[col] === "\\") col += 2;
        else if (text[col] === '"') {
          inString = false;
          col++;
        } else col++;
      } else if (text.startsWith("--", col)) {
        commentStart = col;
        col = text.length;
        emit(col);
      } else if (text.startsWith("/-", col)) {
        blockDepth = 1;
        commentStart = col;
        col += 2;
      } else if (text[col] === '"') {
        inString = true;
        col++;
      } else {
        col++;
      }
    }

    // An unterminated block comment carries on to the next line.
    emit(text.length);
  });

  return tokens;
};

/**
 * Tokenizes lines of code to identify potential queryable word boundaries.
 */
export const extractQueryTokens = (lines: string[]): QueryToken[] =>
  lines.flatMap((lineText, lineIndex) => {
    if (!lineText) return [];
    const tokenizeRegex = /[a-zA-Z_α-ωΑ-Ω0-9']+|[^\s]/g;
    return Array.from(lineText.matchAll(tokenizeRegex)).map((match) => ({
      line: lineIndex,
      startChar: match.index!,
      length: match[0].length,
      word: match[0],
    }));
  });

/**
 * Merges discovered tokens covering the exact same span to avoid redundant tags.
 */
export const deduplicateDiscoveredTokens = (
  discovered: DiscoveredToken[]
): DiscoveredToken[] => {
  const tokenMap = discovered.reduce((map, d) => {
    const key = `${d.startLine}-${d.startChar}-${d.endLine}-${d.endChar}`;
    const existing = map.get(key);

    map.set(
      key,
      existing
        ? {
            ...existing,
            hoverText: existing.hoverText || d.hoverText,
            defUri: existing.defUri || d.defUri,
            defLine: existing.defUri ? existing.defLine : d.defLine,
            defChar: existing.defUri ? existing.defChar : d.defChar,
            permalink: existing.permalink || d.permalink,
          }
        : { ...d }
    );
    return map;
  }, new Map<string, DiscoveredToken>());

  return Array.from(tokenMap.values());
};

/**
 * Identifies character column positions in a line where Lean proof states should be queried.
 */
export const getGoalQueryPositions = (lineText: string): number[] => {
  const cleanText = lineText.split("--")[0]!.trimEnd();
  if (!cleanText) return [];

  const regex = /<;>|;/g;
  const matches = Array.from(cleanText.matchAll(regex));

  const positions = matches
    .map((match) => {
      const index = match.index!;
      return cleanText.substring(0, index).trimEnd().length;
    })
    .filter((pos) => pos > 0);

  const uniquePositions = Array.from(new Set(positions));

  const shouldAppendLength =
    !cleanText.endsWith("<;>") && !cleanText.endsWith(";");
  return shouldAppendLength
    ? [...uniquePositions, cleanText.length]
    : uniquePositions;
};

const splitTokenAt = (token: Token, pos: number): Token[] => {
  if (token.start < pos && pos < token.start + token.length) {
    return [
      { ...token, length: pos - token.start },
      { ...token, start: pos, length: token.length - (pos - token.start) },
    ];
  }
  return [token];
};

const splitTokensByMarker = (tokens: Token[], markerPos: number): Token[] =>
  tokens.flatMap((token) => splitTokenAt(token, markerPos));

/**
 * Generates and sorts start, end, goal marker, and squiggly annotation events for a single line of code.
 */
export const createAndSortLineEvents = (
  lineTokens: Token[],
  goals: GoalPosition[],
  diagnostics: DiagnosticPosition[] = [],
  squigglySpans: DiagnosticSpan[] = []
): LineEvent[] => {
  // Split tokens at all marker positions (goal/diagnostic markers AND squiggly span boundaries)
  const markerPositions = [
    ...goals.map((m) => m.character),
    ...diagnostics.map((m) => m.character),
    ...squigglySpans.flatMap((s) => [s.startChar, s.endChar]),
  ];
  const activeTokens = markerPositions.reduce(
    (tokens, pos) => splitTokensByMarker(tokens, pos),
    lineTokens
  );

  const tokenEvents = activeTokens.flatMap((token, i) => [
    {
      index: token.start,
      kind: "start" as const,
      data: token,
      length: token.length,
      id: i,
    },
    {
      index: token.start + token.length,
      kind: "end" as const,
      data: token,
      length: token.length,
      id: i,
    },
  ]);

  const goalEvents = goals.map((goal) => ({
    index: goal.character,
    kind: "goal" as const,
    data: goal,
  }));

  const diagEvents = diagnostics.map((diag) => ({
    index: diag.character,
    kind: "diagnostic" as const,
    data: diag,
  }));

  const squigglyEvents = squigglySpans.flatMap((span, i) => [
    {
      index: span.startChar,
      kind: "squiggly-start" as const,
      data: span,
      length: span.endChar - span.startChar,
      id: i,
    },
    {
      index: span.endChar,
      kind: "squiggly-end" as const,
      data: span,
      length: span.endChar - span.startChar,
      id: i,
    },
  ]);

  const allEvents = [...tokenEvents, ...goalEvents, ...diagEvents, ...squigglyEvents];

  const getPriority = (kind: string) => {
    // squiggly-end closes before regular ends so squiggly wraps inside tokens
    if (kind === "squiggly-end") return 0;
    if (kind === "end") return 1;
    if (kind === "goal" || kind === "diagnostic") return 2;
    if (kind === "squiggly-start") return 3;
    if (kind === "start") return 4;
    return 5;
  };

  return [...allEvents].sort((a, b) => {
    if (a.index !== b.index) return a.index - b.index;

    const pA = getPriority(a.kind);
    const pB = getPriority(b.kind);
    if (pA !== pB) return pA - pB;

    if (a.kind === "start" && b.kind === "start") {
      if (a.length !== b.length) return b.length! - a.length!;
      return a.id! - b.id!;
    }
    if (a.kind === "end" && b.kind === "end") {
      if (a.length !== b.length) return a.length! - b.length!;
      return b.id! - a.id!;
    }

    return 0;
  });
};
