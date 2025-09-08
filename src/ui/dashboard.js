const q = (s) => document.querySelector(s);

async function sendMsg(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}

function renderList(el, items, mapper) {
  el.innerHTML = '';
  items.forEach((it) => el.appendChild(mapper(it)));
}

function item(contentLeft, contentRight) {
  const row = document.createElement('div');
  row.className = 'mb-item';
  const left = document.createElement('div');
  left.textContent = contentLeft;
  const right = document.createElement('div');
  right.className = 'mb-stat';
  right.innerHTML = contentRight;
  row.append(left, right);
  return row;
}

async function refresh() {
  const campaigns = (await sendMsg({ type: 'storage.get', key: 'campaigns' })).value || {};
  const sequences = (await sendMsg({ type: 'storage.get', key: 'sequences' })).value || {};
  const analytics = (await sendMsg({ type: 'storage.get', key: 'analytics' })).value || {};

  const campList = q('#campaignsList');
  const seqList = q('#sequencesList');
  const anaList = q('#analytics');

  const campArr = Object.values(campaigns);
  renderList(campList, campArr, (c) => item(c.name || c.id, `Sent ${ (c.recipients||[]).filter(r=>r.sentAt).length } / ${(c.recipients||[]).length}`));
  const seqArr = Object.values(sequences);
  renderList(seqList, seqArr, (s) => item(s.name || s.id, `${s.steps?.length||0} steps`));
  const openRate = analytics.opens && analytics.sent ? Math.round((analytics.opens/analytics.sent)*100) : 0;
  renderList(anaList, [
    { k: 'Sent', v: analytics.sent || 0 },
    { k: 'Opens', v: analytics.opens || 0 },
    { k: 'Clicks', v: analytics.clicks || 0 },
    { k: 'Replies', v: analytics.replies || 0 },
    { k: 'Bounces', v: analytics.bounces || 0 },
    { k: 'Open Rate', v: openRate + '%' }
  ], (a) => item(a.k, a.v));
}

async function signIn() {
  const res = await sendMsg({ type: 'auth.signIn' });
  if (!res?.ok) {
    alert('Sign-in failed: ' + (res?.error || 'unknown'));
  } else {
    await refresh();
  }
}

function openCampaignModal() {
  const name = prompt('Campaign name');
  if (!name) return;
  const subject = prompt('Subject (use {{FirstName}} etc.)');
  const html = prompt('HTML body');
  const to = prompt('Recipients (comma separated emails)');
  const recipients = (to || '').split(',').map((x) => ({ email: x.trim(), merge: {} })).filter((x) => x.email);
  const campaign = {
    id: 'cmp-' + Date.now(),
    name,
    from: '',
    subject,
    html,
    text: '',
    cc: '',
    bcc: '',
    attachments: [],
    recipients,
    status: 'scheduled',
    batchSize: 80,
    intervalMinutes: 30,
    nextRunAt: Date.now() + 5_000
  };
  sendMsg({ type: 'campaign.schedule', campaign }).then(() => refresh());
}

window.addEventListener('DOMContentLoaded', () => {
  q('#signInBtn').addEventListener('click', signIn);
  q('#newCampaignBtn').addEventListener('click', openCampaignModal);
  refresh();
});

