import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { serializeProjectJson } from '../../src/storage/v1/project-json';
import { controlPin, inputs, outputs, sharedChannel, sharedDigitalProject } from '../v1/fixtures/nested-digital-project';

const browser = await chromium.launch({ channel: 'chrome' });
try {
  const context = await browser.newContext({ offline: true, acceptDownloads: true, viewport: { width: 1780, height: 1080 } });
  const page = await context.newPage();
  page.setDefaultTimeout(5500);
  const errors: string[] = [], network: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (/^https?:/.test(r.url())) network.push(r.url()); });
  page.on('dialog', dialog => dialog.accept());
  await page.goto(pathToFileURL(resolve(process.argv[2] ?? 'artifacts/v1/persona-v1.html')).href);
  const button = (name: string) => page.getByRole('button', { name, exact: true });
  const book = page.locator('.v1-links'), select = book.locator('#link-selection');
  const from = book.locator('select[name=from]'), to = book.locator('select[name=to]');
  const settings = book.locator('details').first();
  const canvas = page.locator('section.v1-routing'), main = page.locator('section.v1-topology');
  const pair = (box: string, pin: string) => JSON.stringify([controlPin(box, pin).instancePath, pin]);
  const ids: string[] = [];
  async function load(text: string) {
    await page.getByLabel('工程 JSON 文件').setInputFiles({ name: 'shared.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  }
  async function save() {
    const wait = page.waitForEvent('download');
    await button('保存工程').click();
    return JSON.parse(await readFile(await (await wait).path(), 'utf8'));
  }
  async function expandSettings() {
    if (await settings.getAttribute('open') === null) await settings.locator('summary').first().click();
  }
  async function budget(index: number, loss?: number) {
    await button('参数计算').click();
    await select.selectOption(ids[index]);
    await book.locator('[data-path-status="' + (loss === undefined ? 'unreachable' : 'resolved') + '"]').waitFor();
    assert.equal(await from.inputValue(), pair('A', inputs[index]));
    assert.equal(await to.inputValue(), pair('B', outputs[index]));
    if (loss === undefined) {
      assert.equal(await book.locator('[data-metric=optical-power]').count(), 0);
      assert.match(await to.locator('option:checked').textContent() ?? '', /当前端点/);
      return;
    }
    assert.equal(await book.locator('[data-metric=optical-power]').innerText(), (-loss).toFixed(1) + ' dBm');
    const metrics = await book.locator('.v1-budget-metrics').innerText();
    assert.ok(metrics.includes((20 - loss).toFixed(1) + ' dB') && metrics.includes('-20.0 dBm') && metrics.includes('未超过上限'));
    const mux = page.locator('.workspace .v1-multiplex-details').first();
    assert.ok((await mux.textContent())?.includes('出 0.0000 dBm'));
  }
  async function openBoard(box: string) {
    await button('框图').click();
    const tree = page.locator('#workbench-structure');
    if (!await tree.isVisible()) await page.locator('button[aria-controls=workbench-structure]').click();
    const entry = (path: string[]) => tree.locator("li[data-hierarchy-key='" + JSON.stringify(path) + "']");
    for (const path of [[], [box], [box, 'card']]) {
      const disclosure = entry(path).locator('button.v1-hierarchy-disclosure');
      if (await disclosure.getAttribute('aria-expanded') === 'false') await disclosure.click();
    }
    await entry([box, 'card', 'ctl']).locator('.v1-hierarchy-entry').dblclick();
    await canvas.waitFor();
  }
  async function internal(box: string, index: number) {
    await openBoard(box);
    const route = box === 'A' ? [inputs[index], 'TTL OUT'] : ['TTL IN', outputs[index]];
    const active = canvas.locator('.react-flow__edge.v1-path-edge');
    await active.first().waitFor();
    assert.deepEqual(await active.evaluateAll(edges => edges.map(e => JSON.parse(decodeURIComponent(e.getAttribute('data-id')!)))), [route]);
    await canvas.getByRole('button', { name: '返回框图' }).click();
  }
  async function fibre() {
    await button('框图').click();
    const props = page.locator('#workbench-properties');
    if (!await props.isVisible()) await page.locator('button[aria-controls=workbench-properties]').click();
    const module = page.locator('.v1-current-module-tools');
    if (await module.getAttribute('open') === null) await module.locator('summary').first().click();
    const wires = module.locator('details').filter({ has: page.locator('summary', { hasText: /^连线$/ }) });
    if (await wires.getAttribute('open') === null) await wires.locator('summary').first().click();
    await wires.getByLabel('已有连接').selectOption('fibre');
    return wires;
  }
  const fixture = sharedDigitalProject();
  fixture.namedLinks = [];
  await load(serializeProjectJson(fixture));
  await button('参数计算').click();
  for (const [i, input] of inputs.entries()) {
    await select.selectOption('');
    assert.equal(await book.locator('input[type=checkbox]').first().isChecked(), false);
    await from.selectOption(pair('A', input));
    assert.deepEqual(await to.locator('option').evaluateAll(opts => opts.map(o => (o as HTMLOptionElement).value)), [
      '', ...outputs.map(id => pair('B', id)),
    ]);
    assert.equal(await to.inputValue(), '');
    await to.selectOption(pair('B', outputs[i]));
    await book.locator('[name=channel]').selectOption(sharedChannel);
    await book.locator('[name=name]').fill('业务 ' + (i + 1));
    await book.getByRole('button', { name: '保存为链路' }).click();
    ids.push(await select.inputValue());
    await budget(i, 3);
  }
  const original = await save();
  assert.equal(original.project.namedLinks.length, 3);
  for (const [i, link] of original.project.namedLinks.entries()) {
    assert.deepEqual([link.from, link.to, link.channelId], [controlPin('A', inputs[i]), controlPin('B', outputs[i]), sharedChannel]);
    await budget(i, 3);
    await button('框图').click();
    assert.equal(await main.locator('.react-flow__edge.v1-path-edge').count(), 1);
    assert.equal(await main.locator('.v1-routing-port').count(), 0);
    await internal('A', i);
    await internal('B', i);
  }
  await load(JSON.stringify(original));
  await budget(0, 3);
  await expandSettings();
  await to.selectOption(pair('B', outputs[2]));
  await book.getByRole('button', { name: '保存链路', exact: true }).click();
  const edited = await save();
  assert.deepEqual(edited.project.namedLinks[0].to, controlPin('B', outputs[2]));
  assert.deepEqual(edited.project.namedLinks.slice(1), original.project.namedLinks.slice(1));
  await expandSettings();
  await book.getByRole('button', { name: '删除链路' }).click();
  const deleted = await save();
  assert.deepEqual(deleted.project, { ...original.project, namedLinks: original.project.namedLinks.slice(1) });
  await budget(1, 3);
  await button('撤销').click();
  assert.deepEqual((await save()).project, edited.project);
  await button('重做').click();
  assert.deepEqual((await save()).project, deleted.project);
  await load(JSON.stringify(original));
  const wire = await fibre();
  await wire.getByLabel('光纤损耗（dB）').fill('6');
  await wire.getByRole('button', { name: '保存连接' }).click();
  for (let i = 0; i < 3; i++) await budget(i, 6);
  await budget(1, 6);
  await openBoard('A');
  const branch = canvas.locator('.react-flow__edge.v1-path-edge .react-flow__edge-interaction');
  const point = await branch.evaluate(el => {
    const path = el as SVGPathElement;
    const p = path.getPointAtLength(path.getTotalLength() * 0.12).matrixTransform(path.getScreenCTM()!);
    return { x: p.x, y: p.y };
  });
  await page.mouse.click(point.x, point.y);
  await page.keyboard.press('Delete');
  await branch.waitFor({ state: 'detached' });
  await canvas.getByRole('button', { name: '返回框图' }).click();
  await budget(0, 6);
  await budget(1);
  await budget(2, 6);
  await button('撤销').click();
  await budget(1, 6);
  await (await fibre()).getByRole('button', { name: '删除连接' }).click();
  for (let i = 0; i < 3; i++) {
    await budget(i);
    await internal('A', i);
    await internal('B', i);
  }
  await button('撤销').click();
  for (let i = 0; i < 3; i++) await budget(i, 6);
  const restored = await save();
  assert.deepEqual(restored.project.namedLinks, original.project.namedLinks);
  await load(JSON.stringify(restored));
  for (let i = 0; i < 3; i++) await budget(i, 6);
  assert.deepEqual(errors, []);
  assert.deepEqual(network, []);
  console.log(JSON.stringify({ chrome: browser.version(), offline: true, savedLinks: ids.length, candidatePairs: 9,
    lossDb: [3, 6], powerDbm: [-3, -6], marginsDb: [17, 14], launchDbm: 0, errors, network }));
} finally {
  await browser.close();
}
