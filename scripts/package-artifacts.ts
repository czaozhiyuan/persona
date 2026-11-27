import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { platform, arch, release } from 'node:os';

const input = 'dist/v1/v1.html';
const outputDir = 'artifacts/v1';
const htmlName = 'persona-v1.html';
const output = join(outputDir, htmlName);
const rawHtml = readFileSync(input, 'utf8');
if (!rawHtml.includes('<title>persona · V1 工作台</title>')) throw new Error('Expected the V1 workbench build.');
if (!rawHtml.includes('</body>')) throw new Error(`No closing body tag in ${input}.`);
mkdirSync(outputDir, { recursive: true });
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const production = Object.entries(lock.packages as Record<string, { dev?: boolean; version?: string; license?: string }>).filter(([path, pkg]) => path && !pkg.dev);
const notices = production.map(([path, pkg]) => {
  const files = readdirSync(path).filter(name => /^(license|copying|notice)(\.|$)/i.test(name)).sort();
  const texts = files.map(name => `${name}\n${readFileSync(join(path, name), 'utf8')}`).join('\n\n');
  const source = path === 'node_modules/elkjs' ? `Source available under EPL-2.0: https://github.com/kieler/elkjs/tree/${pkg.version}\n` : '';
  return `${path.replace(/^node_modules\//, '')} ${pkg.version} (${pkg.license ?? 'see package license'})\n${source}${texts}`;
}).join('\n\n' + '='.repeat(72) + '\n\n');
writeFileSync(join(outputDir, 'THIRD_PARTY_NOTICES.txt'), notices + '\n');
const escaped = notices.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const built = rawHtml.replace('</body>', `<template id="third-party-notices"><pre>${escaped}</pre></template>\n</body>`);
writeFileSync(input, built);
copyFileSync(input, output);
const html = readFileSync(output);
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const git = (args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const examples = ['v1-project.json', 'v1-tx-only.json'].map(name => {
  const path = join(outputDir, name);
  copyFileSync(join('examples', name), path);
  const data = readFileSync(path);
  return { name, bytes: data.length, sha256: sha256(data) };
});
const dependencies = Object.fromEntries(Object.entries(lock.packages as Record<string, { version?: string }>).filter(([path]) => path && path.split('node_modules/').length === 2).map(([path, pkg]) => [path.replace('node_modules/', ''), pkg.version]));
const info = {
  builtAtUtc: new Date().toISOString(), platform: platform(), arch: arch(), osRelease: release(), node: process.version,
  sourceBaseCommit: git(['rev-parse', 'HEAD']),
  sourceState: git(['status', '--porcelain']) ? 'dirty' : 'clean',
  entry: 'v1.html', examples,
  html: { path: `${outputDir}/${htmlName}`, bytes: html.length, sha256: sha256(html) }, dependencies,
};
writeFileSync(join(outputDir, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
writeFileSync(join(outputDir, `${htmlName}.sha256`), `${info.html.sha256}  ${htmlName}\n`);
console.log(`Packaged ${info.html.bytes} bytes with third-party notices: ${info.html.path}`);
