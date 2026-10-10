/* Privacy-friendly visit statistics via GoatCounter (no cookies, no personal data).
   Inactive until GC_CODE is set. Dashboard: https://<GC_CODE>.goatcounter.com */
window.STATS = (() => {
  const GC_CODE = "";  // e.g. "sismopanama"
  const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  let ready = false, queue = [];
  if (GC_CODE && !local) {
    window.goatcounter = { no_onload: true, allow_local: false };
    const s = document.createElement("script");
    s.async = true;
    s.dataset.goatcounter = `https://${GC_CODE}.goatcounter.com/count`;
    s.src = "https://gc.zgo.at/count.js";
    s.onload = () => { ready = true; queue.forEach(f => f()); queue = []; };
    document.head.appendChild(s);
  }
  const send = (path, title, event) => {
    if (!GC_CODE || local) return;
    const go = () => window.goatcounter && window.goatcounter.count({ path, title, event });
    ready ? go() : queue.push(go);
  };
  return {
    page: (path, title) => send(path, title, false),      // a tab view counts as a page view
    event: (name, title) => send(name, title || name, true),
  };
})();
