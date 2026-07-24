/**
 * Abstrakt → GoHighLevel capture trigger (Google Apps Script)
 * ----------------------------------------------------------------------
 * Runs on a time trigger in the WORK INBOX that receives Abstrakt emails.
 * Finds new Abstrakt notification emails, POSTs each to the Supabase
 * `abstrakt-intake` edge function, and labels them so they never re-send.
 *
 * SETUP (once):
 *   1. Sign in to the work inbox → https://script.google.com → New project.
 *   2. Paste this file in. Edit the CONFIG block below.
 *   3. Run `setup()` once (authorize when prompted). It creates the label
 *      and installs a 1-minute trigger.
 *   4. Run `testOne()` to push your most recent Abstrakt email through.
 *
 * To change anything later, edit CONFIG and re-run `setup()`.
 */

// ===== CONFIG =========================================================
var CONFIG = {
  FUNCTION_URL: 'https://andzztvmaleiefxcfjwh.supabase.co/functions/v1/abstrakt-intake',
  // Must match the ABSTRAKT_WEBHOOK_SECRET secret set in Supabase.
  WEBHOOK_SECRET: 'PASTE_THE_SAME_SECRET_HERE',
  // Gmail search that isolates Abstrakt's emails. Tighten to their exact
  // sender once known, e.g. 'from:notifications@abstraktmarketing.com'.
  SEARCH_QUERY: 'from:abstraktmarketing.com',
  PROCESSED_LABEL: 'Abstrakt/Processed',
  MAX_PER_RUN: 10,
};
// ======================================================================

function setup() {
  getOrCreateLabel_(CONFIG.PROCESSED_LABEL);
  // Remove any existing triggers for this handler, then install a fresh one.
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'processAbstraktEmails') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('processAbstraktEmails').timeBased().everyMinutes(1).create();
  Logger.log('Setup complete. Label + 1-minute trigger installed.');
}

function processAbstraktEmails() {
  var label = getOrCreateLabel_(CONFIG.PROCESSED_LABEL);
  var query = CONFIG.SEARCH_QUERY + ' -label:"' + CONFIG.PROCESSED_LABEL + '"';
  var threads = GmailApp.search(query, 0, CONFIG.MAX_PER_RUN);

  threads.forEach(function (thread) {
    var msgs = thread.getMessages();
    // Newest message in the thread is the fresh notification.
    var msg = msgs[msgs.length - 1];
    try {
      pushMessage_(msg);
      thread.addLabel(label);
    } catch (err) {
      Logger.log('Abstrakt push failed for "' + msg.getSubject() + '": ' + err);
      // Leave unlabeled so the next run retries.
    }
  });
}

function pushMessage_(msg) {
  var payload = {
    messageId: msg.getId(),
    from: msg.getFrom(),
    subject: msg.getSubject(),
    receivedAt: msg.getDate().toISOString(),
    text: msg.getPlainBody(),
    html: msg.getBody(),
  };
  var res = UrlFetchApp.fetch(CONFIG.FUNCTION_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-abstrakt-secret': CONFIG.WEBHOOK_SECRET },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('HTTP ' + code + ': ' + res.getContentText());
  }
  Logger.log('Pushed "' + msg.getSubject() + '" → ' + res.getContentText());
}

/** Push the single most recent matching email (for testing). */
function testOne() {
  var threads = GmailApp.search(CONFIG.SEARCH_QUERY, 0, 1);
  if (!threads.length) { Logger.log('No emails match SEARCH_QUERY.'); return; }
  var msgs = threads[0].getMessages();
  pushMessage_(msgs[msgs.length - 1]);
}

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}
