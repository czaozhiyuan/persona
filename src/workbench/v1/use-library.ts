import { useState } from 'react';
import { factoryLibrary, parseLibrary, validateLibrary } from '../../library/v1/user-library';
import type { LibraryConfig } from '../../library/v1/user-library';

const key = 'persona-library-v1';

function load() {
  try {
    const source = localStorage.getItem(key);
    if (source !== null) {
      try { return { config: parseLibrary(source), status: '已从当前浏览器恢复器件库。', damaged: false }; }
      catch { return { config: factoryLibrary(), damaged: true, status: '浏览器中的库记录已损坏。请导入备份或恢复全部默认库。' }; }
    }
    return { config: factoryLibrary(), status: '此浏览器尚无本地库记录。更换文件、浏览器或清理存储后，请导入库备份。' };
  } catch {
    return { config: factoryLibrary(), status: '无法读取浏览器器件库。请导入备份，并及时导出库 JSON。' };
  }
}

export function useLibrary() {
  const [state, setState] = useState(load);
  const [exported, setExported] = useState<LibraryConfig>();
  function replace(config: LibraryConfig, replaceCache = false) {
    validateLibrary(config);
    if (state.damaged && !replaceCache) {
      setState({ config, damaged: true, status: '原有浏览器记录已损坏。本次修改仅在页面中有效，请导出库 JSON。' });
      return;
    }
    let status = '当前浏览器已保存。跨浏览器或文件使用时，请导出库 JSON。';
    try { localStorage.setItem(key, JSON.stringify(config)); }
    catch { status = '本次修改仅在当前页面有效。浏览器存储不可用，请立即导出库 JSON。'; }
    setState({ config, status });
  }
  return { ...state, replace, exported: exported === state.config, markExported: () => setExported(state.config) };
}
export type UserLibrary = ReturnType<typeof useLibrary>;
