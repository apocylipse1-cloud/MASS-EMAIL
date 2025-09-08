// Inject in Gmail to render dashboard panel and hook compose window

function createShadowRoot(host) {
  const shadow = host.attachShadow({ mode: 'open' });
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = chrome.runtime.getURL('src/ui/dashboard.css');
  shadow.appendChild(link);
  return shadow;
}

function mountDashboard() {
  if (document.getElementById('mailblast-root-host')) return;
  const host = document.createElement('div');
  host.id = 'mailblast-root-host';
  host.style.position = 'fixed';
  host.style.top = '72px';
  host.style.right = '16px';
  host.style.width = '380px';
  host.style.height = '70vh';
  host.style.zIndex = '99999';
  host.style.pointerEvents = 'none';

  const shadow = createShadowRoot(host);
  const container = document.createElement('div');
  container.className = 'mb-card';
  container.style.pointerEvents = 'auto';

  const iframe = document.createElement('iframe');
  iframe.src = chrome.runtime.getURL('src/ui/dashboard.html');
  iframe.style.border = '0';
  iframe.style.width = '100%';
  iframe.style.height = '100%';
  iframe.style.borderRadius = '16px';
  iframe.allow = 'clipboard-write; clipboard-read';

  container.appendChild(iframe);
  shadow.appendChild(container);
  document.body.appendChild(host);
}

function waitForGmail() {
  const check = () => {
    const inbox = document.querySelector('div[role=main]');
    if (inbox) {
      mountDashboard();
      return true;
    }
    return false;
  };
  if (!check()) {
    const obs = new MutationObserver(() => {
      if (check()) obs.disconnect();
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }
}

waitForGmail();

