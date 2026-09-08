import { spawn, execSync, type ChildProcess } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import escapeHtml from "escape-html";

import {
  type Token,
  type DiscoveredToken,
  type GoalPosition,
  type DiagnosticPosition,
  type DiagnosticSpan,
  parseSemanticTokens,
  findCommentTokens,
  extractQueryTokens,
  deduplicateDiscoveredTokens,
  getGoalQueryPositions,
  createAndSortLineEvents,
  extractHoverText,
  addTargetBlank,
  highlightGoalHtml,
  hashString,
} from "./lib.ts";
import { type LeanHighlightBackend, HtmlBackend } from "./backend.ts";

/** Max time to wait for Lean to finish processing a temp file before highlighting. */
const COMPILE_TIMEOUT_MS = 30_000;

/** Max time to wait for a single LSP request/response before rejecting. */
const REQUEST_TIMEOUT_MS = 60_000;

interface PendingRequest {
  resolve: (res: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface LeanHighlightResult {
  html: string;
  /** False when highlighting ran before `$/lean/fileProgress` reported completion. */
  compileComplete: boolean;
}

export class LeanLSPClient {
  private proc: ChildProcess | null = null;
  private initPromise: Promise<void> | null = null;
  private buffer = Buffer.alloc(0);
  private nextRequestId = 1;
  private pendingRequests = new Map<number, PendingRequest>();
  private compileWaiters = new Map<string, () => void>();
  private diagnosticsMap = new Map<string, any[]>();
  private legend: string[] = [];

  private projectPath: string;
  constructor(projectPath: string) {
    this.projectPath = projectPath;
  }

  start(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      this.proc = spawn("lake", ["serve"], { cwd: this.projectPath });

      this.proc.stdout!.on("data", (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.parseMessages();
      });

      this.proc.on("error", (err) => {
        const e = err instanceof Error ? err : new Error(String(err));
        // ENOENT here means `lake` isn't on PATH — the most common setup
        // mistake. Turn the cryptic "spawn lake ENOENT" into actionable text.
        const friendly =
          (e as NodeJS.ErrnoException).code === "ENOENT"
            ? new Error(
                "leandown: could not launch `lake`. Lean 4 must be installed " +
                  "and on your PATH. Install it via elan: https://lean-lang.org/install/"
              )
            : e;
        console.error("Lean LSP Process Error:", friendly.message);
        this.failAllPending(friendly);
      });

      this.proc.on("exit", (code, signal) => {
        this.failAllPending(
          new Error(`Lean LSP process exited (code ${code}, signal ${signal})`)
        );
      });

      const initRes = await this.sendRequest("initialize", {
        processId: process.pid,
        rootUri: pathToFileURL(this.projectPath).href,
        capabilities: {
          textDocument: {
            semanticTokens: {
              requests: { full: true },
              tokenTypes: [
                "keyword",
                "variable",
                "property",
                "function",
                "namespace",
                "type",
                "class",
                "enum",
                "interface",
                "struct",
                "typeParameter",
                "parameter",
                "enumMember",
                "event",
                "method",
                "macro",
                "modifier",
                "comment",
                "string",
                "number",
                "regexp",
                "operator",
                "decorator",
                "leanSorryLike",
              ],
              tokenModifiers: [],
            },
          },
        },
      });

      this.legend =
        initRes.result?.capabilities?.semanticTokensProvider?.legend
          ?.tokenTypes || [];
      this.sendNotification("initialized", {});
    })();
    return this.initPromise;
  }

