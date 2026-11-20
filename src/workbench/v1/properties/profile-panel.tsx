import { useState } from 'react';
import { DEFAULT_CONVERSION_K } from '../../../model/v1/device';
import type { ConversionProfile } from '../../../model/v1/device';
import type { ProjectStore } from '../../../state/v1/project-store';
import { EmpiricalField, numberField, readEmpirical, textField } from './value-fields';

function ProfileForm({ profile, save }: { profile?: ConversionProfile; save: (read: () => ConversionProfile) => void }) {
  const [kind, setKind] = useState(profile?.rfGainRefDb.kind ?? 'fixed');
  return <form onSubmit={event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    save(() => {
      const name = textField(data, 'name');
      const rfGainRefDb = readEmpirical(data, 'gain', kind);
      if (!name || !rfGainRefDb) throw new Error('请填写标定名称和基准射频增益。');
      return {
        ...profile, id: profile?.id ?? crypto.randomUUID(), name, rfGainRefDb,
        pdPowerRefDbm: numberField(data, 'pdReference', true)!, k: numberField(data, 'k'),
      };
    });
  }}>
    <label>标定名称<input name="name" defaultValue={profile?.name} required /></label>
    <label>基准射频增益类型<select value={kind} onChange={event => setKind(event.target.value as typeof kind)}>
      <option value="fixed">固定值</option><option value="rfCurve">射频曲线折点</option>
    </select></label>
    <EmpiricalField key={kind} name="gain" kind={kind} label="整段基准射频增益 (dB)" value={profile?.rfGainRefDb} required />
    <div className="v1-property-pair">
      <label>探测器参考光功率 (dBm)<input name="pdReference" type="number" step="any" defaultValue={profile?.pdPowerRefDbm} required /></label>
      <label>经验系数 K<input name="k" type="number" step="any" defaultValue={profile?.k} placeholder={String(DEFAULT_CONVERSION_K)} /></label>
    </div>
    <p className="v1-property-effective">留空时使用默认 K = {DEFAULT_CONVERSION_K}</p>
    <button type="submit">{profile ? '保存标定方案' : '新建标定方案'}</button>
  </form>;
}

export function ProfilePanel({ store, profiles }: { store: ProjectStore; profiles: readonly ConversionProfile[] }) {
  const [id, setId] = useState('');
  const [error, setError] = useState('');
  const profile = profiles.find(item => item.id === id);
  return <section className="panel v1-properties" aria-labelledby="v1-profile-heading">
    <h2 id="v1-profile-heading">工程标定方案</h2>
    <label>工程内标定方案<select value={profile?.id ?? ''} onChange={event => { setId(event.target.value); setError(''); }}>
      <option value="">新建标定方案</option>
      {profiles.map(item => <option key={item.id} value={item.id}>{item.name} ({item.id})</option>)}
    </select></label>
    <ProfileForm profile={profile} key={JSON.stringify(profile ?? null)} save={read => {
      let saved = '';
      const result = store.commit(draft => {
        const next = read();
        saved = next.id;
        const items = draft.conversionProfiles ?? [];
        return { ...draft, conversionProfiles: profile
          ? items.map(item => item.id === profile.id ? next : item)
          : [...items, next] };
      });
      if (result.ok) setId(saved);
      setError(result.ok ? '' : result.message);
    }} />
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
