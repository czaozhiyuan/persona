import { useState } from 'react';
import { factoryLibrary, parseLibrary, validateLibrary } from '../../library/v1/user-library';
import type { LibraryConfig } from '../../library/v1/user-library';

const key = 'persona-library-v1';

type LibraryState = {
  config: LibraryConfig;
  status: string;
  source?: string | null;
  damaged?: boolean;
  conflict?: boolean;
};

function load(): LibraryState {
  try {
    const source = localStorage.getItem(key);
    if (source !== null) {
      try { return { source, config: parseLibrary(source), status: '已从当前浏览器恢复器件库。' }; }
      catch { return { source, config: factoryLibrary(), damaged: true, status: '浏览器中的库记录已损坏。请导入备份或恢复全部默认库。' }; }
    }
    return { source, config: factoryLibrary(), status: '此浏览器尚无本地库记录。更换文件、浏览器或清理存储后，请导入库备份。' };
  } catch {
    return { config: factoryLibrary(), status: '无法读取浏览器器件库。请导入备份，并及时导出库 JSON。' };
  }
}

export function useLibrary() {
  const [state, setState] = useState(load);
  const [requested, setRequested] = useState<LibraryConfig>();
  function replace(config: LibraryConfig, replaceCache = false) {
    validateLibrary(config);
    try {
      const current = localStorage.getItem(key);
      if (current !== (state.source ?? null)) {
        setState({ ...state, config, conflict: true,
          status: '浏览器中的器件库已在其他标签页更改。本页修改仅保留在当前页面，请先导出，再重新载入浏览器中的库。' });
        return;
      }
      if (state.damaged && !replaceCache) {
        setState({ ...state, config, status: '原有浏览器记录已损坏。本次修改仅在页面中有效，请导出库 JSON。' });
        return;
      }
      const source = JSON.stringify(config);
      localStorage.setItem(key, source);
      setState({ source, config, status: '当前浏览器已保存。跨浏览器或文件使用时，请导出库 JSON。' });
    } catch {
      setState({ ...state, config, status: '本次修改仅在当前页面有效。浏览器存储不可用，请立即导出库 JSON。' });
    }
  }
  function reload() {
    const latest = load();
    if (latest.source === undefined || latest.damaged) {
      setState({ ...state, status: '无法载入浏览器中的库。本页修改仍然保留，请导出库 JSON。' });
      return;
    }
    setState(latest);
  }
  return { ...state, replace, reload, downloadRequested: requested === state.config, markDownloadRequested: () => setRequested(state.config) };
}
export type UserLibrary = ReturnType<typeof useLibrary>;
