import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { calculateDcBudget } from '../../src/engine/v1/dc-budget';
import { createLinkBudget } from '../../src/engine/v1/link-budget';
import { createOpticalBudget } from '../../src/engine/v1/optical-budget';
import type { OpticalSource } from '../../src/engine/v1/optical-budget';
import { editInstanceSettings } from '../../src/state/v1/instance-settings';
import { parseProjectJson, serializeProjectJson } from '../../src/storage/v1/project-json';

const laser: OpticalSource = {
  endpoint: { instancePath: ['TX_A', 'laser'], portId: 'OUT' },
  channelId: 'DWDM_CH28', powerDbm: 0,
};
const load = (name: string) => parseProjectJson(readFileSync(new URL(`../../examples/${name}`, import.meta.url), 'utf8'));
const available = (value: number, unit: 'dB' | 'dBm' | 'W') => ({ availability: 'available', value, unit });

test('the complete workbench example produces the documented EO/OE, scan, RF and DC results', () => {
  const project = load('v1-project.json');
  const link = project.namedLinks!.find(item => item.id === 'full')!;
  const conditions = { opticalSources: [laser], inputPowerDbm: -20 };
  const budget = createLinkBudget(project);
  const point = budget.calculateNamedLink(link, { ...conditions, frequencyGHz: 1 });
  assert.equal(point.kind, 'conversion');
  assert.deepEqual(point.gainDb, available(-22, 'dB'));
  assert.deepEqual(point.powerDbm, available(-42, 'dBm'));
  assert.deepEqual(point.segments[0].pdPowerDbm, available(-5, 'dBm'));
  assert.equal(point.nfDb.availability, 'unavailable');
  const scan = budget.scanNamedLink(link, { startGHz: 0, stopGHz: 67 }, conditions);
  assert.equal(scan.points.length, 68);
  assert.equal(scan.points[0].gainDb.availability, 'unavailable');
  assert.deepEqual(scan.points[67].gainDb, available(-16, 'dB'));

  const blocked = createLinkBudget(editInstanceSettings(project, ['TX_A', 'optical-switch'],
    settings => ({ ...settings, switchStateId: 'block' })));
  assert.equal(blocked.resolveNamedLink(link, conditions).status, 'unreachable');

  const rf = budget.calculateNamedLink(project.namedLinks!.find(item => item.id === 'pure-rf')!,
    { frequencyGHz: 1, inputPowerDbm: -20 });
  assert.equal(rf.kind, 'rf');
  assert.deepEqual(rf.gainDb, available(15, 'dB'));
  assert.deepEqual(rf.powerDbm, available(-5, 'dBm'));
  assert.equal(rf.nfDb.availability, 'available');
  assert.equal(rf.nfDb.value.toFixed(1), '3.6');

  const supply = calculateDcBudget(project).supplies.find(item => item.endpoint.instancePath[0] === 'TX_A')!;
  assert.deepEqual(supply.demandW, available(8, 'W'));
  assert.deepEqual(supply.capacityW, available(7, 'W'));
  assert.deepEqual(supply.marginW, available(-1, 'W'));
});

test('independent transmitter example round-trips with an open port and single-ended link and produces local optical power', () => {
  const project = load('v1-tx-only.json');
  const restored = parseProjectJson(serializeProjectJson(project));
  assert.deepEqual(restored, project);
  const link = restored.namedLinks![0];
  assert.equal(createLinkBudget(restored).resolveNamedLink(link).status, 'incomplete');
  assert.equal(link.to, undefined);
  const tx = restored.moduleDefinitions.find(item => item.id === 'tx')!;
  assert.ok(tx.ports.some(port => port.id === 'TEST_OUT'));
  assert.ok(!tx.portMappings?.some(mapping => mapping.portId === 'TEST_OUT'));
  assert.deepEqual(createOpticalBudget(restored).calculateLocal({
    eo: { instancePath: ['TX_A', 'mzm'], fromPortId: 'RF_IN', toPortId: 'OUT' },
    to: { instancePath: ['TX_A'], portId: 'OPT_OUT' }, channelId: laser.channelId, sources: [laser],
  }).powerDbm, available(-5, 'dBm'));
});
