// gesture.js —— 边缘右滑/左滑返回（类原生 App 手势）
// 使用 Pointer Events，统一支持触摸屏与桌面鼠标。
// 安卓习惯：从屏幕右边缘向左滑返回（iOS 为左边缘向右滑）。这里两侧边缘都支持，方向均朝屏幕内侧。
// 手势生效时 preventDefault，优先于系统返回手势，并通过 app.js 的去重逻辑避免重复返回。
(function () {
  const EDGE = 28;        // 触发区：屏幕左右边缘各 28px 内按下才开始识别
  const THRESHOLD = 60;   // 触发返回的位移阈值(px)
  const VELOCITY = 0.45;  // 快速轻扫的触发速度(px/ms)

  let startX = 0, startY = 0, curX = 0, lastX = 0, lastT = 0, vx = 0;
  let active = false, decided = false, edge = null, pointerId = null;

  const box = () => document.getElementById('sec-list');
  const miniEl = () => document.getElementById('mini-sheet');
  const miniBackdrop = () => document.getElementById('mini-sheet-backdrop');

  // 简图（底部抽屉）是否打开
  function isMiniSheetOpen() {
    const b = miniBackdrop();
    return !!(b && b.classList.contains('show'));
  }

  // 仅当「盯盘」子视图中存在返回按钮时，才允许手势返回
  function canBack() {
    const b = box();
    if (!b || b.style.display === 'none') return false;
    return !!b.querySelector('.nav-back-bottom');
  }

  // 当前打开、可被边缘滑动退出的弹窗（优先级：简图 → 提醒 → K线）
  // 任一弹窗打开时，边缘左/右滑优先触发退出该弹窗
  function activePopup() {
    if (isMiniSheetOpen()) {
      return { el: miniEl(), backdrop: miniBackdrop(), closeFn: () => window.closeMiniSheet && window.closeMiniSheet() };
    }
    const alertSheet = document.getElementById('alert-sheet');
    if (alertSheet && alertSheet.classList.contains('show')) {
      const sheet = alertSheet.querySelector('.action-sheet') || alertSheet;
      return { el: sheet, backdrop: alertSheet, closeFn: () => window.closeAlertSheet && window.closeAlertSheet() };
    }
    const klineBd = document.getElementById('kline-sheet-backdrop');
    if (klineBd && klineBd.classList.contains('show')) {
      return { el: document.getElementById('kline-sheet'), backdrop: klineBd, closeFn: () => window.closeKlineSheet && window.closeKlineSheet() };
    }
    return null;
  }

  function onDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const popup = activePopup();
    const back = !popup && canBack();
    if (!popup && !back) return; // 弹窗打开时，边缘左/右滑优先退出弹窗
    const w = window.innerWidth;
    if (e.clientX <= EDGE) edge = 'left';
    else if (e.clientX >= w - EDGE) edge = 'right';
    else return;
    startX = e.clientX; startY = e.clientY;
    curX = startX; lastX = startX; lastT = e.timeStamp; vx = 0;
    active = true; decided = false; pointerId = e.pointerId;
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  function onMove(e) {
    if (!active || e.pointerId !== pointerId) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    // 仅允许向屏幕内侧滑动：左边缘向右(dx>0)，右边缘向左(dx<0)
    const inward = edge === 'left' ? dx > 0 : dx < 0;
    if (!decided) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      if (Math.abs(dy) > Math.abs(dx)) { cancel(); return; } // 纵向滚动，放弃
      if (!inward) { cancel(); return; }                      // 向外滑，放弃
      decided = true;
    }
    if (!inward) return;
    if (e.cancelable) e.preventDefault(); // 优先于系统返回手势，避免双重触发
    curX = e.clientX;
    const dt = Math.max(1, e.timeStamp - lastT);
    vx = (curX - lastX) / dt;
    lastX = curX; lastT = e.timeStamp;

    // 弹窗开启：横向拖拽弹窗本身并淡化遮罩，作为跟手反馈（简图/提醒/K线 统一处理）
    const popup = activePopup();
    if (popup) {
      const el = popup.el, bd = popup.backdrop;
      if (el) { el.style.transition = 'none'; el.style.transform = 'translateX(' + dx + 'px)'; }
      if (bd) { bd.style.transition = 'none'; bd.style.opacity = String(Math.max(0, 1 - Math.abs(dx) / 400)); }
      return;
    }

    const b = box();
    if (b) {
      b.classList.add('swiping');
      b.style.transform = 'translateX(' + dx + 'px)';
      const sh = edge === 'left' ? '-14px 0 28px' : '14px 0 28px';
      b.style.boxShadow = sh + ' rgba(0,0,0,' + Math.min(0.18, Math.abs(dx) / 400) + ')';
    }
  }

  function onUp() {
    if (!active) { cleanup(); return; }
    const dx = curX - startX;
    const popup = activePopup();
    const commit = Math.abs(dx) > THRESHOLD || (Math.abs(vx) > VELOCITY && Math.abs(dx) > 24);

    // 弹窗开启：边缘左/右滑达标则退出弹窗，否则回弹归位（简图/提醒/K线 统一处理）
    if (popup) {
      const el = popup.el, bd = popup.backdrop;
      if (commit) {
        if (el) { el.style.transition = 'transform .22s ease'; el.style.transform = 'translateX(' + (edge === 'left' ? '100%' : '-100%') + ')'; }
        if (bd) { bd.style.transition = 'opacity .22s ease'; bd.style.opacity = '0'; }
        cleanup();
        setTimeout(() => { if (popup.closeFn) popup.closeFn(); }, 220);
        return;
      }
      if (el) { el.style.transition = 'transform .22s ease'; el.style.transform = 'translateX(0)'; }
      if (bd) { bd.style.transition = 'opacity .22s ease'; bd.style.opacity = ''; }
      setTimeout(() => {
        const e2 = popup.el, b2 = popup.backdrop;
        if (e2) { e2.style.transition = ''; e2.style.transform = ''; }
        if (b2) { b2.style.transition = ''; b2.style.opacity = ''; }
      }, 230);
      cleanup();
      return;
    }

    const b = box();
    if (b) {
      b.classList.remove('swiping');
      if (commit) {
        // 保留容器当前拖拽位移作为手势预览，直接交给卡片级「自上而下依次左移消失」，
        // 不再整块滑动/回弹，避免旧版整块位移残留。
        b.style.boxShadow = '';
        b.style.transition = '';
        cleanup(true);
        if (window.goBack) window.goBack();
        return;
      }
      // 未达阈值：整块回弹
      b.style.transition = 'transform .22s ease';
      b.style.transform = 'translateX(0)';
      b.style.boxShadow = '';
      setTimeout(() => reset(b), 230);
    }
    cleanup();
  }

  function reset(b) {
    if (!b) return;
    b.style.transform = '';
    b.style.boxShadow = '';
    b.style.transition = '';
    b.classList.remove('swiping');
  }

  function cancel() {
    active = false;
    const b = box();
    if (b) reset(b);
    cleanup();
  }

  function cleanup(keepActive) {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    if (!keepActive) active = false;
  }

  window.addEventListener('pointerdown', onDown, { passive: true });

  // 暴露弹窗检测函数，供 app.js 在 popstate / 系统返回键等场景中调用
  window.__hasActivePopup = function () {
    return activePopup() !== null;
  };
  window.__closeActivePopup = function () {
    const p = activePopup();
    if (p && p.closeFn) { p.closeFn(); return true; }
    return false;
  };
})();
