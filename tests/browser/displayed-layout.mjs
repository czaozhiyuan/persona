import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const ports = [{ id: 'in', type: 'RF', direction: 'in' }, { id: 'out', type: 'RF', direction: 'out' }];
const slot = (id, definitionId) => ({ id, name: id, definitionId });
const link = (id, a, b) => ({ id, from: { instanceId: a, portId: 'out' }, to: { instanceId: b, portId: 'in' } });
function pair(id, type, a, b) {
  return { id, name: id, kind: 'module', ports, instances: [slot(a, type), slot(b, type)],
    connections: [link('through', a, b)], portMappings: [
      { portId: 'in', target: { instanceId: a, portId: 'in' } },
      { portId: 'out', target: { instanceId: b, portId: 'out' } },
    ] };
}
const board = pair('board', 'amp', 'P', 'Q');
const chassis = { ...pair('chassis', 'board', 'X', 'Y'), physicalEnclosure: { widthMm: 440, depthMm: 300, heightMm: 50 } };
const root = { kind: 'module', id: 'system', name: 'system', ports: [],
  instances: [slot('A', 'chassis'), slot('B', 'chassis')], connections: [link('backplane', 'A', 'B')] };
const layout = { topology: [], topologyFrames: [], topologyWireRoutes: [] };
for (const [i, box] of ['A', 'B'].entries()) {
  layout.topology.push({ instancePath: [box], x: i ? 4900 : 20, y: 180 });
  for (const [j, card] of ['X', 'Y'].entries()) {
    layout.topology.push({ instancePath: [box, card], x: j ? 80 : 390, y: 180 });
    for (const [k, chip] of ['P', 'Q'].entries()) {
      layout.topology.push({ instancePath: [box, card, chip], x: k ? 110 : 450, y: k ? 170 : 220 });
    }
    layout.topologyFrames.push({ modulePath: [box, card], x: 0, y: 0, width: 850, height: 415 });
    layout.topologyWireRoutes.push({ modulePath: [box, card], wire: { kind: 'connection', id: 'through' }, x: 430, y: 125 });
  }
}
const fixture = { format: 'persona-project', schemaVersion: 2, project: {
  id: 'nested', name: 'nested', rootModuleDefinitionId: 'system', moduleDefinitions: [root, chassis, board],
  componentDefinitions: [{ id: 'amp', kind: 'component', name: 'amp', ports,
    transfers: [{ kind: 'rf', fromPortId: 'in', toPortId: 'out' }] }], layout } };

