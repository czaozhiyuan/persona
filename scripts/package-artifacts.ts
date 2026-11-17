import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { platform, arch, release } from 'node:os';

mkdirSync('artifacts', { recursive: true });
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const production = Object.entries(lock.packages as Record<string, { dev?: boolean; version?: string; license?: string }>).filter(([path, pkg]) => path && !pkg.dev);
const notices = production.map(([path, pkg]) => {
  const files = readdirSync(path).filter(name => /^(license|copying|notice)(\.|$)/i.test(name));
  const texts = files.map(name => `${name}\n${readFileSync(join(path, name), 'utf8')}`).join('\n\n');
  return `${path.replace(/^node_modules\//, '')} ${pkg.version} (${pkg.license ?? 'see package license'})\n${texts}`;
}).join('\n\n' + '='.repeat(72) + '\n\n');
writeFileSync('artifacts/THIRD_PARTY_NOTICES.txt', notices + '\n');
const escaped = notices.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const built = readFileSync('dist/index.html', 'utf8').replace('</body>', `<template id="third-party-notices"><pre>${escaped}</pre></template>\n</body>`);
writeFileSync('dist/index.html', built);
copyFileSync('dist/index.html', 'artifacts/persona-p0.html');
const dependencies = Object.fromEntries(Object.entries(lock.packages as Record<string, { version?: string }>).filter(([path]) => path && path.split('node_modules/').length === 2).map(([path, pkg]) => [path.replace('node_modules/', ''), pkg.version]));
const info = {
  builtAtUtc: new Date().toISOString(), platform: platform(), arch: arch(), osRelease: release(), node: process.version,
  sourceBaseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceState: 'P0 implementation in working tree; sourceBaseCommit identifies the input repository',
  html: { path: 'artifacts/persona-p0.html', bytes: Buffer.byteLength(built), sha256: createHash('sha256').update(built).digest('hex') }, dependencies,
};
writeFileSync('artifacts/build-info.json', JSON.stringify(info, null, 2) + '\n');
writeFileSync('artifacts/persona-p0.html.sha256', `${info.html.sha256}  persona-p0.html\n`);
console.log(`Packaged ${info.html.bytes} bytes with third-party notices: artifacts/persona-p0.html`);
