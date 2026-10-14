import assert from "node:assert/strict";
import fs from "node:fs";
import { parseGuideMarkdown, getGuideMarkdown } from "../GuideContent.js";

const sourceUrl = "https://github.com/Chengzong-Zhang/Line-Game/blob/main/README.md";
const source = parseGuideMarkdown(`[源码](${sourceUrl})`);
assert.equal(source[0].type, "paragraph", "a URL colon must not split a link into metadata");
assert.deepEqual(source[0].tokens, [{ type: "link", text: "源码", href: sourceUrl }]);

for (const href of ["javascript:alert(1)", "data:text/html,<script>", "//example.com", "https://example.com/\u0000"] ) {
  const blocks = parseGuideMarkdown(`[unsafe](${href})`);
  assert.equal(blocks.flatMap((block) => block.tokens ?? []).some((token) => token.type === "link"), false);
}
const mixed = parseGuideMarkdown(`正文 **强调**、\`grid\` 与 [源码](${sourceUrl})。`);
assert.deepEqual(mixed[0].tokens.filter((token) => token.type !== "text").map((token) => token.type), ["strong", "code", "link"]);
assert.equal(parseGuideMarkdown("状态：兼容试用")[0].type, "meta");

for (const language of ["zh", "en"]) {
  const markdown = fs.readFileSync(new URL(`../guide/interesting/why-code.${language}.md`, import.meta.url), "utf8");
  const blocks = parseGuideMarkdown(markdown);
  assert.equal(blocks.filter((block) => block.type === "heading2").length, 8);
  assert.equal(blocks.filter((block) => block.type === "table").length, 1);
  assert.ok(blocks.flatMap((block) => block.tokens ?? []).filter((token) => token.type === "link").length >= 9);
  assert.ok(getGuideMarkdown("whyCode", language).includes("territory-v2"));
}
console.log("verify-guide-content: PASS (bilingual articles, clickable source links, safe protocols, URL colons, inline formatting)");