  async highlight(
    content: string,
    options: {
      synchronizedHovers?: boolean;
      prependCode?: string;
      compileMarkdown?: (markdown: string) => Promise<string> | string;
      backend?: LeanHighlightBackend;
    }
  ): Promise<LeanHighlightResult> {
    if (!this.proc) {
      await this.start();
    }

    const { compileMarkdown } = options;
    const backend = options.backend ?? new HtmlBackend();
    const caps = backend.capabilities ?? {
      hovers: true,
      definitions: true,
      goals: true,
      diagnostics: true,
    };

    const runHovers = (options.synchronizedHovers ?? true) && !!caps.hovers;
    const runDefinitions = (options.synchronizedHovers ?? true) && !!caps.definitions;
    const runGoals = (options.synchronizedHovers ?? true) && !!caps.goals;
    const runDiagnostics = (options.synchronizedHovers ?? true) && !!caps.diagnostics;

    const wordMap = new Map<
      string,
      { type: string; groupId?: string; hoverId?: string; permalink?: string }
    >();
    const fileId = Math.random().toString(36).substring(7);
    const tempFilePath = path.join(this.projectPath, `__temp_lean_highlight_${fileId}__.lean`);
    const tempFileUri = pathToFileURL(tempFilePath).href;

    let prependCode = options.prependCode || "";
    if (prependCode && !prependCode.endsWith("\n")) {
      prependCode += "\n";
    }
    const prependLines = (prependCode.match(/\n/g) || []).length;
    const fullContent = prependCode + content;

    this.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: tempFileUri,
        languageId: "lean",
        version: 1,
        text: fullContent,
      },
    });

    try {
    let compileComplete = false;
    // Wait for `$/lean/fileProgress` completion, or fall back to a timeout.
    // Both the waiter map entry and the timer are cleaned up once settled so
    // neither leaks (the timer would otherwise keep the event loop alive).
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.compileWaiters.delete(tempFileUri);
        resolve();
      };
      const timer = setTimeout(done, COMPILE_TIMEOUT_MS);
      this.compileWaiters.set(tempFileUri, () => {
        compileComplete = true;
        done();
      });
    });

    const tokensRes = await this.sendRequest(
      "textDocument/semanticTokens/full",
      {
        textDocument: { uri: tempFileUri },
      }
    );

    const data: number[] = tokensRes.result?.data || [];
    const tokens = parseSemanticTokens(data, this.legend, prependLines);

    const lines = content.split("\n");

    const hoverHtmlToId = new Map<string, string>();
    const hoverMap: Record<string, string> = {};
    let hoverIdCounter = 1;

    if (runDefinitions || runHovers) {
      const tempFileName = tempFileUri.split("/").pop();
      const queryTokens = extractQueryTokens(lines);

      const results = await Promise.all(
        queryTokens.map(async (qt) => {
          const [defRes, hoverRes] = await Promise.all([
            runDefinitions
              ? this.sendRequest("textDocument/definition", {
                  textDocument: { uri: tempFileUri },
                  position: {
                    line: qt.line + prependLines,
                    character: qt.startChar,
                  },
                }).catch(() => null)
              : null,
            runHovers
              ? this.sendRequest("textDocument/hover", {
                  textDocument: { uri: tempFileUri },
                  position: {
                    line: qt.line + prependLines,
                    character: qt.startChar,
                  },
                }).catch(() => null)
              : null,
          ]);
          return { qt, defRes, hoverRes };
        })
      );

      const discovered: DiscoveredToken[] = [];

      for (const { qt, defRes, hoverRes } of results) {
        let hoverText = "";
        let hoverRange: any = null;

        if (hoverRes && hoverRes.result) {
          hoverText = extractHoverText(hoverRes);
          if (hoverRes.result.range) {
            hoverRange = hoverRes.result.range;
          }
        }

        let defUri = null;
        let defLine = null;
        let defChar = null;

        if (defRes && defRes.result) {
          const defs: any[] = Array.isArray(defRes.result)
            ? defRes.result
            : [defRes.result];
          if (defs.length > 0) {
            const def = defs[0];
            const uri = def.targetUri || def.uri;
            const range =
              def.targetSelectionRange || def.targetRange || def.range;
            if (uri && range) {
              defUri = uri;
              defLine = range.start.line;
              defChar = range.start.character;
            }
          }
        }

        let permalink: string | undefined;
        if (defUri && defLine !== null) {
          const isLocal = defUri.includes("__temp_lean_highlight_");
          if (!isLocal) {
            permalink = getPermalinkForUri(defUri, defLine);
          }
        }

        if (hoverText || defUri) {
          const startL = hoverRange
            ? hoverRange.start.line - prependLines
            : qt.line;
          const startC = hoverRange ? hoverRange.start.character : qt.startChar;
          const endL = hoverRange
            ? hoverRange.end.line - prependLines
            : qt.line;
          const endC = hoverRange
            ? hoverRange.end.character
            : qt.startChar + qt.length;

          discovered.push({
            startLine: startL,
            startChar: startC,
            endLine: endL,
            endChar: endC,
            defUri,
            defLine,
            defChar,
            hoverText,
            permalink,
          });
        }
      }

      const uniqueTokens = deduplicateDiscoveredTokens(discovered);

      for (const u of uniqueTokens) {
        if (u.hoverText) {
          const compiled = compileMarkdown
            ? await compileMarkdown(u.hoverText)
            : u.hoverText;
          const hoverHtml = addTargetBlank(String(compiled).trim());

          let id = hoverHtmlToId.get(hoverHtml);
          if (!id) {
            id = `h${hoverIdCounter++}`;
            hoverHtmlToId.set(hoverHtml, id);
            hoverMap[id] = hoverHtml;
          }
          (u as any).hoverId = id;
        }
      }

      for (const ut of uniqueTokens) {
        let groupId = "";
        if (ut.defLine !== null && ut.defChar !== null && ut.defUri !== null) {
          if (ut.defUri.includes("__temp_lean_highlight_")) {
            groupId = `ref-${ut.defLine}-${ut.defChar}`;
          } else {
            const uriHash = hashString(ut.defUri);
            groupId = `ref-ext-${uriHash}-${ut.defLine}-${ut.defChar}`;
          }
        }

        const utHoverId = (ut as any).hoverId;

        for (let l = ut.startLine; l <= ut.endLine; l++) {
          if (l < 0 || l >= lines.length) continue;
          const sChar = l === ut.startLine ? ut.startChar : 0;
          const eChar =
            l === ut.endLine ? ut.endChar : (lines[l] || "").length;

          if (eChar > sChar) {
            const existing = tokens.find(
              (t) =>
                t.line === l &&
                t.start === sChar &&
                t.length === eChar - sChar
            );
            const isDef = !!(
              tempFileName &&
              ut.defUri &&
              ut.defUri.endsWith(tempFileName) &&
              ut.defLine !== null &&
              ut.defLine - prependLines === l &&
              ut.defChar !== null &&
              ut.defChar >= sChar &&
              ut.defChar < eChar
            );
            if (existing) {
              if (groupId) existing.groupId = groupId;
              if (utHoverId) existing.hoverId = utHoverId;
              if (ut.permalink) existing.permalink = ut.permalink;
              if (isDef) existing.isDefinition = true;
            } else {
              tokens.push({
                line: l,
                start: sChar,
                length: eChar - sChar,
                type: "hover-span",
                groupId,
                hoverId: utHoverId,
                permalink: ut.permalink,
                isDefinition: isDef,
              });
            }

            const word = (lines[l] || "").substring(sChar, eChar);
            if (
              !wordMap.has(word) ||
              (utHoverId && !wordMap.get(word)?.hoverId)
            ) {
              wordMap.set(word, {
                type: existing ? existing.type : "hover-span",
                groupId,
                hoverId: utHoverId,
                permalink: ut.permalink,
              });
            }
          }
        }
      }
    }

    // Comments come from our own lexer rather than the LSP. Skip any that would
    // partially overlap a token the server reported, since interleaved spans
    // would render as mis-nested markup.
    for (const comment of findCommentTokens(lines)) {
      const commentEnd = comment.start + comment.length;
      const interleaves = tokens.some((t) => {
        if (t.line !== comment.line) return false;
        const tEnd = t.start + t.length;
        if (t.start >= commentEnd || comment.start >= tEnd) return false;
        const nested =
          (t.start <= comment.start && tEnd >= commentEnd) ||
          (comment.start <= t.start && commentEnd >= tEnd);
        return !nested;
      });
      if (!interleaves) tokens.push(comment);
    }

    const lineGoals = new Map<number, GoalPosition[]>();
    if (runGoals) {
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const lineText = lines[lineIndex] || "";
        if (!lineText.trim()) continue;

        // Find all query positions for this line
        const positions = getGoalQueryPositions(lineText);

        const rawGoalsList = await Promise.all(
          positions.map(async (pos) => {
            const goalRes = await this.sendRequest("$/lean/plainGoal", {
              textDocument: { uri: tempFileUri },
              position: { line: lineIndex + prependLines, character: pos },
            });

            if (goalRes && goalRes.result) {
              const rawGoal = goalRes.result.rendered || "";
              if (rawGoal) {
                const compiled = compileMarkdown
                  ? await compileMarkdown(rawGoal)
                  : rawGoal;
                const targetBlankHtml = addTargetBlank(
                  String(compiled).trim()
                );
                
                let id = hoverHtmlToId.get(targetBlankHtml);
                if (!id) {
                  id = `h${hoverIdCounter++}`;
                  hoverHtmlToId.set(targetBlankHtml, id);
                  hoverMap[id] = targetBlankHtml;
                }
                return {
                  character: pos,
                  hoverId: id,
                };
              }
            }
            return null;
          })
        );
        const goalsList: GoalPosition[] = rawGoalsList.filter(
          (goal): goal is GoalPosition => goal !== null
        );

        if (goalsList.length > 0) {
          lineGoals.set(lineIndex, goalsList);
        }
      }
    }

    const diagnostics = this.diagnosticsMap.get(tempFileUri) || [];

    const localDiagnostics = diagnostics.filter((d) => {
      const line = d.range.start.line - prependLines;
      return line >= 0 && line < lines.length;
    });

    const diagnosticsByLine = new Map<number, any[]>();
    for (const d of localDiagnostics) {
      const lineIndex = d.range.start.line - prependLines;
      if (!diagnosticsByLine.has(lineIndex)) {
        diagnosticsByLine.set(lineIndex, []);
      }
      diagnosticsByLine.get(lineIndex)!.push(d);
    }

    const lineDiagnostics = new Map<number, DiagnosticPosition[]>();
    if (runDiagnostics) {
      for (const [lineIndex, diags] of diagnosticsByLine.entries()) {
        // Only include diagnostics of severity > 2 (info/hint) for the line-end '…' markers
        const infoDiags = diags.filter((d) => d.severity > 2);
        if (infoDiags.length === 0) continue;

        const lineText = lines[lineIndex] || "";
        const pos = lineText.length;

        // Determine highest severity
        const highestSeverity = Math.min(...infoDiags.map((d) => d.severity));

        // Combine messages
        const combinedMessage = infoDiags.map((d) => d.message).join("\n\n---\n\n");

        const markdownMessage = "```lean\n" + combinedMessage + "\n```";
        const compiled = compileMarkdown
          ? await compileMarkdown(markdownMessage)
          : markdownMessage;
        const targetBlankHtml = addTargetBlank(String(compiled).trim());
        
        let id = hoverHtmlToId.get(targetBlankHtml);
        if (!id) {
          id = `h${hoverIdCounter++}`;
          hoverHtmlToId.set(targetBlankHtml, id);
          hoverMap[id] = targetBlankHtml;
        }

        const isEvalOrCheck = /^\s*(#eval|#check)\b/.test(lineText);

        lineDiagnostics.set(lineIndex, [
          {
            character: pos,
            severity: highestSeverity,
            message: combinedMessage,
            hoverId: id,
            isEvalOrCheck,
          },
        ]);
      }
    }

    // Build squiggly annotation spans from actual LSP diagnostic ranges (errors + warnings only)
    const squigglySpansByLine = new Map<number, DiagnosticSpan[]>();
    if (runDiagnostics) {
      for (const d of localDiagnostics) {
        if (d.severity > 2) continue; // severity 1 = error, 2 = warning

        const dStartLine = d.range.start.line - prependLines;
        const dEndLine = d.range.end.line - prependLines;

        const markdownMessage = "```lean\n" + d.message + "\n```";
        const compiled = compileMarkdown
          ? await compileMarkdown(markdownMessage)
          : markdownMessage;
        const targetBlankHtml = addTargetBlank(String(compiled).trim());
        
        let id = hoverHtmlToId.get(targetBlankHtml);
        if (!id) {
          id = `h${hoverIdCounter++}`;
          hoverHtmlToId.set(targetBlankHtml, id);
          hoverMap[id] = targetBlankHtml;
        }

        for (
          let l = Math.max(dStartLine, 0);
          l <= Math.min(dEndLine, lines.length - 1);
          l++
        ) {
          const lineLen = (lines[l] || "").length;
          const sc = l === dStartLine ? d.range.start.character : 0;
          const ec =
            l === dEndLine
              ? Math.min(d.range.end.character, lineLen)
              : lineLen;
          if (sc >= ec) continue;

          if (!squigglySpansByLine.has(l)) squigglySpansByLine.set(l, []);
          squigglySpansByLine.get(l)!.push({
            startChar: sc,
            endChar: ec,
            severity: d.severity,
            hoverId: id,
          });
        }
      }
    }

    const highlightedLines = lines.map((lineText, lineIndex) => {
      const lineTokens = tokens.filter((t) => t.line === lineIndex);

      const goals = lineGoals.get(lineIndex) || [];
      const diags = lineDiagnostics.get(lineIndex) || [];
      const squigglySpans = squigglySpansByLine.get(lineIndex) || [];
      const events = createAndSortLineEvents(lineTokens, goals, diags, squigglySpans);

      let formatted = "";
      let lastIndex = 0;

      for (const event of events) {
        if (event.index > lastIndex) {
          formatted += backend.escape(lineText.substring(lastIndex, event.index));
          lastIndex = event.index;
        }

        if (event.kind === "start") {
          formatted += backend.renderTokenStart(event.data);
        } else if (event.kind === "end") {
          formatted += backend.renderTokenEnd(event.data);
        } else if (event.kind === "goal") {
          if (backend.renderGoal) {
            formatted += backend.renderGoal(event.data);
          }
        } else if (event.kind === "diagnostic") {
          if (backend.renderDiagnostic) {
            formatted += backend.renderDiagnostic(event.data);
          }
        } else if (event.kind === "squiggly-start") {
          if (backend.renderSquigglyStart) {
            formatted += backend.renderSquigglyStart(event.data);
          }
        } else if (event.kind === "squiggly-end") {
          if (backend.renderSquigglyEnd) {
            formatted += backend.renderSquigglyEnd(event.data);
          }
        }
      }

      if (lastIndex < lineText.length) {
        formatted += backend.escape(lineText.substring(lastIndex));
      }

      return formatted;
    });

    const wordsObj: Record<string, any> = {};
    for (const [word, info] of wordMap.entries()) {
      wordsObj[word] = {
        type: info.type,
        groupId: info.groupId,
        hoverId: info.hoverId,
        permalink: info.permalink,
      };
    }

    const registry = {
      hovers: hoverMap,
      words: wordsObj,
    };

    const codeHtml = backend.joinLines
      ? backend.joinLines(highlightedLines)
      : highlightedLines.join("\n");

    if (backend.capabilities?.hovers) {
      const hoverDataScript = `<script type="application/json" class="lean-hover-data">${JSON.stringify(
        registry
      )}</script>`;
      return { html: codeHtml + hoverDataScript, compileComplete };
    }

    return { html: codeHtml, compileComplete };
    } finally {
      // Always tell the server to close the document and drop per-URI state,
      // even if a request rejected partway through — otherwise the document
      // stays open server-side and diagnosticsMap/compileWaiters entries leak.
      try {
        this.sendNotification("textDocument/didClose", {
          textDocument: { uri: tempFileUri },
        });
      } catch {
        // process may have already exited; nothing more to clean up on the wire
      }
      this.diagnosticsMap.delete(tempFileUri);
      this.compileWaiters.delete(tempFileUri);
    }
  }

  async shutdown(): Promise<void> {
    if (this.proc) {
      try {
        await this.sendRequest("shutdown", null);
        this.sendNotification("exit", {});
      } catch (e) {
        // process might have already exited
      }
      this.killSync();
    }
  }

  /**
   * Synchronously terminate the child process. Safe to call from `exit`/signal
   * handlers where async `shutdown()` can't complete. Rejects/settles anything
   * still in flight so no promise, timer, or child process is left dangling.
   */
  killSync(): void {
    this.failAllPending(new Error("Lean LSP client terminated"));
    for (const resolve of this.compileWaiters.values()) resolve();
    this.compileWaiters.clear();
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }

  /** Reject every in-flight request and clear its timeout. */
  private failAllPending(err: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pendingRequests.clear();
  }

  private sendRequest(method: string, params: any): Promise<any> {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingRequests.delete(id)) {
          reject(new Error(`LSP request timed out: ${method} (id ${id})`));
        }
      }, REQUEST_TIMEOUT_MS);
      // Don't let a pending request keep the process alive on its own.
      timer.unref?.();
      this.pendingRequests.set(id, { resolve, reject, timer });
      const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      const message = `Content-Length: ${Buffer.byteLength(
        payload,
        "utf8"
      )}\r\n\r\n${payload}`;
      try {
        this.proc!.stdin!.write(message);
      } catch (err) {
        this.pendingRequests.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private sendNotification(method: string, params: any) {
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params });
    const message = `Content-Length: ${Buffer.byteLength(
      payload,
      "utf8"
    )}\r\n\r\n${payload}`;
    this.proc!.stdin!.write(message);
  }

  private parseMessages() {
    while (true) {
      const headerIndex = this.buffer.indexOf("\r\n\r\n");
      if (headerIndex === -1) break;

      const headerText = this.buffer
        .subarray(0, headerIndex)
        .toString("ascii");
      const contentLengthMatch = /Content-Length:\s*(\d+)/i.exec(headerText);
      if (!contentLengthMatch || !contentLengthMatch[1]) {
        this.buffer = this.buffer.subarray(headerIndex + 4);
        continue;
      }

      const contentLength = parseInt(contentLengthMatch[1], 10);
      const messageStart = headerIndex + 4;
      if (this.buffer.length < messageStart + contentLength) {
        break;
      }

      const messageJson = this.buffer
        .subarray(messageStart, messageStart + contentLength)
        .toString("utf8");
      this.buffer = this.buffer.subarray(messageStart + contentLength);

      try {
        const msg = JSON.parse(messageJson);
        if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
          const pending = this.pendingRequests.get(msg.id)!;
          this.pendingRequests.delete(msg.id);
          clearTimeout(pending.timer);
          pending.resolve(msg);
        } else if (msg.method === "$/lean/fileProgress") {
          const { uri } = msg.params.textDocument;
          const processing = msg.params.processing;
          if (processing.length === 0) {
            const resolveFn = this.compileWaiters.get(uri);
            if (resolveFn) {
              this.compileWaiters.delete(uri);
              resolveFn();
            }
          }
        } else if (msg.method === "textDocument/publishDiagnostics") {
          const { uri, diagnostics } = msg.params;
          this.diagnosticsMap.set(uri, diagnostics);
        }
      } catch (e) {
        console.error("Error parsing LSP message", e);
      }
    }
  }
}

