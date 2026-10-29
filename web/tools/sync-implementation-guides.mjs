import fs from 'node:fs/promises';
import { implementationMarkdown } from '../web前端/GuideImplementation.js';

const check = process.argv.includes('--check');
const documents = [
  ['rulesMath', 'zh', '../web前端/guide/rule/math rule.md'],
  ['rulesMath', 'en', '../web前端/guide/rule/math rule.en.md'],
  ['whyCode', 'zh', '../web前端/guide/interesting/why-code.zh.md'],
  ['whyCode', 'en', '../web前端/guide/interesting/why-code.en.md'],
];
for (const [kind, language, relative] of documents) {
  const url = new URL(relative, import.meta.url);
  const expected = implementationMarkdown(kind, language);
  if (check) {
    if (await fs.readFile(url, 'utf8') !== expected) throw Error(`Guide source drift: ${relative}`);
  } else await fs.writeFile(url, expected, 'utf8');
}
console.log(`${check ? 'Verified' : 'Updated'} four bilingual implementation articles.`);
