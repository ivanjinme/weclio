import { defaultUrlTransform, type Options as ReactMarkdownOptions } from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { resolveLocalFileHref } from "./file-links";

const markdownSanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [["className", /^language-./, "math-inline", "math-display"]],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "file"],
  },
  strip: [...(defaultSchema.strip || []), "iframe", "object", "style", "form"],
};

const allowedRawHtmlTags = new Set(defaultSchema.tagNames ?? []);
const htmlTagPattern = /<\/?([A-Za-z][A-Za-z0-9:._-]*)(?=[\s/>])/g;
const rawCodeOpenPattern = /<(code|pre|script|style)\b/i;

interface MarkdownAstNode {
  type: string;
  value?: string;
  lang?: string;
  url?: string;
  children?: MarkdownAstNode[];
  position?: { start: { line: number; column: number; offset?: number }; end: { line: number } };
}

/** 先用当前 Markdown 语法识别代码，仅在改写数学定界符后重新解析。 */
function remarkNormalizeDisplayMath(this: { parse(source: string): MarkdownAstNode }) {
  return (tree: MarkdownAstNode, file: { value: unknown; toString(): string }) => {
    const markdown = file.toString();
    if (!markdown.includes("\\(") && !markdown.includes("\\[") && !markdown.includes("$$")) return;

    const codeLines = new Set<number>();
    const displayBoundaries = new Set<number>();
    const rawHtmlStarts = new Map<number, number>();
    visitMarkdownNodes(tree, (node) => {
      if (!node.position) return;
      const { start, end } = node.position;
      if (node.type === "code" || node.type === "inlineCode") {
        // 缩进代码开头保留空白；围栏代码的位置从围栏标记开始。
        const indented = node.type === "code" && start.offset !== undefined && /^[ \t]/.test(markdown[start.offset]);
        for (let index = start.line - 1; index < end.line; index++) {
          codeLines.add(index);
          if (!indented) displayBoundaries.add(index);
        }
      } else if (node.type === "listItem" || node.type === "blockquote") {
        displayBoundaries.add(start.line - 1);
        displayBoundaries.add(end.line);
      } else if (node.type === "html" && node.value && rawCodeOpenPattern.test(node.value.split(/[\r\n]/, 1)[0])) {
        if (!rawHtmlStarts.has(start.line - 1)) rawHtmlStarts.set(start.line - 1, start.column - 1);
      }
    });

    const normalized = normalizeDisplayMath(markdown, codeLines, displayBoundaries, rawHtmlStarts);
    if (normalized === markdown) return;
    file.value = normalized;
    return this.parse(normalized);
  };
}

/** 在不放宽其他 URL 协议的前提下保留 Windows 绝对路径。 */
function remarkNormalizeWindowsFileLinks() {
  return (tree: MarkdownAstNode) => {
    visitMarkdownNodes(tree, (node) => {
      if (node.type !== "link" || !node.url || !/^[A-Za-z]:[\\/]/.test(node.url)) return;
      node.url = `file:///${node.url.replace(/\\/g, "/")}`;
    });
  };
}

/** Render custom XML-like tags as code instead of letting HTML sanitization hide them. */
function remarkPreserveUnknownXmlTags() {
  return (tree: MarkdownAstNode) => {
    visitMarkdownNodes(tree, (node) => {
      if (node.type !== "html" || !node.value || !containsUnknownHtmlTag(node.value)) return;

      if (node.value.includes("\n") || node.value.includes("\r")) {
        node.type = "code";
        node.lang = "xml";
      } else {
        node.type = "inlineCode";
      }
    });
  };
}

function visitMarkdownNodes(node: MarkdownAstNode, visitor: (node: MarkdownAstNode) => void): void {
  visitor(node);
  node.children?.forEach((child) => visitMarkdownNodes(child, visitor));
}

function containsUnknownHtmlTag(html: string): boolean {
  htmlTagPattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = htmlTagPattern.exec(html)) !== null) {
    if (!allowedRawHtmlTags.has(match[1].toLowerCase())) return true;
  }
  return false;
}

