// Service Worker (MV3) - orchestrates auth, scheduling, background sends, analytics
// Note: Avoid long-running tasks; use alarms and chunked work

const OAUTH_CLIENT_ID = chrome.runtime.getManifest().oauth2?.client_id || '';
const OAUTH_SCOPES = chrome.runtime.getManifest().oauth2?.scopes || [];

const STORAGE_KEYS = {
  auth: 'auth',
  campaigns: 'campaigns',
  sequences: 'sequences',
  lists: 'lists',
  analytics: 'analytics',
  settings: 'settings',
  sheets: 'sheets'
};

async function withStorage(getter) {
  return new Promise((resolve) => {
    chrome.storage.local.get(null, (all) => resolve(getter(all)));
  });
}

async function setStorage(patch) {
  return new Promise((resolve) => {
    chrome.storage.local.set(patch, () => resolve());
  });
}

async function ensureAuthToken(interactive = false) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }
      resolve(token);
    });
  });
}

async function revokeAuthToken(token) {
  return new Promise((resolve) => {
    if (!token) return resolve();
    chrome.identity.removeCachedAuthToken({ token }, () => resolve());
  });
}

async function gmailSendRaw(token, raw) {
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ raw })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gmail send failed: ${res.status} ${text}`);
  }
  return res.json();
}

function toBase64Url(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function buildMimeMessage({ from, to, cc, bcc, subject, html, text, attachments }) {
  const boundary = 'mailblast-' + Math.random().toString(36).slice(2);
  const headers = [];
  headers.push(`From: ${from}`);
  headers.push(`To: ${to}`);
  if (cc) headers.push(`Cc: ${cc}`);
  if (bcc) headers.push(`Bcc: ${bcc}`);
  headers.push(`Subject: ${subject}`);
  headers.push('MIME-Version: 1.0');

  if (attachments && attachments.length > 0) {
    headers.push(`Content-Type: multipart/mixed; boundary=${boundary}`);
    const lines = [];
    lines.push(headers.join('\r\n'));
    // Alternative part (text + html)
    const altBoundary = boundary + '-alt';
    lines.push(`\r\n--${boundary}`);
    lines.push(`Content-Type: multipart/alternative; boundary=${altBoundary}`);
    // text
    if (text) {
      lines.push(`\r\n--${altBoundary}`);
      lines.push('Content-Type: text/plain; charset=UTF-8');
      lines.push('Content-Transfer-Encoding: 7bit');
      lines.push('\r\n' + text);
    }
    // html
    lines.push(`\r\n--${altBoundary}`);
    lines.push('Content-Type: text/html; charset=UTF-8');
    lines.push('Content-Transfer-Encoding: 7bit');
    lines.push('\r\n' + (html || ''));
    lines.push(`\r\n--${altBoundary}--`);

    // attachments
    for (const att of attachments) {
      const { filename, contentType, base64Content } = att; // base64Content should be standard base64
      lines.push(`\r\n--${boundary}`);
      lines.push(`Content-Type: ${contentType}; name="${filename}"`);
      lines.push('Content-Transfer-Encoding: base64');
      lines.push(`Content-Disposition: attachment; filename="${filename}"`);
      lines.push('\r\n' + base64Content.replace(/(.{76})/g, '$1\r\n'));
    }

    lines.push(`\r\n--${boundary}--`);
    return toBase64Url(lines.join('\r\n'));
  }

  // No attachments: multipart/alternative or plain html/text
  const hasText = Boolean(text);
  const hasHtml = Boolean(html);
  if (hasText && hasHtml) {
    const altBoundary = boundary + '-alt';
    headers.push(`Content-Type: multipart/alternative; boundary=${altBoundary}`);
    const lines = [];
    lines.push(headers.join('\r\n'));
    // text
    lines.push(`\r\n--${altBoundary}`);
    lines.push('Content-Type: text/plain; charset=UTF-8');
    lines.push('Content-Transfer-Encoding: 7bit');
    lines.push('\r\n' + text);
    // html
    lines.push(`\r\n--${altBoundary}`);
    lines.push('Content-Type: text/html; charset=UTF-8');
    lines.push('Content-Transfer-Encoding: 7bit');
    lines.push('\r\n' + html);
    lines.push(`\r\n--${altBoundary}--`);
    return toBase64Url(lines.join('\r\n'));
  }

  const bodyIsHtml = hasHtml || !hasText;
  const lines = [];
  lines.push(headers.join('\r\n'));
  lines.push(`\r\nContent-Type: ${bodyIsHtml ? 'text/html' : 'text/plain'}; charset=UTF-8`);
  lines.push('Content-Transfer-Encoding: 7bit');
  lines.push('\r\n' + (bodyIsHtml ? (html || '') : text));
  return toBase64Url(lines.join('\r\n'));
}

async function apiFetch(token, url, init) {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      Authorization: `Bearer ${token}`
    }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${url} failed: ${res.status} ${text}`);
  }
  return res.json();
}

