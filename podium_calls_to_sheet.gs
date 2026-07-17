/**
 * Podium → Google Sheet  (Everest call logger)
 * ------------------------------------------------------------------
 * Pulls Everest's calls from the Podium API once a day and appends one
 * row per call to a tab named "PodiumCalls". Chandler's weekly scorecard
 * job then reads that tab — so after this is installed there is NO manual
 * upload, ever.
 *
 * WHAT IT WRITES (one row per call):
 *   uid | direction | status | startedAt | durationSeconds |
 *   locationPhoneNumber | customerPhoneNumber | userUid
 *
 * Rows are de-duplicated by `uid`, so re-running never double-counts.
 *
 * ============================  SETUP (one time)  ==========================
 * 1. Open the call-log Google Sheet → Extensions → Apps Script.
 * 2. Paste this whole file in. Save.
 * 3. Run `setupCredentials()` ONCE after pasting your values below into it
 *    (client id/secret + refresh token from Podium OAuth), then DELETE the
 *    secrets out of setupCredentials so they only live in Script Properties.
 * 4. Run `backfill()` once to load history, then `installDailyTrigger()`
 *    to make it run automatically every morning.
 *
 * ==========================  TWO THINGS TO CONFIRM  =======================
 * Podium's per-endpoint docs are gated, so verify these against
 * https://docs.podium.com/reference (Authentication + the calls endpoint):
 *   (a) CALLS_PATH  — expected '/v4/calls'. If their reference shows a
 *       different path or required query params, update CALLS_PATH / params.
 *   (b) TOKEN_URL   — expected 'https://api.podium.com/oauth/token'.
 * Everything else is standard and will work once those two are right.
 * ========================================================================
 */

// ----------------------------- CONFIG -----------------------------------
var API_BASE   = 'https://api.podium.com';
var CALLS_PATH = '/v4/calls';                       // confirm (a)
var TOKEN_URL  = 'https://api.podium.com/oauth/token'; // confirm (b)
var SHEET_TAB  = 'PodiumCalls';
var PAGE_SIZE  = 250;
var MAX_PAGES  = 60;            // safety guard
var BACKFILL_DAYS = 400;        // how far back backfill() reaches
var DAILY_LOOKBACK_DAYS = 3;    // daily run re-checks last N days (dedup handles overlap)

// Optional: restrict to Everest's Podium location(s). Leave [] to capture all
// locations on the token, or fill with Everest's locationUid(s) once known.
var EVEREST_LOCATION_UIDS = [];  // e.g. ['00000000-0000-0000-0000-000000000000']

// --------------------------- ONE-TIME SETUP -----------------------------
function setupCredentials() {
  // Paste your Podium OAuth app values here, run once, then blank them out.
  var props = PropertiesService.getScriptProperties();
  props.setProperties({
    PODIUM_CLIENT_ID:     'PASTE_CLIENT_ID',
    PODIUM_CLIENT_SECRET: 'PASTE_CLIENT_SECRET',
    PODIUM_REFRESH_TOKEN: 'PASTE_REFRESH_TOKEN'
  });
  Logger.log('Credentials saved to Script Properties.');
}

function installDailyTrigger() {
  // remove existing dupes
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailyRun') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyRun').timeBased().everyDays(1).atHour(5).create();
  Logger.log('Daily trigger installed (~5am).');
}

// ------------------------------ ENTRY POINTS ----------------------------
function dailyRun() { run_(daysAgoIso_(DAILY_LOOKBACK_DAYS)); }
function backfill() { run_(daysAgoIso_(BACKFILL_DAYS)); }