let leanVersion: string | null = null;
function getLeanVersion(): string {
  if (leanVersion !== null) return leanVersion;
  try {
    const output = execSync("lean --version", { encoding: "utf8" });
    const match = output.match(/version\s+([v0-9.]+)/i);
    if (match && match[1]) {
      leanVersion = match[1].startsWith("v") ? match[1] : `v${match[1]}`;
      return leanVersion;
    }
  } catch (e) {}
  leanVersion = "master";
  return leanVersion;
}

function getPermalinkForUri(uri: string, line: number): string | undefined {
  // Convert backslashes to forward slashes for unified regex matching
  const normalizedUri = uri.replace(/\\/g, "/");

  // 1. Check if it is a standard library file (matches "/src/lean/" followed by Init, Lean, Std, or lake)
  const stdlibMatch = normalizedUri.match(
    /\/src\/lean\/((?:Init|Lean|Std|lake)\/.+)$/i
  );
  if (stdlibMatch) {
    const relativePath = stdlibMatch[1];

    // Attempt to extract version from elan toolchain folder name first
    let version = "master";
    const elanMatch = normalizedUri.match(
      /\/toolchains\/([^/#?]+)\/src\/lean\//i
    );
    if (elanMatch && elanMatch[1]) {
      const folderName = elanMatch[1];
      if (folderName.includes("---")) {
        version = folderName.split("---").pop()!;
      } else if (folderName.includes(":")) {
        version = folderName.split(":").pop()!;
      } else {
        version = folderName;
      }
    } else {
      // Fallback to active Lean compiler version
      version = getLeanVersion();
    }

    return `https://github.com/leanprover/lean4/blob/${version}/src/${relativePath}#L${
      line + 1
    }`;
  }

  // 2. Check local git repositories (separate packages)
  try {
    const filePath = fileURLToPath(uri);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) return undefined;

    // Check if it's inside a git repository
    const isGit = execSync("git rev-parse --is-inside-work-tree", {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    if (isGit === "true") {
      const gitRoot = execSync("git rev-parse --show-toplevel", {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();

      const remoteUrl = execSync("git config --get remote.origin.url", {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();

      if (remoteUrl) {
        let cleanedUrl = remoteUrl.trim();
        if (cleanedUrl.endsWith(".git")) {
          cleanedUrl = cleanedUrl.slice(0, -4);
        }
        const githubRegex = /github\.com[:\\/]([^\\/]+)\/(.+)$/i;
        const match = cleanedUrl.match(githubRegex);
        if (match) {
          const owner = match[1];
          const repo = match[2];
          const githubUrl = `https://github.com/${owner}/${repo}`;

          // Get commit SHA
          const commit = execSync("git rev-parse HEAD", {
            cwd: dir,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          }).trim();

          // Get relative path of the file from the git root
          const relativePath = path
            .relative(gitRoot, filePath)
            .replace(/\\/g, "/");

          return `${githubUrl}/blob/${commit}/${relativePath}#L${line + 1}`;
        }
      }
    }
  } catch (e) {
    // If any git command fails, just ignore and return undefined
  }
  return undefined;
}
