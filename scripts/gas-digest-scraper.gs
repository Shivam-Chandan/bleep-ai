/**
 * Bleep AI — daily digest scraper (Google Apps Script)
 * ----------------------------------------------------
 * Scrapes Gmail + Google Calendar once a day and POSTs each source to your
 * app's /api/ingest endpoint, then triggers the summary. Runs free on Google's
 * infrastructure via a time-driven trigger.
 *
 * Slack & Zoom: no API tokens are used (org policy blocks app creation).
 * Instead, Slack notification emails (mentions/DMs) and Zoom AI Companion
 * summary emails that land in Gmail are parsed into "slack" and "zoom" sources.
 * Enable Slack email in Slack → Preferences → Notifications; Zoom AI summaries
 * are emailed automatically for meetings you host.
 *
 * SETUP
 * 1. Go to https://script.google.com → New project. Paste this whole file.
 * 2. Run `previewOutput` first — it logs the exact JSON from your Gmail,
 *    Calendar, and Slack-emails with NO token or network call (authorize the
 *    read scopes it asks for). Check the Execution log to see what will be sent.
 * 3. Project Settings → Script Properties, add:
 *      APP_BASE_URL   = https://your-app.vercel.app
 *      INGEST_TOKEN   = ingest_...   (create in the app: /account)
 * 4. Run `setupDailyTrigger` once (authorize the scopes it requests).
 * 5. Done. It fires daily; use `runNow` to send immediately.
 */

function props_() {
  return PropertiesService.getScriptProperties().getProperties();
}

function today_() {
  // Local calendar day in the script's timezone (Project Settings → Time zone).
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function post_(source, items) {
  var p = props_();
  if (!p.APP_BASE_URL || !p.INGEST_TOKEN) {
    throw new Error('Set APP_BASE_URL and INGEST_TOKEN in Script Properties.');
  }
  if (!items.length) {
    Logger.log('%s: nothing to send', source);
    return;
  }
  var res = UrlFetchApp.fetch(p.APP_BASE_URL + '/api/ingest', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + p.INGEST_TOKEN },
    payload: JSON.stringify({ source: source, items: items }),
    muteHttpExceptions: true,
  });
  Logger.log('%s -> %s %s', source, res.getResponseCode(), res.getContentText());
}

// ---- Collectors (return items; used by both post_ senders and previews) ----

// Strip noise that wastes tokens: URLs, tracking params, CR/LF, quoted-reply
// chains, and collapsed whitespace. Keeps the human-readable gist only.
function cleanText_(s) {
  if (!s) return '';
  return s
    .replace(/https?:\/\/\S+/g, '')      // drop URLs (Zoom/tracking links)
    .replace(/^>.*$/gm, '')              // drop quoted reply lines
    .replace(/\r/g, ' ')
    .replace(/\n+/g, ' ')
    .replace(/\s{2,}/g, ' ')             // collapse runs of whitespace
    .trim();
}

// "Jane Doe <jane@x.com>" -> "Jane Doe"; falls back to the address.
function senderName_(from) {
  if (!from) return '';
  var m = from.match(/^\s*"?([^"<]+?)"?\s*</);
  return (m ? m[1] : from).trim();
}

// True when an email is automated noise not worth summarizing: calendar
// invites/cancellations, OOO auto-replies, and known notification senders.
function isNoiseEmail_(from, subject) {
  var f = (from || '').toLowerCase();
  var s = (subject || '').toLowerCase();
  // Slack notification emails (mentions/DMs) ARE wanted — never treat as noise
  // even though they come from a no-reply address. Same for Zoom AI summaries.
  if (/@slack\.com|@zoom\.us/.test(f)) return false;
  // Automated / no-reply senders and notification systems.
  if (/no-?reply|notifications?@|automation@|mailer@|devops@|sesnotify|@docs\.google\.com|junojourney|widencollective|\.aha\.io/.test(f)) {
    return true;
  }
  // Calendar churn and out-of-office noise.
  if (/^(cancelled event:|invitation:|accepted:|declined:|updated invitation:|automatic reply:)/.test(s)) {
    return true;
  }
  if (/\b(ooo|out of office|pto|vacation)\b/.test(s)) return true;
  return false;
}

