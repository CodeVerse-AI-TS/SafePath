'use strict';
/**
 * Trusted-circle notification for the panic button.
 *
 * Channels (configure with environment variables):
 *   SAFEPATH_ALERT_WEBHOOK   - POST JSON to a webhook (Slack/Discord/Zapier/n8n...)
 *   SAFEPATH_ALERT_SMS_URL   - POST to an SMS provider bridge (Twilio-compatible
 *                              form-encoded endpoint); plus SAFEPATH_ALERT_SMS_TO
 *   SAFEPATH_ALERT_EMAIL_URL - POST to an email provider bridge (e.g. a small
 *                              relay, SendGrid/Postmark proxy)
 *
 * If nothing is configured, the alert is recorded in the database and clearly
 * reported as a DEMO that was NOT sent anywhere. The UI states this explicitly.
 */

const USER_AGENT =
  process.env.SAFEPATH_UA || 'SafePath/1.0 (safe-route demo; https://github.com/example/safepath)';

function channelConfig() {
  return {
    webhook: process.env.SAFEPATH_ALERT_WEBHOOK || '',
    sms: process.env.SAFEPATH_ALERT_SMS_URL || '',
    smsTo: process.env.SAFEPATH_ALERT_SMS_TO || '',
    email: process.env.SAFEPATH_ALERT_EMAIL_URL || '',
    // Live-trip sharing reuses the same channels; the public base URL is needed
    // so the message contains a link the contact can actually open.
    publicBaseUrl: process.env.SAFEPATH_PUBLIC_URL || '',
  };
}

/** Which channels are live vs demo (used by the UI to be honest about it). */
function channelStatus() {
  const c = channelConfig();
  return {
    webhook: { configured: !!c.webhook, demo: !c.webhook },
    sms: { configured: !!(c.sms && c.smsTo), demo: !(c.sms && c.smsTo) },
    email: { configured: !!c.email, demo: !c.email },
  };
}

async function postJson(url, body, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify(body),
    });
    return { ok: res.ok, status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

async function postForm(url, params, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
      },
      body: new URLSearchParams(params).toString(),
    });
    return { ok: res.ok, status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Dispatch an alert to every configured channel. Never throws; returns a
 * human-readable summary that is stored with the alert row.
 */
async function dispatchAlert({ lat, lng, message, at }) {
  const c = channelConfig();
  const payload = {
    app: 'SafePath',
    event: 'panic_alert',
    lat: +lat.toFixed(5),
    lng: +lng.toFixed(5),
    maps_url: `https://www.openstreetmap.org/?mlat=${lat.toFixed(5)}&mlon=${lng.toFixed(5)}#map=17/${lat.toFixed(5)}/${lng.toFixed(5)}`,
    message: message || 'SafePath panic alert',
    at: at || new Date().toISOString(),
    note: 'Area-level location only. SafePath does not track users.',
  };

  const results = [];
  let anyLive = false;

  if (c.webhook) {
    try {
      const r = await postJson(c.webhook, payload);
      results.push(`webhook:${r.ok ? 'sent' : 'failed(' + r.status + ')'}`);
      anyLive = anyLive || r.ok;
    } catch (e) {
      results.push(`webhook:error(${e.message})`);
    }
  }
  if (c.sms && c.smsTo) {
    try {
      const r = await postForm(c.sms, {
        To: c.smsTo,
        Body: `${payload.message} at ${payload.maps_url}`,
      });
      results.push(`sms:${r.ok ? 'sent' : 'failed(' + r.status + ')'}`);
      anyLive = anyLive || r.ok;
    } catch (e) {
      results.push(`sms:error(${e.message})`);
    }
  }
  if (c.email) {
    try {
      const r = await postJson(c.email, {
        subject: 'SafePath panic alert',
        text: `${payload.message}\n${payload.maps_url}\n${payload.at}`,
      });
      results.push(`email:${r.ok ? 'sent' : 'failed(' + r.status + ')'}`);
      anyLive = anyLive || r.ok;
    } catch (e) {
      results.push(`email:error(${e.message})`);
    }
  }

  const delivery = anyLive
    ? `Delivered via ${results.join(', ')}`
    : results.length
      ? `Attempted but not delivered (${results.join(', ')})`
      : 'DEMO ONLY - no trusted-circle channel configured, alert stored in the app database only';

  return { delivery, live: anyLive, channels: results };
}

/**
 * Tell the trusted circle about a live-trip link. Reuses the panic channels so
 * there is one place to configure "how do I reach my people".
 *
 * Returns { url, delivery, live }. `live` is false when nothing is configured,
 * and the UI must then say the link is a demo that was not sent to anyone.
 */
async function dispatchShare({ token, lat, lng, toLabel, expiresAt, baseUrl }) {
  const c = channelConfig();
  const origin = (c.publicBaseUrl || baseUrl || '').replace(/\/$/, '');
  const url = origin ? `${origin}/?trip=${token}` : `/api/trips/share/${token}`;

  const payload = {
    app: 'SafePath',
    event: 'live_trip_share',
    trip_url: url,
    lat: +lat.toFixed(5),
    lng: +lng.toFixed(5),
    maps_url: `https://www.openstreetmap.org/?mlat=${lat.toFixed(5)}&mlon=${lng.toFixed(5)}#map=17/${lat.toFixed(5)}/${lng.toFixed(5)}`,
    destination: toLabel || null,
    expires_at: expiresAt,
    message: 'I am sharing my live SafePath trip with you.',
    note: 'Area-level location only (~110 m). SafePath does not keep a location trail.',
  };

  const results = [];
  let anyLive = false;

  if (c.webhook) {
    try {
      const r = await postJson(c.webhook, payload);
      results.push(`webhook:${r.ok ? 'sent' : 'failed(' + r.status + ')'}`);
      anyLive = anyLive || r.ok;
    } catch (e) {
      results.push(`webhook:error(${e.message})`);
    }
  }
  if (c.sms && c.smsTo) {
    try {
      const r = await postForm(c.sms, {
        To: c.smsTo,
        Body: `${payload.message} ${url}`,
      });
      results.push(`sms:${r.ok ? 'sent' : 'failed(' + r.status + ')'}`);
      anyLive = anyLive || r.ok;
    } catch (e) {
      results.push(`sms:error(${e.message})`);
    }
  }
  if (c.email) {
    try {
      const r = await postJson(c.email, {
        subject: 'SafePath live trip',
        text: `${payload.message}\n${url}\nExpires ${expiresAt}`,
      });
      results.push(`email:${r.ok ? 'sent' : 'failed(' + r.status + ')'}`);
      anyLive = anyLive || r.ok;
    } catch (e) {
      results.push(`email:error(${e.message})`);
    }
  }

  const delivery = anyLive
    ? `Shared via ${results.join(', ')}`
    : results.length
      ? `Attempted but not delivered (${results.join(', ')})`
      : 'DEMO ONLY - no trusted-circle channel is configured, so this link was created but not sent to anyone';

  return { url, delivery, live: anyLive, channels: results };
}


module.exports = { dispatchAlert, dispatchShare, channelStatus, channelConfig };
