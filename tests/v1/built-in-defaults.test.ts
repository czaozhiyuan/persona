import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BudgetMetric } from '../../src/engine/v1/budget-metric';
import { createConversionBudget } from '../../src/engine/v1/conversion-budget';
import { calculateDcBudget } from '../../src/engine/v1/dc-budget';
import { createOpticalBudget } from '../../src/engine/v1/optical-budget';
import { createPathResolver } from '../../src/engine/v1/path-resolver';
import { insertLibraryItem } from '../../src/library/v1/insert-library-item';
import type { Connection } from '../../src/model/v1/topology';
import type { Project } from '../../src/model/v1/types';
import { addDefinitionPort } from '../../src/state/v1/module-ports';
import { parseProjectJson, serializeProjectJson } from '../../src/storage/v1/project-json';

const fixed = (value: number) => ({ kind: 'fixed' as const, value });
const endpoint = (id: string, portId: string) => ({ instancePath: [id], portId });
const wire = (from: string, out: string, to: string, input: string) => ({
  id: [from, out, to, input].join('-'), from: { instanceId: from, portId: out }, to: { instanceId: to, portId: input },
});

function network(parts: Record<string, string>, connections: Connection[]): Project {
  let project: Project = { id: 'defaults', name: 'Defaults', rootModuleDefinitionId: 'root', componentDefinitions: [],
    moduleDefinitions: [{ id: 'root', kind: 'module', name: 'Root', ports: [], instances: [] }] };
  for (const [id, template] of Object.entries(parts)) {
    project = insertLibraryItem(project, { source: 'template', id: 'library-' + template, name: id }, 'root', [], id);
  }
  return parseProjectJson(serializeProjectJson({ ...project, moduleDefinitions: [{ ...project.moduleDefinitions[0], connections }] }));
}

function near(metric: BudgetMetric, expected: number) {
  assert.equal(metric.availability, 'available');
  assert.ok(Math.abs(metric.value - expected) < 1e-8, `${metric.value} != ${expected}`);
}

test('factory laser, MZM, DML and passive PD run from their resolved defaults; active gain remains required', () => {
  const link = { id: 'link', name: 'RF', from: endpoint('tx', 'RF_IN'), to: endpoint('pd', 'RF_OUT') };
  const trial = { frequencyGHz: 2, inputPowerDbm: 0 };
  const rx = wire('tx', 'OPT_OUT', 'pd', 'OPT_IN');
  const coherent = network({ laser: 'laser', tx: 'mzm', pd: 'pd' }, [wire('laser', 'OPT_OUT', 'tx', 'LASER_IN'), rx]);
  const direct = network({ tx: 'dml', pd: 'pd' }, [rx]);
  const mzm = createConversionBudget(coherent).calculateNamedLink(link, trial);
  const quadratureDbm = 16 - 3 - 10 * Math.log10(2);
  near(mzm.segments[0].pdPowerDbm, quadratureDbm);
  near(mzm.powerDbm, 2 * (quadratureDbm - 30) + 20 * Math.log10(Math.PI * 40 / 5));
  const dml = createConversionBudget(direct).calculateNamedLink(link, trial);
  near(dml.segments[0].pdPowerDbm, 16);
  near(dml.powerDbm, 20 * Math.log10(0.01 * 40));
  const active = createConversionBudget({ ...direct, instanceSettings: [
    { instancePath: ['pd'], parameterOverrides: { receiver: 'active50' } },
  ] }).calculateNamedLink(link, trial);
  assert.equal(active.powerDbm.availability, 'unavailable');
  assert.match(active.powerDbm.reason, /加载转换增益/);
});

test('SFP budgets read the factory threshold and per-channel power from each installed instance', () => {
  const base = network({ a: 'sfp', loss: 'optical-attenuator', b: 'sfp' },
    [wire('a', 'OPT_TX_OUT', 'loss', 'OPT_IN'), wire('loss', 'OPT_OUT', 'b', 'OPT_RX_IN')]);
  const link = { id: 'digital', name: 'Digital', from: endpoint('a', 'DATA_TX_IN'), to: endpoint('b', 'DATA_RX_OUT'), channelId: 'DWDM_CH28' as const };
  function digital(launch?: number) {
    const project: Project = { ...base, instanceSettings: [{ instancePath: ['loss'], parameterOverrides: { gain: fixed(-2) } },
      ...(launch === undefined ? [] : [{ instancePath: ['a'], parameterOverrides: { power: fixed(launch) } }])] };
    const path = createPathResolver(project).resolveNamedLink(link);
    assert.equal(path.status, 'resolved');
    return createOpticalBudget(project).calculateDigitalPath(path.trace, link.channelId)!;
  }
  const nominal = digital();
  near(nominal.powerDbm, -2);
  near(nominal.digitalReceiver!.margin, 18);
  assert.equal(nominal.digitalReceiver!.aboveLimit, false);
  assert.equal(digital(3).digitalReceiver!.aboveLimit, true);

  const source = network({ source: 'optical-source' }, []);
  for (const channelId of ['DWDM_CH28', 'DWDM_CH30'] as const) {
    const ref = endpoint('source', 'OPT_OUT');
    near(createOpticalBudget(source).calculateLocal({ source: { endpoint: ref, channelId }, to: ref }).powerDbm, 16);
  }
});

test('factory power budgets keep the single supply rating and converter capacity at their actual sources', () => {
  const base = network({ supply: 'dc-supply', converter: 'dc-converter', load: 'pcb' },
    [wire('supply', 'DC_OUT', 'converter', 'DC_IN'), wire('converter', 'DC_OUT', 'load', 'DC_IN')]);
  assert.ok(base.componentDefinitions.every(definition => definition.dcLoad === undefined));
  const [supply, converter, load] = base.componentDefinitions;
  const project = addDefinitionPort({ ...base, componentDefinitions: [supply, converter,
    { ...load, dcLoad: { portId: 'DC_IN', powerW: fixed(9) } }] }, supply.id,
    { id: 'extra', type: 'DC_POWER', direction: 'out' });
  const budget = calculateDcBudget(project);
  const rail = budget.supplies.find(item => item.endpoint.portId === 'DC_OUT')!;
  near(rail.capacityW, 60); near(rail.demandW, 10); near(rail.voltageV, 5);
  assert.equal(budget.supplies.find(item => item.endpoint.portId === 'extra')!.capacityW.availability, 'unavailable');
  near(budget.converters[0].efficiency, 0.9); near(budget.converters[0].output.capacityW, 10);
  near(budget.converters[0].output.voltageV, 5);
});
