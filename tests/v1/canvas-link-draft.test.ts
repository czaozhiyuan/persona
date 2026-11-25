import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PortActionsDialog } from '../../src/editors/topology/v1/port-actions-dialog';
import { buildSignalGraph, signalPortKey } from '../../src/engine/v1/signal-graph';
import { topologyExample } from '../../src/model/v1/topology-example';
import type { PortType } from '../../src/model/v1/types';
import { removeTopologyInstances } from '../../src/state/v1/remove-topology-object';
import { cleanLinkDraft, previewLinkDraft, stageLinkFields } from '../../src/workbench/v1/links/link-draft';

test('port menus distinguish creation and editing, keep optical readings, and exclude power', () => {
  const menu = (type: PortType, canEditLink: boolean) => renderToStaticMarkup(createElement(PortActionsDialog, {
    port: { id: 'p', type, direction: 'out' }, name: 'Device', label: 'Port', locations: [],
    close() {}, rename() {}, budget() {}, canEditLink,
  }));
  for (const type of ['CONTROL', 'RF', 'OPTICAL'] as const) {
    assert.match(menu(type, false), /设为链路起点/);
    assert.doesNotMatch(menu(type, false), /修改当前链路/);
    assert.match(menu(type, true), /设为新链路终点/);
    assert.match(menu(type, true), /修改当前链路起点/);
    assert.equal(menu(type, true).includes('查看此处光功率'), type === 'OPTICAL');
  }
  for (const type of ['AC_POWER', 'DC_POWER'] as const) assert.doesNotMatch(menu(type, true), /链路|查看此处光功率/);
});

test('canvas and form stage either endpoint independently of saved links and topology cleanup', () => {
  const saved = topologyExample.namedLinks.find(link => link.id === 'wdm30')!;
  assert.ok(saved.from && saved.to);
  const graph = buildSignalGraph(topologyExample);
  const from = { ...saved.from, instancePath: ['TX_B'] }, to = { ...saved.to, instancePath: ['RX_B'] };
  const form = stageLinkFields(undefined, saved, { from: signalPortKey(from), channelId: 'DWDM_CH28' }, false, () => 'unused');
  const edit = stageLinkFields(form, saved, { to: signalPortKey(to) }, true, () => 'unused');
  assert.deepEqual(previewLinkDraft(edit, saved, graph), { ...saved, from, to, channelId: 'DWDM_CH28' });
  assert.deepEqual(saved.from.instancePath, ['TX_A']);
  const { project } = removeTopologyInstances(topologyExample, [['TX_B']]);
  const updated = buildSignalGraph(project);
  assert.deepEqual(previewLinkDraft(cleanLinkDraft(edit, updated), saved, updated).from, saved.from);
  assert.deepEqual(previewLinkDraft(cleanLinkDraft(edit, updated), saved, updated).to, to);
  const fresh = stageLinkFields(edit, undefined, { from: signalPortKey(from) }, true, () => 'new');
  const complete = stageLinkFields(fresh, undefined, { to: signalPortKey(to) }, true, () => 'unused');
  assert.deepEqual(previewLinkDraft(complete, undefined, graph), { id: 'new', name: '新链路', from, to, channelId: undefined });
  const cleared = stageLinkFields(edit, saved, { to: '' }, true, () => 'unused');
  assert.equal(previewLinkDraft(cleared, saved, graph).to, undefined);
});
