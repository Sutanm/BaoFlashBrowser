/// <reference lib="dom" />

// GitHub's SSR content is present even when its import-map modules cannot
// hydrate on Chromium 87. Restore the existing reveal transitions without
// exposing inactive carousel slides, menus or every opacity:0 element.
export function installGitHubContentFallback(nativeModules = false): void {
  const scriptClass = HTMLScriptElement as typeof HTMLScriptElement & { supports?: (type: string) => boolean };
  if (scriptClass.supports?.('importmap')) return;
  const hiddenClasses = [
    'lp-SectionHero-content--hidden', 'lp-SectionTemplate-grid--hidden',
    'Security-grid--hidden', 'Security-grid--hiddenOnMobile',
    'lp-CustomerStories-grid--hidden',
  ];
  const selectors = ['.lp-SectionIntro-content', '.lp-Cta', ...hiddenClasses.map(name => '.' + name)].join(',');
  const seen = new WeakSet<Element>();
  const mediaSeen = new WeakSet<Element>();
  const activeVideos = new WeakSet<Element>();
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let ready = false;
  let scanTimer: number | null = null;
  let heroAsset: Promise<string | null> | null = null;
  const nativeDeadline = Date.now() + 12000;
  const frames = new Set<HTMLElement>();
  const sizeFrame = (frame: HTMLElement): void => {
    const value = getComputedStyle(frame).getPropertyValue('--bf-aspect-ratio').trim();
    const match = value.match(/^(?:auto\s+)?([\d.]+)(?:\s*\/\s*([\d.]+))?$/);
    if (!match) return;
    const ratio = Number(match[1]) / Number(match[2] || 1);
    const width = frame.getBoundingClientRect().width;
    if (ratio > 0 && width > 0) {
      const height = width / ratio + 'px';
      if (frame.style.height !== height) frame.style.height = height;
    }
  };
  const frameResize = new ResizeObserver(entries => { for (const entry of entries) sizeFrame(entry.target as HTMLElement); });
  if (!CSS.supports('aspect-ratio', '1')) {
    const style = document.createElement('style');
    style.textContent = '*{--bf-aspect-ratio:initial}';
    document.head?.insertBefore(style, document.head.firstChild);
    window.addEventListener('resize', () => { for (const frame of frames) sizeFrame(frame); }, { passive: true });
  }

  const reveal = (el: Element): void => {
    el.classList.add('is-visible');
    for (const name of hiddenClasses) el.classList.remove(name);
    el.setAttribute('data-bf-revealed', '1');
  };
  const reveals = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      reveal(entry.target);
      reveals.unobserve(entry.target);
    }
  }, { rootMargin: '80px 0px', threshold: 0.05 });

  // Read the current hashed asset name from GitHub's own page bundle;
  // never pin a filename that will go stale at the next deployment.
  const findHeroAsset = (): Promise<string | null> => {
    if (heroAsset) return heroAsset;
    heroAsset = (async () => {
      const script = document.querySelector<HTMLScriptElement>('script[src*="/landing-pages-"]');
      if (!script) return null;
      const url = new URL(script.src);
      if (url.protocol !== 'https:' || url.hostname !== 'github.githubassets.com') return null;
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch(url.href, { signal: controller.signal, cache: 'force-cache' });
        if (!response.ok) return null;
        const text = await response.text();
        const match = text.match(/"(code-1_desktop-[a-z0-9]+\.mp4)"/);
        return match ? new URL(match[1], url).href : null;
      } catch { return null; } finally { clearTimeout(timer); }
    })();
    return heroAsset;
  };

  const videos = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const video = entry.target as HTMLVideoElement;
      if (!entry.isIntersecting) { activeVideos.delete(video); video.pause(); continue; }
      activeVideos.add(video);
      if (!video.getAttribute('src') && !video.querySelector('source')) {
        void findHeroAsset().then(src => {
          if (!src || !video.isConnected || video.getAttribute('src') || video.querySelector('source')) return;
          video.src = src;
          video.muted = true;
          video.loop = true;
          video.playsInline = true;
          video.controls = true;
          video.preload = 'metadata';
          if (!reducedMotion.matches && activeVideos.has(video)) void video.play().catch(() => {});
        });
      } else if (!reducedMotion.matches) {
        void video.play().catch(() => {});
      }
    }
  }, { rootMargin: '100px 0px' });

  const scan = (): void => {
    scanTimer = null;
    const home = document.querySelector('.lp-Home');
    if (!home) return;
    for (const frame of frames) {
      if (!frame.isConnected) { frameResize.unobserve(frame); frames.delete(frame); }
    }
    if (!CSS.supports('aspect-ratio', '1')) {
      for (const frame of Array.from(home.querySelectorAll<HTMLElement>('.lp-SectionHero-visual-frame'))) {
        if (!frames.has(frame)) { frames.add(frame); frameResize.observe(frame); }
        sizeFrame(frame);
      }
    }
    // Native React owns reveals/carousels when the module bridge succeeds.
    // Keep only the old-engine layout fix; retain a bounded fallback if native
    // hydration never finishes (offline/failed CDN chunks).
    if (nativeModules || document.querySelector('react-app[app-name="landing-pages"].loaded')) return;
    if (document.documentElement.hasAttribute('data-bf-github-module-active') && Date.now() < nativeDeadline) {
      scanTimer = window.setTimeout(scan, 500);
      return;
    }
    for (const el of Array.from(home.querySelectorAll(selectors))) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (reducedMotion.matches) reveal(el);
      else reveals.observe(el);
    }
    for (const video of Array.from(home.querySelectorAll('.lp-HeroCarousel-visual video'))) {
      if (mediaSeen.has(video)) continue;
      mediaSeen.add(video);
      videos.observe(video);
    }
  };
  const schedule = (): void => {
    if (!ready || scanTimer !== null) return;
    scanTimer = window.setTimeout(scan, 100);
  };
  // Give functioning native components a chance to initialize first.
  window.setTimeout(() => { ready = true; scan(); }, 2000);
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
}
