import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createLinkBudget } from '../../src/engine/v1/link-budget';
import type { LinkTrial } from '../../src/model/v1/topology';
import { planPortDeletion } from '../../src/state/v1/topology-edits';
import { parseProjectJson, serializeProjectJson } from '../../src/storage/v1/project-json';
import { projectFileName, sameTrial } from '../../src/workbench/v1/budgets/trial-conditions';

const example = () => parseProjectJson(readFileSync(new URL('../../examples/v1-project.json', import.meta.url), 'utf8'));
const trial: LinkTrial = { frequencyGHz: 1, inputPowerDbm: -20, opticalSources: [
  { endpoint: { instancePath: ['TX_A', 'laser'], portId: 'OUT' }, channelId: 'DWDM_CH28', powerDbm: 0 },
] };

test('saved link trials persist inputs and recalculate using the current project', () => {
  const project = example();
  const withTrial = { ...project, namedLinks: project.namedLinks!.map(link => link.id === 'full' ? { ...link, trial } : link) };
  const json = serializeProjectJson(withTrial);
  assert.doesNotMatch(json, /"gainDb": -22|"powerDbm": -42|"pdPowerDbm"/);
  const restored = parseProjectJson(json);
  const link = restored.namedLinks!.find(item => item.id === 'full')!;
  assert.deepEqual(link.trial, trial);
  assert.equal(sameTrial(link.trial, trial), true);
  assert.equal(sameTrial(undefined, trial), false);
  assert.equal(sameTrial(link.trial, { ...trial, frequencyGHz: 2 }), false);
  const result = createLinkBudget(restored).calculateNamedLink(link, link.trial!);
  assert.deepEqual(result.powerDbm, { availability: 'available', unit: 'dBm', value: -42 });
  assert.throws(() => serializeProjectJson({ ...withTrial, namedLinks: [{ ...link, trial: { ...trial, frequencyGHz: 68 } }] }), /试算频率/);
  const laserId = project.moduleDefinitions.find(module => module.id === 'tx')!.instances.find(instance => instance.id === 'laser')!.definitionId;
  const plan = planPortDeletion(restored, laserId, 'OUT')!;
  assert.ok(plan.impacts.some(impact => impact.name.includes('试算光源')));
  const deleted = parseProjectJson(serializeProjectJson(plan.project)).namedLinks!.find(item => item.id === 'full')!;
  assert.deepEqual(deleted.trial?.opticalSources, []);
  assert.equal(deleted.trial?.frequencyGHz, 1);
});

test('saved filenames preserve the project name and avoid invalid filename characters', () => {
  assert.equal(projectFileName('光链路/验收'), '光链路_验收.json');
  assert.equal(projectFileName('project.json'), 'project.json');
  assert.equal(projectFileName('NUL'), '_NUL.json');
});