function collectGmail_() {
  var day = today_();
  // Ask Gmail to exclude the biggest categories up front (fewer threads to
  // process, fewer tokens). Personal/primary inbox, unread-focused.
  var query = 'newer_than:1d in:inbox -category:promotions -category:social -category:updates -category:forums';
  var threads = GmailApp.search(query, 0, 50);
  var items = [];
  threads.forEach(function (thread) {
    var messages = thread.getMessages();
    var last = messages[messages.length - 1];
    var from = last.getFrom();
    var subject = last.getSubject();
    // Slack notification emails and Zoom AI summaries are collected separately
    // as their own sources.
    if (/@slack\.com|@zoom\.us/i.test(from)) return;
    if (isNoiseEmail_(from, subject)) return; // skip automated noise
    items.push({
      externalId: last.getId(),
      day: day,
      payload: {
        from: senderName_(from),
        subject: cleanText_(subject).slice(0, 200),
        snippet: cleanText_(last.getPlainBody()).slice(0, 500),
        unread: thread.isUnread(),
      },
    });
  });
  return items;
}

// Slack notification emails (mentions/DMs) arrive in Gmail from @slack.com.
// Since org policy blocks a Slack API token, this is how Slack context enters
// the digest. We parse them into slack-shaped items so they group under a
// Slack section rather than mixing into email.
function collectSlackFromEmail_() {
  var day = today_();
  var threads = GmailApp.search('newer_than:1d from:slack.com', 0, 50);
  var items = [];
  threads.forEach(function (thread) {
    var last = thread.getMessages()[thread.getMessages().length - 1];
    var subject = last.getSubject() || '';
    // Slack subjects look like: "New message from Jane in #channel" or
    // "Jane Doe sent you a direct message". Keep the subject as the context
    // line and the body as the message text.
    items.push({
      externalId: last.getId(),
      day: day,
      payload: {
        channel: subject.slice(0, 120),
        user: '',
        text: cleanText_(last.getPlainBody()).slice(0, 500),
      },
    });
  });
  return items;
}

// Zoom AI Companion summary emails arrive in Gmail from @zoom.us after meetings
// you host. They already CONTAIN the summary text (unlike the "recording ready"
// link-only emails), so no Zoom API/token is needed. We parse them into
// zoom-shaped items { title, summary } for the digest's ZOOM section.
function collectZoomFromEmail_() {
  var day = today_();
  // AI summaries have subjects like "Meeting summary: <topic>" / "<topic> —
  // Meeting summary". Match Zoom senders and summary-ish subjects.
  var threads = GmailApp.search(
    'newer_than:1d from:zoom.us (subject:summary OR subject:"meeting summary" OR subject:recap)',
    0,
    50
  );
  var items = [];
  threads.forEach(function (thread) {
    var last = thread.getMessages()[thread.getMessages().length - 1];
    var subject = last.getSubject() || '';
    // Strip common "Meeting summary:" prefixes to get the meeting title.
    var title = subject
      .replace(/^(meeting summary:?\s*|summary:?\s*)/i, '')
      .replace(/\s*[-—]\s*meeting summary$/i, '')
      .slice(0, 160);
    items.push({
      externalId: last.getId(),
      day: day,
      payload: {
        title: title || 'Zoom meeting',
        // The AI summary body is already condensed; keep generous room since it
        // carries the most useful cross-day context.
        summary: cleanText_(last.getPlainBody()).slice(0, 1500),
      },
    });
  });
  return items;
}