function normalizeDisplayMath(
  markdown: string,
  codeLines: ReadonlySet<number>,
  displayBoundaries: ReadonlySet<number>,
  rawHtmlStarts: ReadonlyMap<number, number>,
): string {
  const chunks = markdown.split(/(\r\n?|\n)/);
  const lines = chunks.filter((_, index) => index % 2 === 0);
  const normalized: string[] = [];
  let rawCodeTag: string | null = null;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];

    if (rawCodeTag) {
      normalized.push(line);
      if (new RegExp(`</${rawCodeTag}\\s*>`, "i").test(line)) rawCodeTag = null;
      continue;
    }

    // 同一行的 Markdown 代码不能开启 HTML 代码区，但真实标签仍然可以。
    const htmlStart = codeLines.has(index) ? rawHtmlStarts.get(index) : 0;
    const html = htmlStart === undefined ? "" : line.slice(htmlStart);
    const rawCodeOpen = html.match(rawCodeOpenPattern);
    if (rawCodeOpen) {
      const tag = rawCodeOpen[1].toLowerCase();
      const remainder = html.slice((rawCodeOpen.index ?? 0) + rawCodeOpen[0].length);
      if (!new RegExp(`</${tag}\\s*>`, "i").test(remainder)) rawCodeTag = tag;
    }
    if (rawCodeOpen || codeLines.has(index)) {
      normalized.push(line);
      continue;
    }

    const oneLineDisplay = line.match(/^( {0,3})\\\[[ \t]*(.+?)[ \t]*\\\][ \t]*$/)
      ?? line.match(/^([ \t]{0,3})\$\$(.+)\$\$[ \t]*$/);
    const displayMath = oneLineDisplay?.[2].trim();
    if (oneLineDisplay && displayMath) {
      const delimiter = `${oneLineDisplay[1]}$$`;
      const lineBreak = chunks[index * 2 + 1] ?? chunks[index * 2 - 1] ?? "\n";
      normalized.push([delimiter, displayMath, delimiter].join(lineBreak));
      continue;
    }

    const bracketDisplayStart = line.match(/^([ ]{0,3})\\\[[ \t]*$/);
    if (bracketDisplayStart) {
      const closingIndex = findBracketDisplayClose(lines, index + 1, displayBoundaries);
      if (closingIndex !== -1) {
        normalized.push(
          `${bracketDisplayStart[1]}$$`,
          ...lines.slice(index + 1, closingIndex),
          `${bracketDisplayStart[1]}$$`,
        );
        index = closingIndex;
        continue;
      }
    }

    normalized.push(normalizeInlineLatexMath(line));
  }

  return normalized.map((line, index) => line + (chunks[index * 2 + 1] ?? "")).join("");
}

function findBracketDisplayClose(lines: string[], startIndex: number, displayBoundaries: ReadonlySet<number>): number {
  for (let index = startIndex; index < lines.length; index++) {
    if (displayBoundaries.has(index)) return -1;
    const line = lines[index];
    if (/^ {0,3}\\\][ \t]*$/.test(line)) return index;

    // 不跨过代码或另一组起始定界符寻找闭合符号。
    if (
      /^ {0,3}\\\[[ \t]*$/.test(line) ||
      rawCodeOpenPattern.test(line)
    ) {
      return -1;
    }
  }

  return -1;
}

function normalizeInlineLatexMath(line: string): string {
  if (
    /^\s{0,3}\[[^\]]+\]:/.test(line) ||
    /<(?:!--|\/?[A-Za-z][^>]*>)/.test(line) ||
    /\b[A-Za-z]:\\/.test(line)
  ) {
    return line;
  }

  // Protect link destinations, not the entire line containing a citation.
  const protectedRanges: [number, number][] = [];
  for (const link of line.matchAll(/]\s*\(/g)) {
    let cursor = link.index + link[0].length;
    let depth = 1;
    while (cursor < line.length && depth > 0) {
      if (line[cursor] === "\\") {
        cursor += 2;
        continue;
      }
      if (line[cursor] === "(") depth++;
      else if (line[cursor] === ")") depth--;
      cursor++;
    }
    protectedRanges.push([link.index, cursor]);
  }
  for (const url of line.matchAll(/\b(?:https?|file|mailto):[^\s<>]+/gi)) {
    protectedRanges.push([url.index, url.index + url[0].length]);
  }

  return line.replace(
    /(?<!\\)\\\(([^`\r\n$]+?)(?<!\\)\\\)/g,
    (match, math: string, offset: number) => {
      if (protectedRanges.some(([start, end]) => offset < end && offset + match.length > start)) return match;
      return math.trim() ? `$${math}$` : match;
    },
  );
}

export function markdownUrlTransform(value: string): string {
  return resolveLocalFileHref(value) ? value : defaultUrlTransform(value);
}

export const markdownRemarkPlugins: NonNullable<ReactMarkdownOptions["remarkPlugins"]> = [
  remarkGfm,
  remarkMath,
  remarkNormalizeDisplayMath,
  remarkNormalizeWindowsFileLinks,
  remarkPreserveUnknownXmlTags,
];
export const markdownPreviewRemarkPlugins = markdownRemarkPlugins;

export const markdownRehypePlugins: ReactMarkdownOptions["rehypePlugins"] = [
  rehypeRaw,
  [rehypeSanitize, markdownSanitizeSchema],
  [rehypeKatex, { throwOnError: false, strict: false }],
];

export const markdownPreviewRehypePlugins: ReactMarkdownOptions["rehypePlugins"] = [
  rehypeRaw,
  [rehypeSanitize, markdownSanitizeSchema],
  [rehypeKatex, { throwOnError: false, strict: false }],
];
