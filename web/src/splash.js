// The splash screen (#splash in index.html) is closed here — once, after the first
// data arrives or an error that must be visible. It shows for at least MIN_MS since
// navigation started: long enough for one logo motion so the brand is remembered, not
// long enough to feel like a delay. A slow connection adds no artificial waiting
// time — the screen closes as soon as data exists.
//
// The closing is a transition: the logo flies and shrinks exactly onto the header logo while
// the background fades, then the header logo welcomes with one arrow shot (once,
// then still — .brand-arrive in index.css). Without a visible header, with
// prefers-reduced-motion, or in a background tab: it just fades.
const MIN_MS = 1500;
const MAX_MS = 8_000;    // The API does not answer: do not trap the user on the logo

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// The header logo currently visible: the sidebar on desktop, the top header on mobile.
function visibleBrandLogo() {
  return [...document.querySelectorAll('[data-brand-logo]')]
    .find((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
}

// The splash arrow animation repeats; stop it smoothly from the current pose
// (not jumping) so that what flies is a still logo.
function settle(logo) {
  for (const n of logo.querySelectorAll('svg, path')) {
    const cs = getComputedStyle(n);
    const tf = cs.transform, op = cs.opacity;
    n.style.animation = 'none';
    n.style.transform = tf === 'none' ? '' : tf;
    n.style.opacity = op;
    n.getBoundingClientRect();   // force the style to apply before the transition
    n.style.transition = 'transform .25s ease, opacity .25s ease';
    n.style.transform = '';
    n.style.opacity = '1';
  }
}

const root = document.documentElement;

// The menu & page contents appear in sequence (html.app-enter in index.css).
function reveal() {
  if (!root.classList.contains('has-splash')) return;
  root.classList.add('app-enter');
  root.classList.remove('has-splash');
  setTimeout(() => root.classList.remove('app-enter'), 1600);
}

function land(el, target) {
  reveal();
  root.classList.remove('brand-pending');
  if (target) {
    target.style.visibility = '';
    const brand = target.closest('[data-brand]');
    if (brand) {
      brand.classList.add('brand-arrive');
      setTimeout(() => brand.classList.remove('brand-arrive'), 1600);
    }
  }
  el.remove();
}

function fly(el) {
  const logo = el.querySelector('.sp-logo');
  const target = visibleBrandLogo();
  if (!logo || !target || reducedMotion() || document.hidden) return false;
  settle(logo);
  const a = logo.getBoundingClientRect(), b = target.getBoundingClientRect();
  const scale = b.width / a.width;
  const dx = b.left + b.width / 2 - (a.left + a.width / 2);
  const dy = b.top + b.height / 2 - (a.top + a.height / 2);
  target.style.visibility = 'hidden';   // one logo on screen, not two
  root.classList.add('brand-pending');  // the caption under the logo appears after landing
  el.dataset.state = 'flying';
  logo.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
  // Fast-then-slow motion: the logo is practically in place at ~60% of the duration —
  // the page content starts appearing there, not waiting for the logo to fully stop.
  setTimeout(reveal, 360);
  let done = false;
  const finish = () => { if (!done) { done = true; land(el, target); } };
  logo.addEventListener('transitionend', (e) => { if (e.target === logo && e.propertyName === 'transform') finish(); });
  setTimeout(finish, 1000);   // the transition does not report (the tab switched midway)
  return true;
}

let closing = false;
export function hideSplash() {
  const el = document.getElementById('splash');
  // Without the splash screen (already removed): the page content must not stay hidden.
  if (!el) { root.classList.remove('has-splash', 'brand-pending'); return; }
  // Also when flagged as failed: data has arrived, so the app works.
  if (closing) return;
  closing = true;
  setTimeout(() => {
    if (!el.classList.contains('sp-failed') && fly(el)) return;
    reveal();   // without flying: the page content appears beneath the fading screen
    el.dataset.state = 'leaving';
    let done = false;
    const finish = () => { if (!done) { done = true; land(el, null); } };
    el.addEventListener('transitionend', finish, { once: true });
    setTimeout(finish, 600);   // the transition does not run (background tab, reduced motion)
  }, Math.max(0, MIN_MS - performance.now()));
}

export function armSplashTimeout() {
  setTimeout(hideSplash, Math.max(0, MAX_MS - performance.now()));
}
