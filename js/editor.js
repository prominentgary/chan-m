// editor.js —— 用日期时间编辑段端点（非图上点）
import { secToInputValue, inputValueToSec, formatTime } from './fetcher.js?v=20260714s';

let modal, startEl, endEl, saveCb, editSeg, startLockedFlag;

function ensureModal() {
  if (modal) return;
  modal = document.createElement('div');
  modal.className = 'modal-mask';
  modal.innerHTML = `
    <div class="modal">
      <label>起点时间<input type="datetime-local" id="ed-start"></label>
      <div class="locked-hint" id="ed-start-hint" hidden>起点为上一段终点，不可修改</div>
      <label>终点时间<input type="datetime-local" id="ed-end"></label>
      <div class="modal-actions">
        <button id="ed-cancel" class="mini">取消</button>
        <button id="ed-save" class="primary">保存</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  startEl = modal.querySelector('#ed-start');
  endEl = modal.querySelector('#ed-end');
  modal.querySelector('#ed-cancel').onclick = () => (modal.style.display = 'none');
  modal.querySelector('#ed-save').onclick = () => {
    const s = startLockedFlag && editSeg ? editSeg.start.time : inputValueToSec(startEl.value);
    const e = inputValueToSec(endEl.value);
    if (e <= s) { alert('终点必须晚于起点'); return; }
    modal.style.display = 'none';
    saveCb && saveCb(s, e);
  };
}

// startLocked：true 表示该段起点连接着上一段终点，起点不可编辑
export function openEditor(seg, onSave, defaults, startLocked) {
  ensureModal();
  const now = Math.floor(Date.now() / 1000);
  let startTime, endTime;
  if (seg) {
    startTime = seg.start.time;
    endTime = seg.end.time;
  } else if (defaults) {
    startTime = defaults.startTime ?? now - 3600;
    endTime = defaults.endTime ?? now;
  } else {
    startTime = now - 3600;
    endTime = now;
  }
  editSeg = seg || null;
  startLockedFlag = !!startLocked;
  startEl.value = secToInputValue(startTime);
  startEl.disabled = startLockedFlag;
  startEl.classList.toggle('locked', startLockedFlag);
  const hint = modal.querySelector('#ed-start-hint');
  if (hint) hint.hidden = !startLockedFlag;
  endEl.value = secToInputValue(endTime);
  saveCb = onSave;
  modal.style.display = 'flex';
}