// ------------------------------ CORE ------------------------------------
function run_(sinceIso) {
  var token = getAccessToken_();
  var sheet = getSheet_();
  var existing = existingUids_(sheet);
  var calls = fetchCalls_(token, sinceIso);

  var added = 0;
  var rows = [];
  calls.forEach(function (c) {
    if (!c || !c.uid || existing[c.uid]) return;
    if (EVEREST_LOCATION_UIDS.length &&
        EVEREST_LOCATION_UIDS.indexOf(c.locationUid) === -1) return;
    existing[c.uid] = true;
    rows.push([
      c.uid,
      c.direction || '',
      c.status || '',
      c.startedAt || '',
      (c.durationSeconds == null ? '' : c.durationSeconds),
      c.locationPhoneNumber || '',
      c.customerPhoneNumber || '',
      c.userUid || ''
    ]);
    added++;
  });

  if (rows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  }
  Logger.log('Fetched ' + calls.length + ' calls, appended ' + added + ' new rows.');
}

function getAccessToken_() {
  var p = PropertiesService.getScriptProperties();
  var resp = UrlFetchApp.fetch(TOKEN_URL, {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    muteHttpExceptions: true,
    payload: {
      grant_type: 'refresh_token',
      refresh_token: p.getProperty('PODIUM_REFRESH_TOKEN'),
      client_id: p.getProperty('PODIUM_CLIENT_ID'),
      client_secret: p.getProperty('PODIUM_CLIENT_SECRET')
    }
  });
  var body = JSON.parse(resp.getContentText() || '{}');
  if (resp.getResponseCode() >= 300 || !body.access_token) {
    throw new Error('Token refresh failed: ' + resp.getResponseCode() + ' ' + resp.getContentText());
  }
  // Podium may rotate the refresh token — persist it if returned.
  if (body.refresh_token) p.setProperty('PODIUM_REFRESH_TOKEN', body.refresh_token);
  return body.access_token;
}

function fetchCalls_(token, sinceIso) {
  var out = [];
  var cursor = null;
  for (var page = 0; page < MAX_PAGES; page++) {
    var url = API_BASE + CALLS_PATH + '?pageSize=' + PAGE_SIZE;
    if (cursor) url += '&cursor=' + encodeURIComponent(cursor);
    // Many Podium list endpoints accept a startedAt/since filter; harmless if ignored.
    if (sinceIso) url += '&startedAtFrom=' + encodeURIComponent(sinceIso);

    var resp = UrlFetchApp.fetch(url, {
      method: 'get',
      muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
    });
    if (resp.getResponseCode() >= 300) {
      throw new Error('Calls fetch failed: ' + resp.getResponseCode() + ' ' + resp.getContentText());
    }
    var json = JSON.parse(resp.getContentText() || '{}');

    // Be tolerant of response shape: data[] | calls[] | top-level array.
    var batch = Array.isArray(json) ? json : (json.data || json.calls || []);
    if (!batch.length) break;

    var stop = false;
    for (var i = 0; i < batch.length; i++) {
      var c = batch[i];
      if (sinceIso && c.startedAt && c.startedAt < sinceIso) { stop = true; continue; }
      out.push(c);
    }
    if (stop) break; // assumes newest-first ordering; dedup covers any overlap

    // Find next cursor across common shapes.
    cursor = (json.pagination && (json.pagination.nextCursor || json.pagination.cursor)) ||
             (json.metadata && json.metadata.nextCursor) ||
             (json.links && json.links.next) || null;
    if (!cursor) break;
  }
  return out;
}

// ------------------------------ HELPERS ---------------------------------
function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_TAB);
  if (!sh) {
    sh = ss.insertSheet(SHEET_TAB);
    sh.appendRow(['uid','direction','status','startedAt','durationSeconds',
                  'locationPhoneNumber','customerPhoneNumber','userUid']);
  }
  return sh;
}

function existingUids_(sheet) {
  var map = {};
  var last = sheet.getLastRow();
  if (last < 2) return map;
  var vals = sheet.getRange(2, 1, last - 1, 1).getValues();
  vals.forEach(function (r) { if (r[0]) map[r[0]] = true; });
  return map;
}

function daysAgoIso_(n) {
  var d = new Date(Date.now() - n * 86400000);
  return d.toISOString();
}
