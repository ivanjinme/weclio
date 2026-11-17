// 静态入口的首帧外观恢复：必须早于模块加载，且不能是内联脚本（CSP 只允许 'self'）。
(function () {
  try {
    var d = document.documentElement, t = localStorage.getItem("weclio-theme");
    if (t === "dark") d.classList.add("dark");
    var w = Number(localStorage.getItem("weclio:sidebar-width"));
    if (Number.isFinite(w) && w >= 240 && w <= 480) d.style.setProperty("--saved-sidebar-width", w + "px");
  } catch {
    // 存储不可用时保持默认外观，不阻断首帧。
  }
})();
