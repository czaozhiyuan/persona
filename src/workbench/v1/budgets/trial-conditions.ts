import { signalPortKey } from '../../../engine/v1/signal-graph';
import type { LinkTrial } from '../../../model/v1/topology';

export function projectFileName(projectName: string) {
  const name = projectName.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '');
  if (!name) return 'persona-project.json';
  const safe = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? '_' + name : name;
  return safe.toLowerCase().endsWith('.json') ? safe : safe + '.json';
}

export function sameTrial(saved: LinkTrial | undefined, current: LinkTrial): boolean {
  if (!saved || saved.frequencyGHz !== current.frequencyGHz || saved.inputPowerDbm !== current.inputPowerDbm) return false;
  const sources = current.opticalSources ?? [];
  const previous = saved.opticalSources ?? [];
  const key = (source: NonNullable<LinkTrial['opticalSources']>[number]) =>
    JSON.stringify([signalPortKey(source.endpoint), source.channelId, source.powerDbm]);
  const keys = new Set(previous.map(key));
  return sources.length === previous.length && sources.every(source => keys.has(key(source)));
}
