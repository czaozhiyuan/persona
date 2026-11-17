import { chromium, expect, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Project } from '../src/model/types';

const artifactRoot = resolve('artifacts');
mkdirSync(artifactRoot, { recursive: true });
const html = readFileSync('dist/index.html', 'utf8');
if (readdirSync('dist').join() !== 'index.html') throw new Error('Build has external output files');
if (/<script[^>]+src=|<link[^>]+(?:href|rel)=["'](?:https?:|\.\/|\/assets)/i.test(html)) throw new Error('External runtime assets detected');
expect(readFileSync('artifacts/persona-p0.html', 'utf8')).toBe(html);
const fileUrl = pathToFileURL(resolve('artifacts/persona-p0.html')).href;
const browserResults: object[] = [];

async function exported(page: Page, name: string): Promise<Project> {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 JSON ↗' }).click();
  const download = await pending;
  const output = resolve(artifactRoot, name);
  await download.saveAs(output);
  return JSON.parse(readFileSync(output, 'utf8')) as Project;
}

for (const channel of ['chrome', 'msedge']) {
  const browser = await chromium.launch({ channel, headless: true, downloadsPath: resolve('artifacts/test-results') });
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, acceptDownloads: true, deviceScaleFactor: 1 });
    await context.setOffline(true);
    const requests: string[] = [], errors: string[] = [];
    context.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(fileUrl);
    await expect(page.getByTestId('rf-gain')).toHaveText('-22.0');
    await expect(page.getByTestId('optical-power')).toHaveText('-2.0');
    await expect(page.locator('.react-flow__node')).toHaveCount(19);
    await expect(page.locator('[data-id="shared-fiber"]')).toHaveClass(/animated/);
    await expect(page.locator('[data-id="tx28/map-rf"]')).toBeVisible();
    await page.screenshot({ path: resolve(artifactRoot, `${channel}-topology.png`), fullPage: true });
    const original = await exported(page, `${channel}-baseline.json`);

    await page.getByRole('button', { name: '-3 dB', exact: true }).click();
    await expect(page.getByTestId('rf-gain')).toHaveText('-28.0');
    await page.getByRole('button', { name: /RF_CH30/ }).click();
    await expect(page.getByTestId('rf-gain')).toHaveText('-22.0');
    await page.getByRole('button', { name: /RF_CH28/ }).click();
    await page.getByRole('button', { name: '+3 dB', exact: true }).click();
    await expect(page.getByTestId('rf-gain')).toHaveText('-16.0');
    await page.getByRole('button', { name: '0 dB', exact: true }).click();

    await page.getByLabel('连接终点').selectOption('pcb:OPT_IN');
    await page.getByRole('button', { name: '建立连接', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('类型不兼容');
    await page.getByLabel('连接终点').selectOption('pcb:RF_IN');
    await page.getByRole('button', { name: '建立连接', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('连接已建立');
    const connected = await exported(page, `${channel}-connection.json`);
    expect(connected.connections.length).toBe(original.connections.length + 1);

    await page.getByLabel('选中实例').selectOption('pd28');
    await page.getByLabel('实例名称', { exact: true }).fill('接收器 28 / 已修改');
    await page.getByRole('button', { name: '机箱布局', exact: true }).click();
    await expect(page.getByTestId('physical-canvas').locator('canvas')).toBeVisible();
    await page.getByRole('spinbutton', { name: '物理 X / mm', exact: true }).fill('360');
    await page.getByRole('button', { name: /旋转 90°/ }).click();
    const afterField = await exported(page, `${channel}-physical-field.json`);
    expect(afterField.layout.physical.pd28.rotation).toBe(90);
    expect(afterField.layout.topology).toEqual(connected.layout.topology);
    expect(afterField.connections).toEqual(connected.connections);
    const canvas = await page.getByTestId('physical-canvas').locator('canvas').boundingBox();
    if (!canvas) throw new Error('Konva canvas not found');
    const scale = Math.min((canvas.width - 60) / 440, 1.8);
    const start = { x: canvas.x + 30 + 25 * scale + 10, y: canvas.y + 30 + 35 * scale + 10 };
    await page.mouse.move(start.x, start.y); await page.mouse.down();
    await page.mouse.move(start.x + 24, start.y + 18, { steps: 10 }); await page.mouse.up();
    const afterPhysical = await exported(page, `${channel}-physical-drag.json`);
    expect(afterPhysical.layout.physical['tx28/laser'].x).not.toBe(connected.layout.physical['tx28/laser'].x);
    expect(afterPhysical.layout.topology).toEqual(connected.layout.topology);
    expect(afterPhysical.connections).toEqual(connected.connections);
    await page.screenshot({ path: resolve(artifactRoot, `${channel}-physical.png`), fullPage: true });

    await page.getByRole('button', { name: '逻辑拓扑', exact: true }).click();
    await expect(page.locator('[data-id="pd28"] strong')).toHaveText('接收器 28 / 已修改');
    const node = page.locator('.react-flow__node[data-id="pd28"]');
    await expect(node).toBeVisible();
    await expect(node).toBeInViewport();
    const bounds = await node.locator('strong').boundingBox();
    if (!bounds) throw new Error('React Flow node not found');
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width / 2 - 30, bounds.y + bounds.height / 2 + 30, { steps: 10 }); await page.mouse.up();
    const afterLogic = await exported(page, `${channel}-logical-drag.json`);
    expect(afterLogic.layout.topology.pd28).not.toEqual(afterPhysical.layout.topology.pd28);
    expect(afterLogic.layout.physical).toEqual(afterPhysical.layout.physical);
    expect(afterLogic.connections).toEqual(afterPhysical.connections);

    await page.getByLabel('选中实例').selectOption('tx28');
    await page.getByRole('spinbutton', { name: '本实例激光功率覆盖 / dBm', exact: true }).fill('7');
    await expect(page.getByTestId('rf-gain')).toHaveText('-20.0');
    await page.getByRole('spinbutton', { name: '共同 MZM 光增益 / dB', exact: true }).fill('-5');
    await expect(page.getByTestId('rf-gain')).toHaveText('-22.0');
    await page.getByRole('button', { name: /RF_CH30/ }).click();
    await expect(page.getByTestId('rf-gain')).toHaveText('-24.0');
    await page.getByRole('button', { name: /PCB → RF 后级 · 扫频/ }).click();
    await expect(page.locator('tbody tr').nth(1).locator('td').nth(1)).toHaveText('18.0');
    await expect(page.locator('tbody tr').nth(3).locator('td').nth(1)).toHaveText('19.0');
    await page.getByRole('button', { name: /未定义关系 · 应无法连通/ }).click();
    await expect(page.getByTestId('calculation-status')).toContainText('无法计算');
    await page.getByLabel('Link 名称').fill('未定义关系 / 重命名验证');
    const finalProject = await exported(page, `${channel}-roundtrip.json`);
    await page.getByRole('button', { name: '清空工程', exact: true }).click();
    await expect(page.locator('h1')).toHaveText('空工程');
    await expect(page.locator('.react-flow__node')).toHaveCount(0);
    await page.getByTestId('import-file').setInputFiles(resolve(artifactRoot, `${channel}-roundtrip.json`));
    await expect(page.getByRole('status')).toContainText('导入成功');
    const reimported = await exported(page, `${channel}-reimported.json`);
    expect(reimported).toEqual(finalProject);
    await expect(page.locator('.react-flow__node')).toHaveCount(19);
    const partialProject = structuredClone(finalProject);
    delete partialProject.links[0].conversion;
    await page.getByTestId('import-file').setInputFiles({ name: 'missing-reference.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(partialProject)) });
    await expect(page.getByTestId('calculation-status')).toContainText('部分有效');
    await expect(page.getByTestId('rf-gain')).toHaveText('—');
    const badMapping = structuredClone(finalProject);
    badMapping.channels.find(c => c.id === 'DWDM_CH28')!.frequencyTHz = 192.9;
    await page.getByTestId('import-file').setInputFiles({ name: 'invalid-mapping.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(badMapping)) });
    await expect(page.getByRole('status')).toContainText('导入失败');
    await expect(page.getByTestId('calculation-status')).toContainText('部分有效');
    expect(errors).toEqual([]); expect(requests).toEqual([]);
    browserResults.push({ channel, version: browser.version(), url: fileUrl, offline: true, networkRequests: requests, pageErrors: errors,
      checks: ['file:// single HTML', 'RF -22/-28/-16', 'channel isolation', 'valid/invalid connection', 'physical drag and rotation', 'logical drag', 'independent coordinates', 'shared instance name', 'module overrides and common definition', '1 GHz interpolation', 'unreachable route', 'JSON download / clear / file input / deep equality', 'missing reference displays partial validity', 'invalid import preserves current project'], status: 'passed' });
    console.log(`${channel}: offline file:// interactions and JSON roundtrip passed`);
    await context.close();
  } finally { await browser.close(); }
}
writeFileSync(resolve(artifactRoot, 'browser-results.json'), JSON.stringify(browserResults, null, 2) + '\n');
