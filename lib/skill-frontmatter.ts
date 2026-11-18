import { isDeepStrictEqual } from "node:util";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

const KEY = "disable-model-invocation";
const DELIMITER = /^---(?:\r\n|\r|\n|$)$/;
const KEY_LINE = new RegExp(`^((?:${KEY}|"${KEY}"|'${KEY}')[ \\t]*:[ \\t]*)(?:true|True|TRUE|false|False|FALSE)([ \\t]+#[^\\r\\n]*|[ \\t]*)(\\r\\n|\\r|\\n)$`);

/** 仅改写单行布尔字段，其他 YAML 和正文保持原样。 */
export function setDisableModelInvocation(content: string, disable: boolean): string {
  const unsupported = () => new Error(`Cannot edit ${KEY}: unsupported frontmatter formatting`);
  const bom = content.startsWith("\ufeff") ? "\ufeff" : "";
  const lines = content.slice(bom.length).split(/(?<=\n)|(?<=\r)(?!\n)/);
  const newline = lines[0].match(/\r\n|\r|\n/)?.[0] ?? "\n";
  if (!lines[0].startsWith("---")) {
    if (!disable) return content;
    return bom + ["---", `${KEY}: true`, "---", content.slice(bom.length)].join(newline);
  }
  const closing = lines.findIndex((line, i) => i > 0 && line.startsWith("---"));
  if (!DELIMITER.test(lines[0]) || closing < 0 || !DELIMITER.test(lines[closing])) throw unsupported();

  function readMapping(text: string): Record<string, unknown> {
    const frontmatter: unknown = parseFrontmatter(text).frontmatter;
    if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) throw unsupported();
    return frontmatter as Record<string, unknown>;
  }
  const original = readMapping(content);
  const hasKey = Object.hasOwn(original, KEY);
  if (disable ? hasKey && original[KEY] === true : !hasKey) return content;

  // 根缩进排除嵌套映射和块标量中的同名文本；复杂 YAML 再用 Pi 的解析结果校验。
  const indentation = (line: string) => line.length - line.trimStart().length;
  const fields = lines.slice(1, closing).filter((line) => !/^\s*(?:#|$)/.test(line));
  const indent = fields.length ? fields.reduce((min, line) => Math.min(min, indentation(line)), Infinity) : 0;
  if (hasKey) {
    const field = lines.findIndex((line, i) => i > 0 && i < closing && indentation(line) === indent && KEY_LINE.test(line.slice(indent)));
    if (field < 0 || typeof original[KEY] !== "boolean") throw unsupported();
    if (disable) lines[field] = " ".repeat(indent) + lines[field].slice(indent).replace(KEY_LINE, "$1true$2$3");
    else lines.splice(field, 1);
  } else {
    lines.splice(1, 0, `${" ".repeat(indent)}${KEY}: true${newline}`);
  }

  const updated = bom + lines.join("");
  try {
    const after = readMapping(updated);
    if (disable ? after[KEY] !== true : Object.hasOwn(after, KEY)) throw unsupported();
    const otherFields = (mapping: Record<string, unknown>) => {
      const copy = { ...mapping };
      delete copy[KEY];
      return copy;
    };
    if (isDeepStrictEqual(otherFields(original), otherFields(after))) return updated;
  } catch {
    // 局部改写无法安全重解析；拒绝保存。
  }
  throw unsupported();
}
