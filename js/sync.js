// sync.js —— 与桌面端互导画线 JSON
import { fromDrawings, toDrawings } from './model.js?v=20260724i';

export function exportJSON(segments, zhongshus) {
  const data = toDrawings(segments, zhongshus);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `chan-m-drawings-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function exportPackage(code, period, segments, zhongshus) {
  const payload = { code, period, segments, zhongshus };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });

  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${code}_${period}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function importJSON(file, cb) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const json = JSON.parse(reader.result);
      if (Array.isArray(json)) {
        cb(fromDrawings(json)); // 桌面端导出的 drawings 数组
      } else if (json.segments) {
        cb({ segments: json.segments, zhongshus: json.zhongshus || [] });
      } else {
        alert('无法识别的 JSON 格式');
      }
    } catch (e) { alert('解析失败：' + e.message); }
  };
  reader.readAsText(file);
}

// 由 sh/sz 代码取反向前缀（解决沪/深同号歧义）
function altMarketCode(code) {
  if (code.startsWith('sh')) return 'sz' + code.slice(2);
  if (code.startsWith('sz')) return 'sh' + code.slice(2);
  return null;
}

async function tryLoadOne(code, period) {
  try {
    const url = `data/${code}_${period}.json?v=${Date.now()}`;
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) return null;
    const json = await res.json();
    if (Array.isArray(json)) {
      const d = fromDrawings(json);
      return { segments: d.segments, zhongshus: d.zhongshus, exportedAt: 0 };
    }
    if (json.segments) {
      const result = {
        segments: json.segments,
        zhongshus: json.zhongshus || [],
        exportedAt: json.exportedAt || 0,
      };
      // 包含多方案信息
      if (json.presets && Array.isArray(json.presets) && json.presets.length > 0) {
        result.presets = json.presets;
        result.activePreset = json.activePreset || 'default';
        result.presetName = json.presetName || null;
      }
      // 包含 K 线 bars
      if (json.bars) {
        result.bars = json.bars;
      }
      return result;
    }
    return null;
  } catch (e) {
    console.warn(`Chan-M: 加载 ${code}_${period}.json 失败:`, e.message);
    return null;
  }
}

// 从站点静态 data 目录加载预置画线（GitHub Pages 部署用）
// 主代码查不到时，自动再试反向前缀（如 sh000001 ↔ sz000001），
// 以兼容 PC 端导出时使用的市场与手机端自动推断不一致的情况。
export async function loadStaticData(code, period) {
  const candidates = [code, altMarketCode(code)].filter(Boolean);
  for (const c of candidates) {
    const data = await tryLoadOne(c, period);
    if (data) return data;
  }
  return null;
}