const browser = await chromium.launch({ channel: 'chrome' });
try {
  const ctx = await browser.newContext({ offline: true, viewport: { width: 1760, height: 1000 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [], requests = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (/^https?:/.test(r.url())) requests.push(r.url()); });
  page.on('dialog', d => d.accept());
  await page.goto(pathToFileURL(resolve(process.argv[2] ?? 'artifacts/v1/persona-v1.html')).href);
  const button = name => page.getByRole('button', { name, exact: true });
  const node = (...path) => page.locator('.react-flow__node[data-id="' + encodeURIComponent(JSON.stringify(path)) + '"]');
  const frames = () => page.locator('.react-flow__node-moduleFrame').evaluateAll(nodes => nodes.map(n => n.dataset.id).sort());
  const viewport = () => page.locator('.react-flow__viewport').evaluate(n => n.style.transform);
  const selected = () => page.locator('.react-flow__node.selected').evaluateAll(nodes => nodes.map(n => n.dataset.id).sort());
  const settle = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  async function open(doc) {
    await page.getByLabel('工程 JSON 文件').setInputFiles({ name: 'fixture.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)) });
    await settle();
  }
  async function save() {
    const download = page.waitForEvent('download');
    await button('保存工程').click();
    return JSON.parse(await readFile(await (await download).path(), 'utf8'));
  }
  const toggle = async (...path) => { await node(...path).locator('.v1-module-toggle').evaluate(b => b.click()); await settle(); };
  async function mixed() {
    for (const box of ['A', 'B']) {
      if (!await node(box, 'Y').count()) await toggle(box);
      if (!await node(box, 'X', 'P').count()) await toggle(box, 'X');
    }
  }
  async function run(action) {
    const before = await Promise.all([frames(), viewport(), selected()]);
    await button(action).click();
    await page.waitForFunction(() => !document.querySelector('.v1-organize-controls button').disabled);
    assert.deepEqual(await Promise.all([frames(), viewport(), selected()]), before);
    assert.deepEqual(await page.locator('.v1-topology-message.error').allTextContents(), []);
  }
  async function verifyGeometry() {
    const rects = await page.locator('.react-flow__node').evaluateAll(ns => ns.map(n => ({
      path: JSON.parse(decodeURIComponent(n.dataset.id)), ...n.getBoundingClientRect().toJSON(),
    })));
    // Sample the painted curves in screen coordinates, including both endpoint connectors.
    const crossings = await page.locator('.v1-wire-main').evaluateAll(paths => {
      const boxes = [...document.querySelectorAll('.react-flow__node')].map(n => ({
        path: JSON.parse(decodeURIComponent(n.dataset.id)), rect: n.getBoundingClientRect(),
      }));
      function inside(p, b, margin) {
        return p.x >= b.left - margin && p.x <= b.right + margin && p.y >= b.top - margin && p.y <= b.bottom + margin;
      }
      return paths.flatMap(path => {
        const [scope] = JSON.parse(path.id);
        const key = JSON.stringify(scope);
        const owner = boxes.find(b => JSON.stringify(b.path) === key)?.rect;
        const length = path.getTotalLength(), transform = path.getScreenCTM();
        const point = d => path.getPointAtLength(d).matrixTransform(transform);
        const start = point(0), end = point(length);
        const obstacles = boxes.filter(b => b.path.length === scope.length + 1 && JSON.stringify(b.path.slice(0, -1)) === key
          && !inside(start, b.rect, 4) && !inside(end, b.rect, 4));
        for (let d = 0; d <= length; d += 3) {
          const p = point(d);
          if ((owner && !inside(p, owner, 1)) || obstacles.some(b => inside(p, b.rect, -1))) return [path.id];
        }
        return [];
      });
    });
    assert.deepEqual(crossings, []);
    for (const a of rects) {
      const owner = JSON.stringify(a.path.slice(0, -1));
      const parent = rects.find(b => JSON.stringify(b.path) === owner);
      if (parent) assert.ok(a.left >= parent.left - 0.2 && a.right <= parent.right + 0.2
        && a.top >= parent.top - 0.2 && a.bottom <= parent.bottom + 0.2, 'clipping ' + a.path);
      for (const b of rects.filter(b => b !== a && JSON.stringify(b.path.slice(0, -1)) === owner))
        assert.ok(a.right <= b.left + 0.2 || b.right <= a.left + 0.2 || a.bottom <= b.top + 0.2 || b.bottom <= a.top + 0.2, 'overlap ' + a.path + '/' + b.path);
    }
  }
  function preserved(a, b, keep) {
    const { layout: la, ...pa } = a.project, { layout: lb, ...pb } = b.project;
    assert.deepEqual(pa, pb);
    for (const name of ['topology', 'topologyFrames', 'topologyWireRoutes']) {
      const rows = l => (l[name] ?? []).filter(row => keep(name === 'topology' ? row.instancePath.slice(0, -1) : row.modulePath));
      assert.deepEqual(rows(la), rows(lb), name);
    }
  }

  await open(fixture);
  const initial = await save();
  assert.equal(initial.project.id, 'nested');
  await mixed();
  assert.equal(await button('自动排列并理线').count(), 0);
  assert.equal(await button('仅自动理线').count(), 0);
  await node('A', 'Y').dispatchEvent('click');
  assert.equal((await selected()).length, 1);
  await button('放大').click();
  const offscreen = await node('B', 'X', 'Q').evaluate(n => {
    const r = n.getBoundingClientRect(), canvas = n.closest('.v1-topology-canvas').getBoundingClientRect();
    return r.left > canvas.right || r.right < canvas.left || r.top > canvas.bottom || r.bottom < canvas.top;
  });
  assert.ok(offscreen, 'offscreen descendant');
  await node('B', 'X', 'P').evaluate(chip => new Promise((resolve, reject) => {
    const controls = document.querySelector('.v1-organize-controls');
    const before = chip.style.transform;
    const observer = new MutationObserver(() => {
      if (chip.style.transform === before) return;
      observer.disconnect();
      clearTimeout(timeout);
      controls.querySelector('button:last-child').click();
      resolve();
    });
    const timeout = setTimeout(() => { observer.disconnect(); reject(Error('No staged child movement')); }, 3000);
    observer.observe(chip, { attributes: true, attributeFilter: ['style'] });
    controls.querySelector('button').click();
    controls.querySelector('button').click();
  }));
  assert.deepEqual(await save(), initial);
  assert.ok(await button('撤销').isDisabled());
  await run('自动排列');
  await verifyGeometry();
  const arranged = await save();
  preserved(initial, arranged, path => path.includes('Y'));
  const known = new Set(['[]', '["A"]', '["B"]', '["A","X"]', '["B","X"]']);
  const routed = doc => doc.project.layout.topologyWireRoutes.filter(r => known.has(JSON.stringify(r.modulePath)) && r.kind === 'orthogonal');
  assert.equal(routed(arranged).length, 13);
  for (const [box, card] of [['A','X'], ['B','X']]) {
    const pos = id => arranged.project.layout.topology.find(p => JSON.stringify(p.instancePath) === JSON.stringify([box, card, id]));
    assert.ok(pos('P').x < pos('Q').x);
  }
  await run('自动排列');
  await page.locator('.v1-topology-canvas').focus();
  await page.keyboard.press('Control+z');
  assert.deepEqual(await save(), initial);
  await button('重做').click();
  assert.deepEqual(await save(), arranged);

  const unwired = structuredClone(arranged);
  unwired.project.layout.topologyWireRoutes = unwired.project.layout.topologyWireRoutes.filter(r => !known.has(JSON.stringify(r.modulePath)));
  await open(unwired);
  await mixed();
  const viewMenu = page.locator('summary').getByText('视图', { exact: true });
  await page.locator('.v1-side-right').getByRole('button', { name: '属性', exact: true }).click();
  await viewMenu.click();
  await button('全页展示').click();
  await page.setViewportSize({ width: 750, height: 700 });
  await settle();
  for (const name of ['自动排列', '理线', '收起', '展开', '适应画布']) {
    const box = await button(name).boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 750 && box.y + box.height <= 700, name);
  }
  await run('理线');
  await button('退出全页展示').click();
  await page.setViewportSize({ width: 1760, height: 1000 });
  await settle();
  const wired = await save();
  assert.deepEqual(wired.project.layout.topology, unwired.project.layout.topology);
  assert.deepEqual(wired.project.layout.topologyFrames, unwired.project.layout.topologyFrames);
  assert.equal(routed(wired).length, 13);
  await button('撤销').click();
  assert.deepEqual(await save(), unwired);
  await button('重做').click();
  assert.deepEqual(await save(), wired);
  await open(wired);
  assert.deepEqual(await save(), wired);

  await open(initial);
  await mixed();
  await button('自动排列').evaluate(b => {
    b.click();
    document.querySelector('.react-flow__node[data-id="' + encodeURIComponent(JSON.stringify(['B'])) + '"] .v1-module-toggle').click();
  });
  await settle();
  assert.deepEqual(await save(), initial);
  await node('A').locator('.v1-frame-title strong').dispatchEvent('dblclick', { detail: 2 });
  await page.waitForFunction(() => document.querySelector('[aria-current="location"]')?.textContent === 'A');
  if (!await node('A','X','P').count()) await toggle('A','X');
  await run('自动排列');
  await verifyGeometry();
  const local = await save();
  preserved(initial, local, path => path[0] !== 'A' || path.includes('Y'));
  assert.equal(routed(local).length, 6);
  await button('适应画布').click();
  await settle();
  const chip = node('A', 'X', 'Q').locator('.v1-block-title strong');
  const bounds = await chip.boundingBox();
  const wire = nodeId => page.locator('.v1-wire-main').evaluateAll((paths, id) =>
    paths.find(p => p.id.includes(id) && p.id.includes('through')).getAttribute('d'), nodeId);
  const pathId = JSON.stringify(['A', 'X']), beforeDrag = await wire(pathId);
  const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 10, y + 12, { steps: 5 });
  await page.mouse.up();
  await settle();
  const dragged = await save(), afterDrag = await wire(pathId);
  assert.notDeepEqual(dragged.project.layout.topology, local.project.layout.topology);
  assert.deepEqual(dragged.project.layout.topologyWireRoutes, local.project.layout.topologyWireRoutes);
  assert.notEqual(beforeDrag, afterDrag);
  const core = d => d.slice(d.indexOf(' L '), d.lastIndexOf(' C '));
  assert.equal(core(beforeDrag), core(afterDrag));
  await button('撤销').click();
  assert.deepEqual(await save(), local);
  const beforeEdit = await save();
  await button('理线').evaluate(b => {
    b.click();
    document.querySelector('button[aria-label="撤销"]').click();
  });
  await settle();
  assert.deepEqual(await save(), initial);
  await button('重做').click();
  assert.deepEqual(await save(), beforeEdit);
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
  console.log(JSON.stringify({ chrome: browser.version(), offline: true, displayedScopes: 5, routes: 13, localRoutes: 6, errors, requests }));
} finally {
  await browser.close();
}
