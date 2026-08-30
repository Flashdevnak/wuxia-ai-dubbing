(() => {
  const root = document.documentElement;
  const syncVisibility = () => root.classList.toggle('page-hidden', document.hidden);
  syncVisibility();
  document.addEventListener('visibilitychange', syncVisibility, { passive: true });

  // Trim decorative embers from the DOM after app.js creates them.
  const trimSparks = () => {
    const field = document.getElementById('sparkField');
    if (!field) return;
    const coarse = matchMedia('(pointer: coarse)').matches;
    const narrow = matchMedia('(max-width: 900px)').matches;
    const keep = coarse || narrow ? 12 : 30;
    while (field.children.length > keep) field.lastElementChild.remove();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', trimSparks, { once: true });
  } else {
    trimSparks();
  }
  setTimeout(trimSparks, 0);
})();
