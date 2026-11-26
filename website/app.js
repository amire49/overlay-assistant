// Resolves the latest Windows installer (.exe) from GitHub Releases so the download button
// always points to the newest published version, with a clean fallback to /releases/latest.
const REPO = "amire49/overlay-assistant";
const FALLBACK_URL = `https://github.com/${REPO}/releases/latest`;

async function resolveLatestRelease() {
  const btn = document.getElementById("download-btn");
  const label = document.getElementById("download-label");
  const meta = document.getElementById("download-meta");
  const badge = document.getElementById("version-badge");
  if (!btn) return;

  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return;
    const release = await res.json();
    const exe = (release.assets || []).find((a) => a.name.endsWith(".exe"));
    if (release.tag_name && badge) badge.textContent = release.tag_name;
    if (exe?.browser_download_url) {
      btn.href = exe.browser_download_url;
      const mb = Math.round(exe.size / (1024 * 1024));
      label.textContent = `Download for Windows (${release.tag_name})`;
      meta.textContent = `${exe.name} · ${mb} MB · Windows 10/11 (64-bit)`;
    } else if (release.html_url) {
      btn.href = release.html_url;
    }
  } catch {
    btn.href = FALLBACK_URL;
  }
}

const SUN_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;
const MOON_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;

// Theme toggle (persists in localStorage, defaults to system preference)
function initTheme() {
  const toggle = document.getElementById("theme-toggle");
  const apply = (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    if (toggle) {
      toggle.innerHTML = theme === "light" ? `${MOON_ICON}<span>Dark</span>` : `${SUN_ICON}<span>Light</span>`;
    }
  };

  const saved = localStorage.getItem("theme");
  const initial = saved || (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  apply(initial);

  toggle?.addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    localStorage.setItem("theme", next);
    apply(next);
  });
}

initTheme();
resolveLatestRelease();

