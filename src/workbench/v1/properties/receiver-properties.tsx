import { portDisplayName } from '../labels';
import { hasReceiverValue, loadedResponse, receiverMode } from '../../../engine/v1/receiver-response';
import type { Detector } from '../../../engine/v1/receiver-response';
import { resolveEmpiricalValue } from '../../../engine/v1/empirical-value';
import type { ResolvedInstance } from '../../../engine/v1/hierarchy';
import type { OpticalChannelId } from '../../../model/v1/channels';
import type { ReceiverMode } from '../../../model/v1/device';

export type ReceiverQuery = { frequencyGHz?: number; channelId?: OpticalChannelId };
const fields = ['responsivity', 'responseDb', 'loadedGain'] as const;
type Field = typeof fields[number];

export function usesReceiverField(mode: ReceiverMode | undefined, field: Field) {
  if (!mode) return false;
  return mode === 'active50' ? field !== 'responseDb' : field !== 'loadedGain';
}

export function receiverParameterVisible(instance: ResolvedInstance, parameterId: string) {
  const definition = instance.definition;
  if (definition.kind !== 'component') return true;
  const references = (value: unknown) => typeof value === 'object' && value !== null
    && 'parameterId' in value && value.parameterId === parameterId;
  let inactive = false;
  for (const transfer of definition.transfers ?? []) {
    if (transfer.kind !== 'oe') {
      if (Object.values(transfer).some(references)) return true;
      continue;
    }
    const mode = receiverMode(transfer.receiver, instance);
    for (const field of fields) {
      if (!references(transfer[field])) continue;
      if (usesReceiverField(mode, field)) return true;
      inactive = true;
    }
  }
  return !inactive || !!definition.switchStates?.some(state => state.routes.some(route => references(route.gainDb)));
}

export function ReceiverPreview({ pd, instance, query, showPorts }: {
  pd: Detector; instance: ResolvedInstance; query: ReceiverQuery; showPorts: boolean;
}) {
  const mode = receiverMode(pd.receiver, instance);
  const portName = (id: string) => portDisplayName(instance.definition.ports.find(port => port.id === id)!, false, instance.definition.ports);
  const ports = showPorts && <span>{portName(pd.fromPortId)} → {portName(pd.toPortId)} · </span>;
  if (!mode) return <p className="v1-property-effective">{ports}先选择接收结构。</p>;
  const active = mode === 'active50';
  const rho = resolveEmpiricalValue('A/W', pd.responsivity, query, instance);
  const gain = loadedResponse(pd, instance, rho, query.frequencyGHz);
  return <section className="v1-receiver-preview">
    <h3>{ports}{active ? '厂家 / 用户填写的加载转换增益 C(f)' : '有效加载转换增益（自动计算）'}</h3>
    <p>{gain.availability === 'available' ? <strong>{Number(gain.value.toPrecision(6))} V/W</strong>
      : active && !hasReceiverValue(pd.loadedGain, instance) ? '请填写加载转换增益 C(f)（V/W）。' : gain.reason}</p>
    {(query.channelId || query.frequencyGHz !== undefined) && <p>当前查询 · {[query.channelId,
      query.frequencyGHz !== undefined && `${query.frequencyGHz} GHz`].filter(Boolean).join(' · ')}</p>}
    {active ? <p>RF 预算必填外接 50 Ω 的加载转换增益。响应度可选，仅用于平均光电流。</p> : <>
      <p>R_eff = {mode === 'parallel50' ? '50 Ω ∥ 50 Ω = 25 Ω' : '50 Ω'}。C(f) = ρ(λ) × R_eff × 10^(H_PD(f)/20)。</p>
      {!hasReceiverValue(pd.responseDb, instance) && <p>未设置无源频响，按 0 dB 假定平坦。</p>}
    </>}
  </section>;
}
