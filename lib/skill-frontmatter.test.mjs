import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { setDisableModelInvocation } from "./skill-frontmatter.ts";

describe("setDisableModelInvocation", () => {
  const withFrontmatter = "---\nname: my-skill\ndescription: Does things\n---\n\nBody text.\n";

  it("adds the key or creates frontmatter when absent", () => {
    const updated = setDisableModelInvocation(withFrontmatter, true);
    assert.equal(parseFrontmatter(updated).frontmatter["disable-model-invocation"], true);
    assert.equal(parseFrontmatter(setDisableModelInvocation("Just a body.\n", true)).frontmatter["disable-model-invocation"], true);
  });

  it("replaces explicit false rather than creating a duplicate key", () => {
    const content = "---\nname: my-skill\ndisable-model-invocation: false\ndescription: Does things\n---\n\nBody text.\n";
    const updated = setDisableModelInvocation(content, true);
    assert.equal(parseFrontmatter(updated).frontmatter["disable-model-invocation"], true);
    assert.equal(updated.match(/^disable-model-invocation[^\n]*/gm)?.length, 1);
  });

  it("updates and removes indented quoted keys", () => {
    for (const quote of ['"', "'"]) {
      const content = `---\n  name: my-skill\n  ${quote}disable-model-invocation${quote}: false\n---\nBody text.\n`;
      const updated = setDisableModelInvocation(content, true);
      assert.equal(parseFrontmatter(updated).frontmatter["disable-model-invocation"], true);
      assert.equal(parseFrontmatter(setDisableModelInvocation(updated, false)).frontmatter["disable-model-invocation"], undefined);
    }
  });

  it("never edits a nested key or a lookalike inside a block scalar", () => {
    for (const nested of [
      "  description: |\n    Sample text\n    disable-model-invocation: example",
      "  metadata:\n    disable-model-invocation: false",
    ]) {
      const content = `---\n  name: my-skill\n${nested}\n  disable-model-invocation: false\n---\nBody.\n`;
      assert.equal(setDisableModelInvocation(content, true), content.replace("\n  disable-model-invocation: false", "\n  disable-model-invocation: true"));
      assert.equal(setDisableModelInvocation(content, false), content.replace("  disable-model-invocation: false\n---", "---"));
    }
  });

  it("adds a missing key to an indented mapping and keeps the BOM", () => {
    const content = "\ufeff---\r\n  name: my-skill\r\n  description: Does things\r\n---\r\nBody.\r\n";
    const updated = setDisableModelInvocation(content, true);
    assert.equal(updated, content.replace("  name:", "  disable-model-invocation: true\r\n  name:"));
    assert.equal(setDisableModelInvocation(updated, false), content);
  });

  it("handles Pi's Boolean casing without changing already-enabled files", () => {
    const enabled = "\ufeff---\r\nname: my-skill\r\ndisable-model-invocation: TRUE # keep\r\n---\r\nBody.\r\n";
    const disabled = enabled.replace("TRUE", "False");
    const updated = setDisableModelInvocation(disabled, true);
    assert.equal(updated, disabled.replace("False", "true"));
    assert.equal(setDisableModelInvocation(enabled, true), enabled);
    assert.equal(setDisableModelInvocation(enabled, false), enabled.replace("disable-model-invocation: TRUE # keep\r\n", ""));
    const flow = "---\n{ disable-model-invocation: true }\n---\n";
    assert.equal(setDisableModelInvocation(flow, true), flow);
    assert.throws(() => setDisableModelInvocation(flow, false), /unsupported frontmatter formatting/);
  });

  it("keeps a leading BOM when creating frontmatter for a body-only skill", () => {
    const body = "\ufeffBody.\r\nMore body.\r\n";
    const updated = setDisableModelInvocation(body, true);
    assert.equal(updated, "\ufeff---\r\ndisable-model-invocation: true\r\n---\r\nBody.\r\nMore body.\r\n");
    assert.equal(setDisableModelInvocation(updated, true), updated);
  });

  it("preserves CRLF and never edits body lines", () => {
    const content = "---\r\nname: my-skill\r\ndisable-model-invocation: false\r\n---\r\nUse disable-model-invocation: true.\r\n";
    const updated = setDisableModelInvocation(content, true);
    assert.match(updated, /disable-model-invocation: true\r\n/);
    assert.match(updated, /Use disable-model-invocation: true/);
  });

  it("rejects unsupported key formatting and is a no-op when absent and disabled", () => {
    for (const content of [
      "---\n{ disable-model-invocation: false }\n---\n",
      "---\n{ name: my-skill }\n---\n",
      "---\ndisable-model-invocation: |-\n  false\n---\n",
      "---\n? disable-model-invocation\n: false\n---\n",
      "---\ndisable-model-invocation: false\n",
    ]) assert.throws(() => setDisableModelInvocation(content, true), /unsupported frontmatter formatting/);
    assert.equal(setDisableModelInvocation(withFrontmatter, false), withFrontmatter);
  });
});