// --------------- Google Sheets Integration ---------------
async function sheetsGetValues(token, spreadsheetId, rangeA1) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(rangeA1)}`;
  const data = await apiFetch(token, url);
  return data.values || [];
}

function normalizeHeaderRow(row) {
  return row.map((h) => String(h || '').trim());
}

function rowsToObjects(headerRow, rows) {
  const headers = normalizeHeaderRow(headerRow);
  return rows.map((r) => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = r[i] ?? ''; });
    return obj;
  });
}

async function pollNewSheetRows(sheetCfg) {
  // sheetCfg: { id, range, header: true, lastRow: number, emailColumn, autoCampaignId }
  let token;
  try { token = await ensureAuthToken(false); } catch { return null; }
  const values = await sheetsGetValues(token, sheetCfg.id, sheetCfg.range || 'Sheet1!A:Z');
  if (!values.length) return { headerRow: null, newRows: [], totalRows: 0 };
  const headerRow = sheetCfg.header !== false ? values[0] : null;
  const dataRows = sheetCfg.header !== false ? values.slice(1) : values;
  const startIndex = Math.max(0, (sheetCfg.lastRow || 0) - (sheetCfg.header !== false ? 0 : 0));
  const newRows = dataRows.slice(startIndex);
  const asObjects = headerRow ? rowsToObjects(headerRow, newRows) : newRows.map((r) => ({ row: r }));
  return { headerRow, newRows: asObjects, totalRows: dataRows.length };
}

async function listNewRepliesSince(token, query, afterInternalDateMs) {
  const q = `${query || ''} newer_than:1d`;
  const params = new URLSearchParams({ q });
  const data = await apiFetch(token, `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`);
  return data.messages || [];
}

async function checkReplyStops() {
  let token;
  try {
    token = await ensureAuthToken(false);
  } catch (e) {
    return; // not signed-in
  }
  const sequences = await withStorage((s) => s[STORAGE_KEYS.sequences] || {});
  // Placeholder: iterate sequences, mark stopped if reply detected (future work)
}

async function runDueSends() {
  const campaigns = await withStorage((s) => s[STORAGE_KEYS.campaigns] || {});
  const now = Date.now();
  const due = Object.values(campaigns).filter((c) => c.status === 'scheduled' && c.nextRunAt && c.nextRunAt <= now);
  if (due.length === 0) return;

  let token;
  try {
    token = await ensureAuthToken(false);
  } catch (e) {
    return; // no token available
  }

  for (const campaign of due) {
    const batchSize = Math.max(1, Math.min(campaign.batchSize || 80, 90));
    const pending = (campaign.recipients || []).filter((r) => !r.sentAt && !r.error);
    const toSendNow = pending.slice(0, batchSize);
    // settings for tracking
    const settings = await withStorage((s) => ({ trackingUrl: s.trackingUrl, redirectDomain: s.redirectDomain }));
    for (const recipient of toSendNow) {
      try {
        const raw = buildMimeMessage({
          from: campaign.from,
          to: recipient.email,
          cc: campaign.cc,
          bcc: campaign.bcc,
          subject: interpolate(campaign.subject, recipient.merge || {}),
          html: injectTracking(
            interpolate(campaign.html, recipient.merge || {}),
            settings.trackingUrl,
            campaign.id,
            recipient.email,
            settings.redirectDomain
          ),
          text: interpolate(campaign.text, recipient.merge || {}),
          attachments: campaign.attachments || []
        });
        const resp = await gmailSendRaw(token, raw);
        recipient.sentAt = Date.now();
        recipient.messageId = resp.id;
      } catch (err) {
        recipient.error = String(err?.message || err);
      }
    }

    // Update schedule
    const remaining = (campaign.recipients || []).filter((r) => !r.sentAt && !r.error);
    if (remaining.length === 0) {
      campaign.status = 'completed';
      campaign.nextRunAt = null;
    } else {
      // schedule next batch in 30 minutes by default to respect limits
      const intervalMs = (campaign.intervalMinutes || 30) * 60 * 1000;
      campaign.nextRunAt = Date.now() + intervalMs;
    }
  }

  // persist
  await setStorage({ [STORAGE_KEYS.campaigns]: campaigns });
}

function interpolate(template, vars) {
  if (!template) return '';
  return template.replace(/\{\{\s*([\w.]+)(?:\s*\|\s*([^}]+))?\s*\}\}/g, (m, key, fallback) => {
    const value = key.split('.').reduce((acc, k) => (acc ? acc[k] : undefined), vars);
    return (value == null || value === '') ? (fallback != null ? fallback : '') : String(value);
  });
}

// --------------- Tracking Injection ---------------
function injectTracking(html, trackingUrl, campaignId, recipientId, redirectDomain) {
  if (!html) return '';
  let out = String(html);
  // Rewrite links through tracking
  if (trackingUrl) {
    out = out.replace(/href=\"(https?:[^\"]+)\"/g, (m, href) => {
      try {
        const url = new URL(trackingUrl);
        url.searchParams.set('t', 'click');
        url.searchParams.set('c', campaignId);
        url.searchParams.set('r', recipientId);
        url.searchParams.set('u', href);
        return `href="${url.toString()}"`;
      } catch {
        return m;
      }
    });
  }
  // Tracking pixel for opens
  if (trackingUrl) {
    try {
      const u = new URL(trackingUrl);
      u.searchParams.set('t', 'open');
      u.searchParams.set('c', campaignId);
      u.searchParams.set('r', recipientId);
      const pixel = `<img src="${u.toString()}" alt="" style="display:none;width:1px;height:1px" />`;
      out = out.replace(/<body[^>]*>/i, (tag) => `${tag}${pixel}`);
    } catch {}
  }
  return out;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('scheduleRunner', { periodInMinutes: 5 });
  chrome.alarms.create('replyChecker', { periodInMinutes: 15 });
  chrome.alarms.create('sheetsPoller', { periodInMinutes: 5 });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'scheduleRunner') {
    runDueSends();
  } else if (alarm.name === 'replyChecker') {
    checkReplyStops();
  } else if (alarm.name === 'sheetsPoller') {
    const sheets = await withStorage((s) => s[STORAGE_KEYS.sheets] || {});
    const updates = {};
    for (const [key, cfg] of Object.entries(sheets)) {
      try {
        const res = await pollNewSheetRows(cfg);
        if (!res || !res.newRows || res.newRows.length === 0) continue;
        updates[key] = { ...cfg, lastRow: res.totalRows };
        if (cfg.autoCampaignId) {
          const campaigns = await withStorage((s) => s[STORAGE_KEYS.campaigns] || {});
          const camp = campaigns[cfg.autoCampaignId];
          if (camp) {
            const newRecipients = res.newRows.map((row) => ({
              email: row.Email || row.email || row['E-mail'] || row[cfg.emailColumn || 'Email'] || '',
              merge: row
            })).filter((r) => r.email);
            camp.recipients = [...(camp.recipients || []), ...newRecipients];
            if (camp.status !== 'scheduled') camp.status = 'scheduled';
            if (!camp.nextRunAt) camp.nextRunAt = Date.now() + 10_000;
            await setStorage({ [STORAGE_KEYS.campaigns]: campaigns });
          }
        }
      } catch (e) {
        // ignore
      }
    }
    if (Object.keys(updates).length) {
      const sheetsAll = await withStorage((s) => s[STORAGE_KEYS.sheets] || {});
      await setStorage({ [STORAGE_KEYS.sheets]: { ...sheetsAll, ...updates } });
    }
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'auth.signIn') {
        const token = await ensureAuthToken(true);
        sendResponse({ ok: true, token });
        return;
      }
      if (msg.type === 'auth.signOut') {
        const token = await ensureAuthToken(false).catch(() => undefined);
        await revokeAuthToken(token);
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === 'gmail.send') {
        const token = await ensureAuthToken(true);
        const raw = buildMimeMessage(msg.payload);
        const res = await gmailSendRaw(token, raw);
        sendResponse({ ok: true, res });
        return;
      }
      if (msg.type === 'storage.get') {
        const value = await withStorage((s) => s[msg.key]);
        sendResponse({ ok: true, value });
        return;
      }
      if (msg.type === 'storage.set') {
        await setStorage({ [msg.key]: msg.value });
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === 'campaign.schedule') {
        const campaigns = await withStorage((s) => s[STORAGE_KEYS.campaigns] || {});
        const id = msg.campaign.id;
        campaigns[id] = msg.campaign;
        await setStorage({ [STORAGE_KEYS.campaigns]: campaigns });
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === 'sheets.connect') {
        const sheets = await withStorage((s) => s[STORAGE_KEYS.sheets] || {});
        const payload = msg.payload || {};
        sheets[payload.key] = { id: payload.spreadsheetId, range: payload.range || 'Sheet1!A:Z', header: payload.header !== false, emailColumn: payload.emailColumn || 'Email', autoCampaignId: payload.autoCampaignId || null, lastRow: 0 };
        await setStorage({ [STORAGE_KEYS.sheets]: sheets });
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === 'sheets.fetchRows') {
        const token = await ensureAuthToken(true);
        const values = await sheetsGetValues(token, msg.payload.spreadsheetId, msg.payload.range || 'Sheet1!A:Z');
        sendResponse({ ok: true, values });
        return;
      }
      sendResponse({ ok: false, error: 'unknown_message' });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true;
});