function collectCalendar_() {
  var day = today_();
  // Scan just today's window; a real daily digest only needs today's meetings.
  var now = new Date();
  var start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  var end = new Date(start.getTime() + 24 * 60 * 60 * 1000); // today only

  var calendars = CalendarApp.getAllOwnedCalendars();
  var items = [];
  var seen = {};
  calendars.forEach(function (cal) {
    // Skip shared "vacation/OOO" calendars entirely — they're pure noise.
    if (/vacation|ooo|out of office|holiday|pto/i.test(cal.getName())) return;
    cal.getEvents(start, end).forEach(function (e) {
      var id = e.getId();
      if (seen[id]) return; // an event can appear on multiple calendars
      seen[id] = true;

      var title = e.getTitle() || '';
      // Drop OOO/PTO entries and multi-day all-day blocks (not real meetings).
      if (/\b(ooo|out of office|pto|vacation|holiday|wfh|working from)\b/i.test(title)) return;
      if (e.isAllDayEvent()) return;
      // Skip events you declined.
      if (e.getMyStatus && e.getMyStatus() === CalendarApp.GuestStatus.NO) return;

      items.push({
        externalId: id,
        day: day,
        payload: {
          title: title,
          start: e.getStartTime().toISOString(),
          end: e.getEndTime().toISOString(),
          location: (e.getLocation() || '').replace(/https?:\/\/\S+/g, '').trim(),
          guests: e.getGuestList().length,
        },
      });
    });
  });
  // Chronological order helps the summary's "Schedule" section.
  items.sort(function (a, b) {
    return a.payload.start < b.payload.start ? -1 : 1;
  });
  return items;
}

// ---- Gmail (last 24h of the inbox) ----
function scrapeGmail() {
  post_('gmail', collectGmail_());
}

// ---- Calendar (today's events) ----
function scrapeCalendar() {
  post_('calendar', collectCalendar_());
}

// ---- Slack (from notification emails in Gmail; no Slack API/token needed) ----
function scrapeSlack() {
  post_('slack', collectSlackFromEmail_());
}

// ---- Zoom (from AI summary emails in Gmail; no Zoom API/token needed) ----
function scrapeZoom() {
  post_('zoom', collectZoomFromEmail_());
}

// Fire-and-forget: after scraping, ask the app to generate today's summary for
// this user. Returns 202 immediately — we do NOT wait for the ~2 min LLM run.
function triggerSummarize_() {
  var p = props_();
  if (!p.APP_BASE_URL || !p.INGEST_TOKEN) return;
  var res = UrlFetchApp.fetch(p.APP_BASE_URL + '/api/digest/run', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + p.INGEST_TOKEN },
    payload: '{}',
    muteHttpExceptions: true,
  });
  Logger.log('summarize trigger -> %s %s', res.getResponseCode(), res.getContentText());
}

// ---- Orchestration ----
function runNow() {
  scrapeGmail();
  scrapeCalendar();
  scrapeSlack();
  scrapeZoom();
  triggerSummarize_(); // kick off the daily summary once all sources are in
}

// Dry run: logs the exact JSON that WOULD be sent, without any network call or
// token. Run this first in the editor to see what will be sent.
// (View → Logs, or the Execution log panel.)
function previewOutput() {
  var gmail = collectGmail_();
  var calendar = collectCalendar_();
  var slack = collectSlackFromEmail_();
  var zoom = collectZoomFromEmail_();
  Logger.log('=== GMAIL (%s items) ===', gmail.length);
  Logger.log(JSON.stringify({ source: 'gmail', items: gmail }, null, 2));
  Logger.log('=== CALENDAR (%s items) ===', calendar.length);
  Logger.log(JSON.stringify({ source: 'calendar', items: calendar }, null, 2));
  Logger.log('=== SLACK (%s items) ===', slack.length);
  Logger.log(JSON.stringify({ source: 'slack', items: slack }, null, 2));
  Logger.log('=== ZOOM (%s items) ===', zoom.length);
  Logger.log(JSON.stringify({ source: 'zoom', items: zoom }, null, 2));
}

function setupDailyTrigger() {
  // Remove existing triggers for runNow to avoid duplicates.
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runNow') ScriptApp.deleteTrigger(t);
  });
  // Fire every morning ~6am in the script's timezone.
  ScriptApp.newTrigger('runNow').timeBased().atHour(6).everyDays(1).create();
  Logger.log('Daily trigger installed for runNow at ~6am.');
}
