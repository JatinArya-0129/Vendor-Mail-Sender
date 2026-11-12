/**
 * OpsCore Vendor Mail Sender - Innovatiview India Ltd.
 * Process Excellence Team
 * Front-end only (Netlify). Google Sign-In + Gmail API + Google Sheets API.
 */

// =====================================================================
// CONFIGURATION
// =====================================================================
const GOOGLE_CLIENT_ID = "19499615360-cf6c3tv3040ivqngiri0iih5tve671ev.apps.googleusercontent.com";
const MASTER_SPREADSHEET_ID = "11Y7Qm3JxLA4a6bYLh1Llt3U2Iy3xJBEBGjV0VLTl5nw"; // audit Google Sheet (Login Audit, Dispatch Audit, Vendor Memory)
const BCC_AUDIT_EMAIL = "";
const GMAIL_DAILY_LIMIT = 2000;                         // 2000 = Workspace, 500 = normal Gmail
const POLICE_PORTAL_URL = "https://script.google.com/a/macros/innovatiview.com/s/AKfycby9lSJnDWEUJirMqY3mrewaq9oUYqwaeJdIqcGcV-DBxwSwUn8LcftUgysKLRLXMPDMA/exec";
const BIOMETRIC_MIN_AGE = 21;
const FRISKING_MIN_AGE = 22;
const SESSION_MAX_AGE_MS = 55 * 60 * 1000;              // Google access token lives 1 hour

const SCOPES = "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/userinfo.email";

// ---- Google Sheet sources (Step 1) ----
const DEFAULT_CENTER_SHEET_URL = "";   // optional: Vendor Guard OP sheet link (khali chhodo to user khud paste karega)
const DEFAULT_SEQR_SHEET_URL = "";     // optional: seQRview data sheet link
const LINKS_KEY = 'opscore_links_v1';

const CENTER_TABS = { Biometric: "BIO Center List", Frisking: "Frisking Center List" };
const SEQR_TABS   = { Biometric: "Biometric",       Frisking: "Frisking" };

// Har item = sheet ka header. "A|B" ka matlab: A ya B (koi bhi naam chalega).
// Order sheet ke order jaisa rakho. Duplicate headers (OP Count S1 etc.) order se pick hote hain.
const FIXED_HEADERS = {
    Biometric: [
    'Center Code', 'Client Code', 'State|State Name', 'City Name|City', 'Center Name', 'Center Address',
    'Vendor Name|Vendor Name-Contact Numbe|Vendor Name-Contact Number', 'ZM Name', 'VC Name', 'Vendor Code|VC Code', 'Tab',
    'FPS', 'OTG', 'Hologram', 'Id Card', 'Jacket', 'IRIS', 'Verification Stamp', 'Stand', 'queue manager',
    'Max All Day', '@DAYS'
  ],
    Frisking: [
    'Center Code', 'Client Code', 'State Name|State', 'City Name|City', 'Center Name', 'Center Address',
    'ZM Name', 'VC Name', 'VC Code',
    'Vendor Name|Vendor Name-Contact Numbe|Vendor Name-Contact Number',
    'Max Male', 'Max Female', 'Max All Day', '@DAYS'
  ]
};

const SESSION_KEY = 'opscore_session_v2';
const SNAP_KEY = 'opscore_snapshot_v2';

const ZM_DETAILS = {
  "Girish":   { name: "Girish Chandra Tiwari", email: "girish.tiwari@innovatiview.com",  phone: "8448786844" },
  "Devendra": { name: "Devendra Bose",         email: "devendra.bose@innovatiview.com",  phone: "9289035157" },
  "Chetan":   { name: "Chetan Pandey",         email: "chetan.pandey@innovatiview.com",  phone: "9910621078" },
  "Monu":     { name: "Monu Kumar",            email: "monu.kumar@innovatiview.com",     phone: "9582091469" },
  "Amarjeet": { name: "An Amarjeet",           email: "amarjeet@innovatiview.com",       phone: "8750858591" }
};

const LOG_HEADERS = {
  "Login Audit": ["Timestamp", "Login Mail ID", "Status"],
  "Dispatch Audit": [
    "Timestamp", "Sender Mail ID", "Vendor Name", "Vendor Mail ID", "ZM Assigned", "Rate (Shift)", "CC", "Subject", "Status", "Details",
    "Service", "Exam Name", "Exam Date", "Project Code", "Training", "Enclosure", "Mock", "Reporting Time",
    "Attachment Format", "Center Rows", "seQRview Rows", "seQRview Attached",
    "Operator List Date", "Final Operator Date", "CSR Submit Date"
  ],
  "Vendor Memory": ["Vendor Name", "Email", "Shift", "Training", "Enclosure", "Mock", "Reporting Time", "CC", "ZM", "Updated At"]
};

// =====================================================================
// GLOBAL STATE & HELPERS
// =====================================================================
let tokenClient = null;
let userToken = null;
let currentUserEmail = "";
let currentTourStep = 1;
let tokenWaiter = null;

const state = {
  center: null,
  seqr: null,
  vendors: [],
  running: false,
  cancel: false,
  subjectTimer: null,
  report: [],
  step: 1,
  memoryRows: {}   // vendor key -> sheet row number in "Vendor Memory"
};

const $ = id => document.getElementById(id);
const norm = s => String(s == null ? '' : s).trim().replace(/\s+/g, ' ').toLowerCase();
const esc_ = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const escHtml = esc_;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

function splitEmails(text) {
  return String(text || '').split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
}

function setStatus(el, type, html) {
  if (!el) return;
  const color = { ok: 'text-emerald-600', err: 'text-rose-600', info: 'text-indigo-600', warn: 'text-amber-600' }[type] || 'text-slate-500';
  el.innerHTML = `<span class="${color}">${html}</span>`;
}

function nowIST_() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' });
}

function formatInputDate_(value) {
  if (!value) return "";
  var s = String(value).trim();
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return s;
  var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var monthName = months[parseInt(m[2], 10) - 1];
  if (!monthName) return s;
  return m[3] + " " + monthName + " " + m[1];
}

function safeFileName_(name) {
  var s = String(name || "Vendor")
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\uFEFF]+/g, " ")
    .replace(/[\\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
  if (s.length > 80) s = s.substring(0, 80).replace(/[. ]+$/, "");
  return s || "Vendor";
}

function utf8ToB64_(str) {
  return bytesToB64_(new TextEncoder().encode(str));
}

function bytesToB64_(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function wrap76_(b64) {
  return (b64.match(/.{1,76}/g) || []).join('\r\n');
}

function encodeHeader_(s) {
  return /^[\x20-\x7E]*$/.test(s) ? s : '=?UTF-8?B?' + utf8ToB64_(s) + '?=';
}

function tableToCsv_(rows) {
  return rows.map(r => r.map(c => '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"').join(',')).join('\r\n');
}

function padRows_(rows) {
  let width = 0;
  rows.forEach(r => { if (r.length > width) width = r.length; });
  return rows.map(r => {
    const copy = r.slice();
    while (copy.length < width) copy.push('');
    return copy;
  });
}

function generateSubject(d) {
  const service = d.service || "Biometric";
  const exam = d.exam_name || "EXAM";
  const code = d.project_code ? "[" + d.project_code + "] " : "";
  const date = d.exam_date ? "(" + d.exam_date + ")" : "";
  return code + "Deployment and Duty Guidelines for " + exam + " " + date + " - " + service;
}

// =====================================================================
// SESSION & SNAPSHOT PERSISTENCE
// =====================================================================
function storeGet(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
function storeSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
function storeDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

let saveTimer = null;
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveSnapshot, 400); }
document.addEventListener('input', scheduleSave);
document.addEventListener('change', scheduleSave);

function saveSnapshot() {
  if (!userToken || !state.center) return;
  const ok = storeSet(SNAP_KEY, {
    email: currentUserEmail,
    step: state.step,
    center: state.center,
    seqr: state.seqr,
    vendors: state.vendors,
    report: state.report,
    memoryRows: state.memoryRows,
    form: {
      zm: $('zmSelect').value, service: $('serviceSelect').value, modality: $('modalitySelect').value,
      projectCode: $('projectCode').value, examName: $('examName').value, examDate: $('examDate').value,
      operatorListDate: $('operatorListDate').value, finalOperatorDate: $('finalOperatorDate').value,
      csrSubmitDate: $('csrSubmitDate').value, reportingTime: $('reportingTime').value,
      customBodyCheck: $('customBodyCheck').checked, customNotes: $('customNotes').value,
      attachFormat: $('attachFormat').value, delay: $('delaySelect').value
    }
  });
  if (!ok) storeDel(SNAP_KEY); // storage full: never keep a partial snapshot
}

function restoreSnapshot() {
  const snap = storeGet(SNAP_KEY);
  if (!snap || !snap.center || snap.email !== currentUserEmail) return;
  const f = snap.form || {};
  const setVal = (id, v) => { if (v !== undefined && v !== null) $(id).value = v; };

  setVal('serviceSelect', f.service);
  onServiceChange();
  setVal('zmSelect', f.zm); setVal('modalitySelect', f.modality);
  setVal('projectCode', f.projectCode); setVal('examName', f.examName); setVal('examDate', f.examDate);
  setVal('operatorListDate', f.operatorListDate); setVal('finalOperatorDate', f.finalOperatorDate);
  setVal('csrSubmitDate', f.csrSubmitDate); setVal('reportingTime', f.reportingTime);
  setVal('customNotes', f.customNotes); setVal('attachFormat', f.attachFormat); setVal('delaySelect', f.delay);
  $('customBodyCheck').checked = !!f.customBodyCheck;
  $('customBox').classList.toggle('hidden', !f.customBodyCheck);

  state.center = snap.center;
  state.seqr = snap.seqr || null;
  state.memoryRows = snap.memoryRows || {};
  state.vendors = (snap.vendors || []).map(v => Object.assign({}, v, { status: v.status === 'sending' ? 'pending' : v.status }));
  state.report = snap.report || [];

  renderCenterPreview();
  $('previewSection').classList.remove('hidden');
  $('toStep2Btn').disabled = false;
  setStatus($('centerStatus'), 'ok', `<i class="fa-solid fa-circle-check"></i> Previous work restored: ${state.center.rows.length} center rows, ${state.vendors.length} vendors`);
  if (state.seqr) setStatus($('seqrStatus'), 'ok', `<i class="fa-solid fa-circle-check"></i> seQRview data restored (${state.seqr.rows.length} rows)`);

  if (state.report.length) {
    updateSummary();
    $('reportWrap').classList.remove('hidden');
  }
  goStep([1, 2, 3].includes(snap.step) ? snap.step : 1);
}

// =====================================================================
// GOOGLE AUTHENTICATION
// =====================================================================
function initAuth() {
  if (!window.google || !google.accounts || !google.accounts.oauth2) {
    setTimeout(initAuth, 300);
    return;
  }
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: SCOPES,
    callback: async (resp) => {
      if (tokenWaiter) {
        const w = tokenWaiter; tokenWaiter = null;
        if (resp.error) { w.reject(new Error(resp.error)); return; }
        userToken = resp.access_token;
        saveSession();
        w.resolve();
        return;
      }
      if (resp.error) {
        $('googleBtn').disabled = false;
        setStatus($('loginStatus'), 'err', 'Authentication error: ' + esc_(resp.error));
        return;
      }
      userToken = resp.access_token;
      await fetchUserProfile();
    },
    error_callback: () => {
      if (tokenWaiter) { const w = tokenWaiter; tokenWaiter = null; w.reject(new Error('popup_closed')); }
      $('googleBtn').disabled = false;
    }
  });
  bootSession();
}

function handleGoogleSignIn() {
  if (!tokenClient) { setStatus($('loginStatus'), 'warn', 'Google library is still loading. Please try again in a moment.'); return; }
  $('googleBtn').disabled = true;
  setStatus($('loginStatus'), 'info', '<i class="fa-solid fa-spinner fa-spin mr-1.5"></i> Opening Google sign-in...');
  tokenClient.requestAccessToken({ prompt: 'select_account' });
}

function saveSession() {
  storeSet(SESSION_KEY, { email: currentUserEmail, token: userToken, timestamp: Date.now() });
}

// Silent refresh of the access token (works only while the Google session is alive)
function refreshToken() {
  return new Promise((resolve, reject) => {
    if (!tokenClient) { reject(new Error('no_client')); return; }
    const timer = setTimeout(() => {
      if (tokenWaiter) { tokenWaiter = null; reject(new Error('refresh_timeout')); }
    }, 15000);
    tokenWaiter = {
      resolve: () => { clearTimeout(timer); resolve(); },
      reject: e => { clearTimeout(timer); reject(e); }
    };
    try { tokenClient.requestAccessToken({ prompt: '' }); } catch (e) { clearTimeout(timer); tokenWaiter = null; reject(e); }
  });
}

// fetch with Bearer token; on 401 tries one silent refresh then retries
async function gFetch(url, options) {
  options = options || {};
  const doFetch = () => fetch(url, Object.assign({}, options, {
    headers: Object.assign({}, options.headers || {}, { Authorization: 'Bearer ' + userToken })
  }));
  let res = await doFetch();
  if (res.status === 401) {
    try { await refreshToken(); } catch (e) { const err = new Error('AUTH_EXPIRED'); err.code = 'AUTH_EXPIRED'; throw err; }
    res = await doFetch();
    if (res.status === 401) { const err = new Error('AUTH_EXPIRED'); err.code = 'AUTH_EXPIRED'; throw err; }
  }
  return res;
}

async function fetchUserProfile() {
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: 'Bearer ' + userToken } });
    const data = await res.json();
    const email = (data.email || '').toLowerCase().trim();

    if (email.endsWith('@innovatiview.in') || email.endsWith('@innovatiview.com')) {
      currentUserEmail = email;
      saveSession();
      enterDashboard();
      initAuditSheets().then(() => logAudit("Login Audit", [nowIST_(), email, "SUCCESS"]));
      checkAndTriggerTour();
    } else {
      $('googleBtn').disabled = false;
      setStatus($('loginStatus'), 'err', 'Access Denied: Only @innovatiview.in & @innovatiview.com accounts are authorized.');
      await initAuditSheets().catch(() => {});
      await logAudit("Login Audit", [nowIST_(), email, "FAILED - Unauthorized Domain"]);
      try { google.accounts.oauth2.revoke(userToken, () => {}); } catch (e) {}
      userToken = null;
    }
  } catch (err) {
    $('googleBtn').disabled = false;
    setStatus($('loginStatus'), 'err', 'Failed to fetch user profile. Please try again.');
  }
}

function enterDashboard() {
  $('activeUser').innerText = currentUserEmail;
  $('loginView').classList.add('hidden');
  $('dashboardView').classList.remove('hidden');
  $('googleBtn').disabled = false;
  $('loginStatus').innerHTML = '';
  updateAuditBanner();
  updateDailyInfo();
}

async function bootSession() {
  const sess = storeGet(SESSION_KEY);
  if (!sess || !sess.token || !sess.email) return;
  if (Date.now() - (sess.timestamp || 0) > SESSION_MAX_AGE_MS) { storeDel(SESSION_KEY); storeDel(SNAP_KEY); return; }
  $('bootSplash').classList.remove('hidden');
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: 'Bearer ' + sess.token } });
    if (!res.ok) throw new Error('invalid');
    const data = await res.json();
    const email = (data.email || '').toLowerCase().trim();
    if (!(email.endsWith('@innovatiview.in') || email.endsWith('@innovatiview.com'))) throw new Error('domain');
    userToken = sess.token;
    currentUserEmail = email;
    enterDashboard();
    restoreSnapshot();
    initAuditSheets();
    checkAndTriggerTour();
  } catch (e) {
    storeDel(SESSION_KEY); storeDel(SNAP_KEY);
    setStatus($('loginStatus'), 'warn', 'Session expired. Please sign in with Google again.');
  } finally {
    $('bootSplash').classList.add('hidden');
  }
}

function terminateSession() {
  if (state.running) return;
  const tok = userToken;
  storeDel(SESSION_KEY);
  storeDel(SNAP_KEY);
  userToken = null;
  currentUserEmail = "";
  const done = () => location.reload();
  try {
    if (tok && window.google && google.accounts) { google.accounts.oauth2.revoke(tok, done); setTimeout(done, 1500); }
    else done();
  } catch (e) { done(); }
}

// =====================================================================
// FIRST-TIME USER TOUR
// =====================================================================
function checkAndTriggerTour() {
  if (!currentUserEmail) return;
  if (!localStorage.getItem('opscore_tour_seen_' + currentUserEmail)) {
    currentTourStep = 1;
    showTourStep(1);
    $('tourModal').classList.remove('hidden');
  }
}

function showTourStep(step) {
  [1, 2, 3].forEach(s => {
    $('tourStep' + s).classList.toggle('hidden', s !== step);
    const dot = $('dot' + s);
    if (dot) dot.className = 'w-2.5 h-2.5 rounded-full ' + (s === step ? 'bg-indigo-600' : 'bg-slate-200');
  });
  $('tourNextBtn').innerHTML = step === 3 ? 'Got it! <i class="fa-solid fa-check ml-1"></i>' : 'Next <i class="fa-solid fa-arrow-right ml-1"></i>';
}

function nextTourStep() {
  if (currentTourStep < 3) { currentTourStep++; showTourStep(currentTourStep); } else closeTour();
}

function closeTour() {
  $('tourModal').classList.add('hidden');
  if (currentUserEmail) localStorage.setItem('opscore_tour_seen_' + currentUserEmail, 'true');
}

// =====================================================================
// GOOGLE SHEETS: AUDIT LOGGING, VENDOR MEMORY, DUPLICATE DATA
// =====================================================================
const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets/';
let auditReadyPromise = null;
let auditError = '';

function auditEnabled() { return !!(MASTER_SPREADSHEET_ID && MASTER_SPREADSHEET_ID.trim()); }

function updateAuditBanner() {
  const el = $('auditBanner');
  if (!auditEnabled()) {
    el.innerHTML = '<i class="fa-solid fa-triangle-exclamation mr-1.5"></i>Audit logging is OFF (MASTER_SPREADSHEET_ID is empty). Vendor memory and duplicate guard are also disabled.';
    el.classList.remove('hidden');
  } else if (auditError) {
    el.innerHTML = '<i class="fa-solid fa-triangle-exclamation mr-1.5"></i>Audit sheet problem: ' + esc_(auditError);
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

function sheetsErr_(res, body) {
  return (body && body.error && body.error.message) ? body.error.message : ('Sheets API error ' + res.status);
}

// Creates missing tabs (with bold + frozen header row). Safe to call many times.
function initAuditSheets() {
  if (!auditEnabled()) { updateAuditBanner(); return Promise.resolve(); }
  if (auditReadyPromise) return auditReadyPromise;
  auditReadyPromise = (async () => {
    try {
      const metaRes = await gFetch(SHEETS_BASE + MASTER_SPREADSHEET_ID + '?fields=sheets.properties');
      const meta = await metaRes.json();
      if (!metaRes.ok) throw new Error(sheetsErr_(metaRes, meta));
      const existing = {};
      (meta.sheets || []).forEach(s => { existing[s.properties.title] = true; });

      for (const title of Object.keys(LOG_HEADERS)) {
        if (existing[title]) continue;
        const addRes = await gFetch(SHEETS_BASE + MASTER_SPREADSHEET_ID + ':batchUpdate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requests: [{ addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } } }] })
        });
        const addBody = await addRes.json();
        if (!addRes.ok) {
          const msg = sheetsErr_(addRes, addBody);
          if (/already exists/i.test(msg)) continue; // another user created it at the same time
          throw new Error(msg);
        }
        const sheetId = addBody.replies[0].addSheet.properties.sheetId;
        const headers = LOG_HEADERS[title];
        await gFetch(SHEETS_BASE + MASTER_SPREADSHEET_ID + '/values/' + encodeURIComponent("'" + title + "'!A1") + '?valueInputOption=RAW', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ values: [headers] })
        });
        await gFetch(SHEETS_BASE + MASTER_SPREADSHEET_ID + ':batchUpdate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requests: [{
            repeatCell: {
              range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
              cell: { userEnteredFormat: { textFormat: { bold: true } } },
              fields: 'userEnteredFormat.textFormat.bold'
            }
          }] })
        });
      }
      auditError = '';
    } catch (e) {
      auditError = e.message || String(e);
      auditReadyPromise = null;
    }
    updateAuditBanner();
  })();
  return auditReadyPromise;
}

async function logAudit(sheetName, rowValues) {
  if (!auditEnabled() || !userToken) return;
  try {
    await initAuditSheets();
    const url = SHEETS_BASE + MASTER_SPREADSHEET_ID + '/values/' + encodeURIComponent("'" + sheetName + "'!A1") +
      ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS';
    const res = await gFetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [rowValues.map(x => String(x == null ? '' : x))] })
    });
    if (!res.ok) {
      let m = ''; try { const e = await res.json(); m = e.error && e.error.message; } catch (x) {}
      console.warn('Audit log failed for ' + sheetName + ': ' + m);
    }
  } catch (e) {
    console.warn('Audit logging skipped:', e.message);
  }
}

async function readSheetValues_(sheetName, cols) {
  await initAuditSheets();
  const res = await gFetch(SHEETS_BASE + MASTER_SPREADSHEET_ID + '/values/' + encodeURIComponent("'" + sheetName + "'!" + cols));
  const body = await res.json();
  if (!res.ok) throw new Error(sheetsErr_(res, body));
  return body.values || [];
}

// ---------------- Vendor memory ----------------
async function loadVendorMemoryBulk() {
  const out = {};
  state.memoryRows = {};
  if (!auditEnabled()) return out;
  try {
    const data = await readSheetValues_('Vendor Memory', 'A:J');
    for (let i = 1; i < data.length; i++) {
      const r = data[i];
      const key = String(r[0] || '').trim().toLowerCase();
      if (!key) continue;
      out[key] = { email: r[1] || '', shift: r[2] || '', training: r[3] || '', enclosure: r[4] || '', mock: r[5] || '', reporting_time: r[6] || '', cc: r[7] || '', zm: r[8] || '' };
      state.memoryRows[key] = i + 1; // latest row wins
    }
  } catch (e) { console.warn('Vendor memory load failed:', e.message); }
  return out;
}

async function saveVendorMemory(v) {
  if (!auditEnabled()) return;
  try {
    const key = String(v.name).trim().toLowerCase();
    const rowNo = state.memoryRows[key];
    let oldTraining = '', oldEnclosure = '';
    if (rowNo) {
      const res = await gFetch(SHEETS_BASE + MASTER_SPREADSHEET_ID + '/values/' + encodeURIComponent("'Vendor Memory'!A" + rowNo + ":J" + rowNo));
      const body = await res.json();
      const old = (body.values && body.values[0]) || [];
      oldTraining = old[3] || ''; oldEnclosure = old[4] || '';
    }
    const row = [
      v.name, v.email || '', v.shift || '',
      v.training || oldTraining, v.enclosure || oldEnclosure,
      v.mock || '', $('reportingTime').value.trim(), v.cc || '', $('zmSelect').value, nowIST_()
    ].map(x => String(x == null ? '' : x));

    if (rowNo) {
      await gFetch(SHEETS_BASE + MASTER_SPREADSHEET_ID + '/values/' + encodeURIComponent("'Vendor Memory'!A" + rowNo + ":J" + rowNo) + '?valueInputOption=RAW', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values: [row] })
      });
    } else {
      const res = await gFetch(SHEETS_BASE + MASTER_SPREADSHEET_ID + '/values/' + encodeURIComponent("'Vendor Memory'!A1") + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values: [row] })
      });
      const body = await res.json();
      const m = body && body.updates && String(body.updates.updatedRange || '').match(/!A(\d+)/);
      if (m) state.memoryRows[key] = parseInt(m[1], 10);
    }
  } catch (e) { console.warn('Vendor memory save failed:', e.message); }
}

// ---------------- Duplicate guard ----------------
function dupFingerprint_(o) {
  const service = String(o.service || 'Biometric');
  const frisking = service === 'Frisking';
  const parts = [
    o.vendor_name, o.vendor_mail, o.cc, o.zm_name, service,
    o.project_code, o.exam_name, o.exam_date,
    o.shift, frisking ? '' : o.training, frisking ? o.enclosure : '', o.mock, o.reporting_time,
    o.operator_list_date, o.final_operator_date, o.csr_submit_date,
    o.center_rows, o.seqr_rows
  ];
  return parts.map(x => String(x == null ? '' : x).trim().replace(/\s+/g, ' ').toLowerCase()).join('|');
}

function dupItem(v) {
  const c = getCommon();
  const zm = ZM_DETAILS[c.zm_select] || { name: '' };
  return {
    vendor_name: v.name, vendor_mail: (v.email || '').trim(), cc: (v.cc || '').trim(), zm_name: zm.name, service: c.service,
    project_code: c.project_code, exam_name: c.exam_name, exam_date: c.exam_date,
    shift: (v.shift || '').trim(), training: (v.training || '').trim(), enclosure: (v.enclosure || '').trim(), mock: (v.mock || '').trim(),
    reporting_time: c.reporting_time, operator_list_date: c.operator_list_date, final_operator_date: c.final_operator_date,
    csr_submit_date: c.csr_submit_date, center_rows: v.centerCount, seqr_rows: v.seqrCount
  };
}

// Returns { fingerprint: {time, sender} } for mails already SENT
async function loadSentFingerprints() {
  const seen = {};
  if (!auditEnabled()) return seen;
  try {
    const data = await readSheetValues_('Dispatch Audit', 'A:Y');
    for (let i = 1; i < data.length; i++) {
      const r = data[i];
      if (String(r[8] || '').indexOf('SENT') !== 0) continue;
      const fp = dupFingerprint_({
        vendor_name: r[2], vendor_mail: r[3], zm_name: r[4], shift: r[5], cc: r[6],
        service: r[10], exam_name: r[11], exam_date: r[12], project_code: r[13],
        training: r[14], enclosure: r[15], mock: r[16], reporting_time: r[17],
        center_rows: r[19], seqr_rows: r[20],
        operator_list_date: r[22], final_operator_date: r[23], csr_submit_date: r[24]
      });
      seen[fp] = { time: r[0] || '', sender: r[1] || '' };
    }
  } catch (e) { console.warn('Duplicate check failed:', e.message); }
  return seen;
}

// =====================================================================
// WINDOW NAVIGATION
// =====================================================================
function updateStepper(n) {
  for (let i = 1; i <= 3; i++) {
    const c = $('stepCircle' + i), l = $('stepLabel' + i);
    c.className = 'step-circle' + (i < n ? ' done' : (i === n ? ' active' : ''));
    l.className = 'step-label' + (i < n ? ' done' : (i === n ? ' active' : ''));
    c.innerHTML = i < n ? '<i class="fa-solid fa-check"></i>' : String(i);
  }
  $('stepLine1').className = 'step-line' + (n > 1 ? ' done' : '');
  $('stepLine2').className = 'step-line' + (n > 2 ? ' done' : '');
}

function goStep(n) {
  if (state.running) return;
  if (n >= 2 && !state.center) {
    setStatus($('centerStatus'), 'err', 'Please upload and process the Center List first.');
    return;
  }
  if (n === 3) {
    const missing = validateCommon();
    if (missing.length) {
      setStatus($('commonStatus'), 'err', 'Complete common fields: ' + escHtml(missing.join(', ')));
      return;
    }
    $('commonStatus').innerHTML = '';
    renderVendorTable();
    updateDailyInfo();
  }
  [1, 2, 3].forEach(i => $('win' + i).classList.toggle('hidden', i !== n));
  state.step = n;
  updateStepper(n);
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (n === 2) scheduleSubjectUpdate();
  scheduleSave();
}

function createNewMail() {
  if (state.running) return;
  if (!confirm('Start a new mail? The uploaded Center List, seQRview data, vendor details and common fields will be cleared.')) return;

  state.center = null; state.seqr = null; state.vendors = []; state.report = []; state.cancel = false; state.memoryRows = {};
  ['centerCsv', 'seqrCsv', 'vendorMapFile'].forEach(id => { $(id).value = ''; });
  document.querySelectorAll('.dz-name').forEach(el => { el.innerText = ''; });
  ['modalitySelect', 'projectCode', 'examName', 'examDate', 'operatorListDate', 'finalOperatorDate', 'csrSubmitDate',
   'reportingTime', 'customNotes', 'defShift', 'defTraining', 'defEnclosure', 'defMock', 'defCc', 'vendorFilter']
    .forEach(id => { $(id).value = ''; });
  $('customBodyCheck').checked = false;
  $('customBox').classList.add('hidden');
  $('checkAll').checked = false;
  $('previewSection').classList.add('hidden');
  $('toStep2Btn').disabled = true;
  ['centerStatus', 'seqrStatus', 'mappingStatus', 'commonStatus', 'dispatchStatus', 'progressText'].forEach(id => { $(id).innerHTML = ''; });
  $('progressWrap').classList.add('hidden');
  $('reportWrap').classList.add('hidden');
  $('vendorRows').innerHTML = '';
  $('subjectPreview').innerText = '[Subject string will auto compile as you fill the fields...]';
  storeDel(SNAP_KEY);
  goStep(1);
}

// =====================================================================
// FILE PARSING
// =====================================================================
function readFileAsRows(file) {
  return new Promise((resolve, reject) => {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!['csv', 'xlsx', 'xls'].includes(ext)) {
      reject(new Error('Unsupported file type. Please upload a .csv, .xlsx or .xls file.'));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Unable to read the selected file.'));
    reader.onload = e => {
      try {
        const wb = ext === 'csv' ? XLSX.read(e.target.result, { type: 'string' }) : XLSX.read(e.target.result, { type: 'array' });
        let aoa = [];
        for (const name of wb.SheetNames) {
          const candidate = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '', blankrows: false });
          if (candidate.length) { aoa = candidate; break; }
        }
        if (!aoa.length) throw new Error('The uploaded file is empty.');
        resolve(aoa.map(r => r.map(c => String(c == null ? '' : c).trim())));
      } catch (err) { reject(err); }
    };
    if (ext === 'csv') reader.readAsText(file, 'UTF-8'); else reader.readAsArrayBuffer(file);
  });
}

// Header row = row containing "Vendor Name" (first 10 rows). Rows above it are kept in topRows.
function parseTable(aoa, fallbackHeaderIdx) {
  let headerIdx = -1;
  const limit = Math.min(aoa.length, 10);
  for (let i = 0; i < limit; i++) {
    if (aoa[i].some(c => norm(c) === 'vendor name')) { headerIdx = i; break; }
  }
  if (headerIdx === -1) headerIdx = Math.min(fallbackHeaderIdx, aoa.length - 1);

  let headers = aoa[headerIdx].slice();
  let last = headers.length - 1;
  while (last >= 0 && !headers[last]) last--;
  headers = headers.slice(0, last + 1);

  const topRows = [];
  for (let i = 0; i < headerIdx; i++) {
    const r = aoa[i].map(c => (c == null ? '' : String(c)));
    let lastCell = r.length - 1;
    while (lastCell >= 0 && String(r[lastCell]).trim() === '') lastCell--;
    const trimmed = r.slice(0, lastCell + 1);
    if (trimmed.length) topRows.push(trimmed);
  }

  const rows = aoa.slice(headerIdx + 1)
    .map(r => headers.map((_, i) => (r[i] == null ? '' : String(r[i]))))
    .filter(r => r.some(c => String(c).trim() !== ''));

  const vIdx = headers.findIndex(h => norm(h) === 'vendor name');
  return { headers, rows, topRows, vIdx, headerRowNumber: headerIdx + 1 };
}

// =====================================================================
// GOOGLE SHEET SOURCES (Center List + seQRview)
// =====================================================================
const srcMode_ = { center: 'link', seqr: 'link' };
const normH_ = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');

function extractSheetId_(text) {
  const s = String(text || '').trim();
  const m = s.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  return /^[a-zA-Z0-9_-]{25,}$/.test(s) ? s : '';
}

function saveLinks_() {
  storeSet(LINKS_KEY, { center: $('centerSheetUrl').value.trim(), seqr: $('seqrSheetUrl').value.trim() });
}

async function fetchSheetTab_(spreadsheetId, tabName) {
  const url = SHEETS_BASE + spreadsheetId + '/values/' +
    encodeURIComponent("'" + String(tabName).replace(/'/g, "''") + "'") +
    '?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS';
  let res;
  try {
    res = await gFetch(url);
  } catch (e) {
    if (e && e.code === 'AUTH_EXPIRED') throw new Error('Google session expired. Please terminate the session and sign in again.');
    throw e;
  }
  const body = await res.json();
  if (!res.ok) {
    const msg = sheetsErr_(res, body);
    if (/Unable to parse range/i.test(msg)) throw new Error('Tab "' + tabName + '" was not found in this sheet. Please check the tab name.');
    if (res.status === 403 || res.status === 404) throw new Error('Could not open the sheet. Is the link correct and does your Google account have access? (' + msg + ')');
    throw new Error(msg);
  }
  const aoa = (body.values || []).map(r => r.map(c => String(c == null ? '' : c).trim()));
  if (!aoa.length) throw new Error('Tab "' + tabName + '" is empty.');
  return aoa;
}

const DATE_CELL_RE_ = /^(\d{1,2}[-\/. ](\d{1,2}|[A-Za-z]{3,9})[-\/. ]\d{2,4}|[A-Za-z]{3,9}[-. ]\d{1,2},?[-. ]\d{2,4})$/;
const DAY_COL_RES_ = {
  Biometric: /^(opcounts\d+|maxday\d+)$/,
  Frisking: /^(male|female|baggagecrowd|total)$/
};
function isDateCell_(s) { return DATE_CELL_RE_.test(String(s == null ? '' : s).trim()); }

// Row 2 (header row) se sirf FIXED_HEADERS pick karta hai. Row 1 (date) top row banti hai.
function buildCenterFromSheet_(aoa, service) {
  const spec = FIXED_HEADERS[service];
  if (!spec) throw new Error('Unknown mail type: ' + service);

  let hIdx = -1;
  const lim = Math.min(aoa.length, 10);
  for (let i = 0; i < lim; i++) {
    const hn0 = aoa[i].map(normH_);
    if (hn0.includes('centercode') && hn0.some(h => h.indexOf('vendorname') === 0)) { hIdx = i; break; }
  }
  if (hIdx === -1) hIdx = Math.min(1, aoa.length - 1);

  const headerRow = aoa[hIdx];
  const hn = headerRow.map(normH_);
  const width = hn.length;
  const dataRows = aoa.slice(hIdx + 1);
  const dateRow = hIdx > 0 ? (aoa[hIdx - 1] || []) : [];
  const cellAt = (arr, i) => String(arr[i] == null ? '' : arr[i]).trim();
  const used = new Set();
  const picks = [];
  const missing = [];
  let cursor = -1;
  let wantDays = false;

  spec.forEach(item => {
    if (item === '@DAYS') { wantDays = true; return; }
    const names = item.split('|');
    const alts = names.map(normH_);
    const cands = [];
    hn.forEach((h, i) => { if (!used.has(i) && h && alts.includes(h)) cands.push(i); });
    if (!cands.length) { missing.push(names[0]); return; }
    let idx;
    if (names.length > 1 && cands.length > 1) {
      let best = cands[0], bestScore = Infinity;
      cands.forEach(ci => {
        let score = 0;
        dataRows.forEach(r => { if (/\d{10}/.test(String(r[ci] || ''))) score++; });
        if (score < bestScore) { bestScore = score; best = ci; }
      });
      idx = best;
    } else {
      const after = cands.filter(i => i > cursor);
      idx = (after.length ? after : cands)[0];
    }
    used.add(idx);
    cursor = idx;
    picks.push({ idx, label: names[0] });
  });

  if (!picks.some(p => p.label === 'Vendor Name')) {
    throw new Error('The "Vendor Name" column was not found in the sheet. Please check the header row (Row 2).');
  }

  // ---- Multi-day blocks: Row 1 ki dates ke hisaab se OP Count S1/S2/S3 + Max DayN columns ----
  let dayCount = 0;
  if (wantDays) {
    const lastStatic = picks.length ? Math.max.apply(null, picks.map(p => p.idx)) : -1;
    const scanLen = Math.max(width, dateRow.length);
    const starts = [];
    for (let i = Math.max(lastStatic, 0); i < scanLen; i++) {
      if (isDateCell_(cellAt(dateRow, i))) starts.push(i);
    }
    let blocks;
    if (starts.length) {
      blocks = starts.map(s => {
        let e = s + 1;
        while (e < scanLen && !cellAt(dateRow, e)) e++;
        return [s, e];
      });
    } else {
      blocks = [[lastStatic + 1, width]];
    }
    dayCount = blocks.length;
    const dayRe = DAY_COL_RES_[service] || DAY_COL_RES_.Biometric;
    blocks.forEach(([s, e]) => {
      for (let i = s; i < e && i < width; i++) {
        if (used.has(i)) continue;
        if (!dayRe.test(hn[i])) {
          // date ke neeche ka block khatam hote hi ruk jao (aage ke dusre "Total" jaise columns na utha le)
          if (starts.length) break; else continue;
        }
        used.add(i);
        picks.push({ idx: i, label: String(headerRow[i]).trim().replace(/\s+/g, ' ') });
      }
    });
  }

  const headers = picks.map(p => p.label);
  const ci = headers.indexOf('Center Code');
  const vi = headers.indexOf('Vendor Name');
  const rows = dataRows
    .map(r => picks.map(p => (r[p.idx] == null ? '' : String(r[p.idx]))))
    .filter(r => (ci >= 0 && String(r[ci]).trim() !== '') || String(r[vi]).trim() !== '');

  // ---- Row 1: sirf dates (baaki extra text ignore), block ke upar merge ----
  const topRows = [];
  const topMerges = [];
  if (hIdx > 0) {
    const row = new Array(picks.length).fill('');
    const orphans = [];
    const scanLen2 = Math.max(width, dateRow.length);
    for (let s = 0; s < scanLen2; s++) {
      if (!isDateCell_(cellAt(dateRow, s))) continue;
      let e = s + 1;
      while (e < scanLen2 && !cellAt(dateRow, e)) e++;
      const cols = [];
      picks.forEach((p, k) => { if (p.idx >= s && p.idx < e) cols.push(k); });
      if (cols.length) {
        row[cols[0]] = cellAt(dateRow, s);
        const contiguous = cols.every((c, i) => i === 0 || c === cols[i - 1] + 1);
        if (cols.length > 1 && contiguous) topMerges.push({ r: 0, c1: cols[0], c2: cols[cols.length - 1] });
      } else {
        orphans.push(cellAt(dateRow, s));
      }
    }
    if (orphans.length) {
      const k = row.length - 1;
      row[k] = row[k] ? row[k] + ' | ' + orphans.join(' | ') : orphans.join(' | ');
    }
    if (row.some(c => String(c).trim() !== '')) topRows.push(row);
  }

  return {
    table: { headers, rows, topRows, topMerges, vIdx: vi, headerRowNumber: hIdx + 1, src: 'link', service, dayCount },
    missing
  };
}

async function loadCenterFromSheet_() {
  const service = $('serviceSelect').value;
  const id = extractSheetId_($('centerSheetUrl').value);
  if (!id) throw new Error('Please enter a valid Vendor Guard OP Google Sheet link.');
  saveLinks_();
  const tab = CENTER_TABS[service];
  const aoa = await fetchSheetTab_(id, tab);
  const out = buildCenterFromSheet_(aoa, service);
  out.tab = tab;
  return out;
}

async function loadSeqrFromSheet_() {
  const service = $('serviceSelect').value;
  const id = extractSheetId_($('seqrSheetUrl').value);
  if (!id) throw new Error('Please enter a valid seQRview data Google Sheet link.');
  saveLinks_();
  const tab = SEQR_TABS[service];
  const aoa = await fetchSheetTab_(id, tab);
  const table = parseTable(aoa, 0);
  table.src = 'link';
  table.service = service;
  return { table, tab };
}

// ---- UI helpers ----
function setSrcMode(which, mode) {
  srcMode_[which] = mode;
  $(which + 'LinkBox').classList.toggle('hidden', mode !== 'link');
  $(which + 'FileBox').classList.toggle('hidden', mode !== 'file');
  const on = 'bg-indigo-600 text-white';
  const off = 'bg-white text-slate-600 border border-slate-200';
  ['link', 'file'].forEach(m => {
    $(which + 'Mode_' + m).className = 'flex-1 py-1.5 rounded-lg text-[11px] font-bold transition ' + (m === mode ? on : off);
  });
  const labels = {
    center: { link: 'Fetch & Preview Center List', file: 'Process & Preview Center List' },
    seqr: { link: 'Fetch seQRview Data', file: 'Upload seQRview Data' }
  };
  $(which + 'BtnLabel').innerText = labels[which][mode];
}

function updateTabHints_() {
  const svc = $('serviceSelect').value;
  if ($('centerTabHint')) $('centerTabHint').innerText = CENTER_TABS[svc] || '';
  if ($('seqrTabHint')) $('seqrTabHint').innerText = SEQR_TABS[svc] || '';
  if ($('serviceLabel2')) $('serviceLabel2').innerText = svc;
}

function onStep1ServiceChange() {
  $('serviceSelect').value = $('svcStep1').value;
  onServiceChange();
}

// Link se fetch hua data agar kisi aur mail type ka hai to naam return karta hai
function staleSources_() {
  const svc = $('serviceSelect').value;
  const out = [];
  if (state.center && state.center.src === 'link' && state.center.service !== svc) out.push('Center List');
  if (state.seqr && state.seqr.src === 'link' && state.seqr.service !== svc) out.push('seQRview data');
  return out;
}

function initSourceUi() {
  const saved = storeGet(LINKS_KEY) || {};
  $('centerSheetUrl').value = saved.center || DEFAULT_CENTER_SHEET_URL;
  $('seqrSheetUrl').value = saved.seqr || DEFAULT_SEQR_SHEET_URL;
  setSrcMode('center', 'link');
  setSrcMode('seqr', 'link');
  $('svcStep1').value = $('serviceSelect').value;
  updateTabHints_();
}

// =====================================================================
// WINDOW 1 : CENTER LIST & seQRview
// =====================================================================
async function uploadCenterList() {
  const fileInput = $('centerCsv');
  const status = $('centerStatus');
  const mode = srcMode_.center;
  if (mode === 'file' && !fileInput.files.length) { setStatus(status, 'err', 'Please select a Center List file first.'); return; }
  $('centerBtn').disabled = true;
  $('toStep2Btn').disabled = true;
  setStatus(status, 'info', '<i class="fa-solid fa-spinner fa-spin mr-1"></i> ' + (mode === 'link' ? 'Fetching data from Google Sheet......' : 'Processing file...'));
  try {
    let table, missing = [], tabInfo = '';
    if (mode === 'link') {
      const r = await loadCenterFromSheet_();
      table = r.table; missing = r.missing; tabInfo = ' (tab: ' + r.tab + ')';
    } else {
      const aoa = await readFileAsRows(fileInput.files[0]);
      table = parseTable(aoa, 1);
      table.src = 'file';
    }
    if (table.vIdx === -1) throw new Error('"Vendor Name" column was not found.');
    if (!table.rows.length) throw new Error('No data rows found.');

    state.center = table;
    setStatus(status, 'info', '<i class="fa-solid fa-spinner fa-spin mr-1"></i> Loading vendor memory...');
    await buildVendorsWithMemory();
    renderCenterPreview();
    $('previewSection').classList.remove('hidden');
    $('toStep2Btn').disabled = false;
    scheduleSave();
    const okMsg = `<i class="fa-solid fa-circle-check"></i> Loaded ${table.rows.length} center rows, ${state.vendors.length} unique vendors${tabInfo}` + (table.dayCount ? ` | ${table.dayCount} exam day(s) detected` : '');
    if (missing.length) {
      setStatus(status, 'warn', okMsg + '<br>These headers were not found in the sheet (skipped): ' + escHtml(missing.join(', ')));
    } else {
      setStatus(status, 'ok', okMsg);
    }
  } catch (err) {
    setStatus(status, 'err', escHtml(err.message || err));
  } finally {
    $('centerBtn').disabled = false;
  }
}

function renderCenterPreview() {
  const t = state.center;
  $('totalRowsCount').innerText = t.rows.length;
  $('previewBadge').innerText = `Headers parsed from Row ${t.headerRowNumber}`;
  const headerRow = $('tableHeaderRow');
  headerRow.innerHTML = '';
  t.headers.forEach(h => {
    const th = document.createElement('th');
    th.className = 'p-2.5 border-b border-slate-200 whitespace-nowrap';
    th.innerText = h;
    headerRow.appendChild(th);
  });
  const body = $('tableBodyRows');
  body.innerHTML = '';

  t.topRows.forEach(row => {
    const tr = document.createElement('tr');
    tr.className = 'bg-amber-50 text-amber-900';
    row.forEach(cell => {
      const td = document.createElement('td');
      td.className = 'p-2.5 border-b border-amber-100 whitespace-nowrap font-semibold';
      td.innerText = cell;
      tr.appendChild(td);
    });
    body.appendChild(tr);
  });
  $('topRowNote').classList.toggle('hidden', !t.topRows.length);

  t.rows.slice(0, 15).forEach(row => {
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-slate-50 transition';
    row.forEach(cell => {
      const td = document.createElement('td');
      td.className = 'p-2.5 border-b border-slate-100 whitespace-nowrap';
      td.innerText = cell;
      tr.appendChild(td);
    });
    body.appendChild(tr);
  });
}

async function buildVendorsWithMemory() {
  const previous = {};
  state.vendors.forEach(v => { previous[v.key] = v; });
  const map = {};
  state.center.rows.forEach(r => {
    const name = String(r[state.center.vIdx]).trim();
    if (!name) return;
    const key = norm(name);
    if (!map[key]) map[key] = { name, key, centerCount: 0 };
    map[key].centerCount++;
  });

  const keys = Object.keys(map).sort();
  const memMap = await loadVendorMemoryBulk();

  state.vendors = [];
  for (const key of keys) {
    const old = previous[key];
    const vData = map[key];
    const mem = memMap[String(vData.name).trim().toLowerCase()] || null;
    state.vendors.push({
      name: vData.name, key,
      centerCount: vData.centerCount,
      seqrCount: 0,
      selected: old ? old.selected : true,
      email: old ? old.email : (mem ? mem.email : ''),
      shift: old ? old.shift : (mem ? mem.shift : ''),
      training: old ? old.training : (mem ? mem.training : ''),
      enclosure: old ? old.enclosure : (mem ? mem.enclosure : ''),
      mock: old ? old.mock : (mem ? mem.mock : ''),
      cc: old ? old.cc : (mem ? mem.cc : ''),
      status: old && old.status === 'sent' ? 'sent' : 'pending',
      message: old ? old.message : ''
    });
  }
  refreshSeqrCounts();
}

async function uploadSeqrData() {
  const fileInput = $('seqrCsv');
  const status = $('seqrStatus');
  const mode = srcMode_.seqr;
  if (mode === 'file' && !fileInput.files.length) { setStatus(status, 'err', 'Please select a seQRview file first.'); return; }
  $('seqrBtn').disabled = true;
  setStatus(status, 'info', '<i class="fa-solid fa-spinner fa-spin mr-1"></i> ' + (mode === 'link' ? 'Fetching data from Google Sheet......' : 'Processing file...'));
  try {
    let table, tabInfo = '';
    if (mode === 'link') {
      const r = await loadSeqrFromSheet_();
      table = r.table; tabInfo = ' (tab: ' + r.tab + ')';
    } else {
      const aoa = await readFileAsRows(fileInput.files[0]);
      table = parseTable(aoa, 0);
      table.src = 'file';
    }
    state.seqr = table;
    refreshSeqrCounts();
    if (state.vendors.length) renderVendorTable();
    scheduleSave();
    if (table.vIdx === -1) {
      setStatus(status, 'warn', `Loaded (${table.rows.length} rows)${tabInfo} but the "Vendor Name" column was not found - vendors cannot be matched.`);
    } else {
      const matched = state.vendors.filter(v => v.seqrCount > 0).length;
      const extra = state.vendors.length ? ` | ${matched} of ${state.vendors.length} vendors have seQRview data` : '';
      setStatus(status, 'ok', `<i class="fa-solid fa-circle-check"></i> Loaded (${table.rows.length} rows)${tabInfo}${extra}`);
    }
  } catch (err) {
    setStatus(status, 'err', escHtml(err.message || err));
  } finally {
    $('seqrBtn').disabled = false;
  }
}

function refreshSeqrCounts() {
  const counts = {};
  if (state.seqr && state.seqr.vIdx !== -1) {
    state.seqr.rows.forEach(r => {
      const k = norm(r[state.seqr.vIdx]);
      if (k) counts[k] = (counts[k] || 0) + 1;
    });
  }
  state.vendors.forEach(v => { v.seqrCount = counts[v.key] || 0; });
}

// =====================================================================
// WINDOW 2 : COMMON FIELDS
// =====================================================================
function isBiometric() { return $('serviceSelect').value === 'Biometric'; }

function onServiceChange() {
  const bio = isBiometric();
  $('fieldModality').classList.toggle('hidden', !bio);
  if (!bio) $('modalitySelect').value = '';
  $('thTrainEnc').innerText = bio ? 'Training *' : 'Enclosure *';
  if ($('svcStep1')) $('svcStep1').value = $('serviceSelect').value;
  updateTabHints_();
  const svc = $('serviceSelect').value;
  if (state.center && state.center.src === 'link' && state.center.service !== svc) {
    setStatus($('centerStatus'), 'warn', 'Mail type changed - please fetch the Center List again.');
  }
  if (state.seqr && state.seqr.src === 'link' && state.seqr.service !== svc) {
    setStatus($('seqrStatus'), 'warn', 'Mail type changed - please fetch the seQRview data again.');
  }
  if (state.vendors.length) renderVendorTable();
  scheduleSubjectUpdate();
}

function getCommon() {
  return {
    zm_select: $('zmSelect').value,
    service: $('serviceSelect').value,
    modality: $('modalitySelect').value.trim(),
    project_code: $('projectCode').value.trim(),
    exam_name: $('examName').value.trim(),
    exam_date: $('examDate').value.trim(),
    operator_list_date: $('operatorListDate').value.trim(),
    final_operator_date: $('finalOperatorDate').value.trim(),
    csr_submit_date: $('csrSubmitDate').value.trim(),
    reporting_time: $('reportingTime').value.trim(),
    custom_notes_check: $('customBodyCheck').checked,
    custom_notes: $('customNotes').value,
    attachment_format: $('attachFormat').value
  };
}

function validateCommon() {
  const c = getCommon();
  const missing = [];
  if (!c.zm_select) missing.push('Zonal Manager (ZM)');
  if (isBiometric() && !c.modality) missing.push('Modality');
  if (!c.project_code) missing.push('Project Code');
  if (!c.exam_name) missing.push('Exam Name');
  if (!c.exam_date) missing.push('Exam Date');
  if (!c.operator_list_date) missing.push('Operator List Date');
  if (!c.final_operator_date) missing.push('Final Operator Date');
  if (!c.csr_submit_date) missing.push('CSR Submit Date');
  if (!c.reporting_time) missing.push('Reporting Time');
  return missing;
}

function scheduleSubjectUpdate() {
  clearTimeout(state.subjectTimer);
  state.subjectTimer = setTimeout(() => {
    const c = getCommon();
    $('subjectPreview').innerText = (c.project_code || c.exam_name || c.exam_date)
      ? generateSubject(c)
      : '[Subject string will auto compile as you fill the fields...]';
  }, 200);
}

// =====================================================================
// WINDOW 3 : VENDOR TABLE
// =====================================================================
const STATUS_STYLE = {
  pending: ['Pending', 'bg-slate-100 text-slate-600'],
  sending: ['Sending...', 'bg-indigo-100 text-indigo-700'],
  sent: ['Sent', 'bg-emerald-100 text-emerald-700'],
  failed: ['Failed', 'bg-rose-100 text-rose-700'],
  skipped: ['Skipped', 'bg-amber-100 text-amber-700']
};

function renderVendorTable() {
  const body = $('vendorRows');
  body.innerHTML = '';
  const bio = isBiometric();
  $('thTrainEnc').innerText = bio ? 'Training *' : 'Enclosure *';

  state.vendors.forEach((v, i) => {
    const tr = document.createElement('tr');
    tr.id = 'vrow-' + i;
    tr.className = 'hover:bg-slate-50 transition';
    tr.dataset.name = v.key;

    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = v.selected;
    cb.onchange = () => { v.selected = cb.checked; updateSelectedCount(); };
    tr.appendChild(cell(cb, 'p-2.5'));

    const nameTd = document.createElement('td');
    nameTd.className = 'p-2.5 font-semibold whitespace-nowrap';
    nameTd.innerText = v.name;
    tr.appendChild(nameTd);

    const cTd = document.createElement('td');
    cTd.className = 'p-2.5 text-center'; cTd.innerText = v.centerCount;
    tr.appendChild(cTd);

    const sTd = document.createElement('td');
    sTd.className = 'p-2.5 text-center';
    if (v.seqrCount) sTd.innerText = v.seqrCount;
    else sTd.innerHTML = '<span class="badge bg-amber-100 text-amber-700">Missing</span>';
    tr.appendChild(sTd);

    tr.appendChild(cell(inputFor(v, 'email', 'vendor@domain.com'), 'p-2'));
    tr.appendChild(cell(inputFor(v, 'shift', '400/600'), 'p-2'));
    tr.appendChild(cell(inputFor(v, bio ? 'training' : 'enclosure', bio ? '100' : '150'), 'p-2'));
    tr.appendChild(cell(inputFor(v, 'mock', '200'), 'p-2'));
    tr.appendChild(cell(inputFor(v, 'cc', 'cc@domain.com'), 'p-2'));

    const stTd = document.createElement('td');
    stTd.className = 'p-2.5'; stTd.id = 'vstatus-' + i;
    tr.appendChild(stTd);

    const pvTd = document.createElement('td');
    pvTd.className = 'p-2.5';
    const pv = document.createElement('button');
    pv.type = 'button'; pv.title = 'Preview mail for this vendor';
    pv.className = 'text-indigo-600 hover:text-indigo-800';
    pv.innerHTML = '<i class="fa-solid fa-eye"></i>';
    pv.onclick = () => openMailPreview(i);
    pvTd.appendChild(pv);
    tr.appendChild(pvTd);

    body.appendChild(tr);
    paintStatus(i);
  });
  $('vendorTotal').innerText = state.vendors.length;
  updateSelectedCount();
  filterVendors();
  scheduleSave();
}

function cell(child, cls) {
  const td = document.createElement('td');
  td.className = cls;
  td.appendChild(child);
  return td;
}

function inputFor(v, field, placeholder) {
  const inp = document.createElement('input');
  inp.type = 'text'; inp.className = 'vendor-input';
  inp.placeholder = placeholder; inp.value = v[field] || '';
  inp.oninput = () => { v[field] = inp.value; inp.classList.remove('invalid'); };
  inp.dataset.field = field;
  return inp;
}

function paintStatus(i) {
  const v = state.vendors[i];
  const el = $('vstatus-' + i);
  if (!el) return;
  const [label, cls] = STATUS_STYLE[v.status] || STATUS_STYLE.pending;
  el.innerHTML = `<span class="badge ${cls}" title="${escHtml(v.message || '')}">${label}</span>`;
  scheduleSave();
}

function updateSelectedCount() {
  const n = state.vendors.filter(v => v.selected).length;
  $('selectedCount').innerText = n;
  const pending = state.vendors.filter(v => v.selected && v.status !== 'sent').length;
  $('dispatchBtnLabel').innerText = pending
    ? `Dispatch Emails to ${pending} Selected Vendor${pending > 1 ? 's' : ''}`
    : 'Dispatch Emails to Selected Vendors';
}

function filterVendors() {
  const q = norm($('vendorFilter').value);
  document.querySelectorAll('#vendorRows tr').forEach(tr => {
    tr.classList.toggle('hidden', q && !tr.dataset.name.includes(q));
  });
}

function selectAllVendors(flag) {
  state.vendors.forEach((v, i) => {
    const tr = $('vrow-' + i);
    if (flag && tr && tr.classList.contains('hidden')) return;
    v.selected = flag;
    const cb = tr && tr.querySelector('input[type=checkbox]');
    if (cb) cb.checked = flag;
  });
  $('checkAll').checked = flag;
  updateSelectedCount();
}

function applyDefaults() {
  const defs = {
    shift: $('defShift').value.trim(), training: $('defTraining').value.trim(),
    enclosure: $('defEnclosure').value.trim(), mock: $('defMock').value.trim(),
    cc: $('defCc').value.trim()
  };
  let count = 0;
  state.vendors.forEach(v => {
    if (!v.selected) return;
    count++;
    Object.keys(defs).forEach(k => { if (defs[k]) v[k] = defs[k]; });
  });
  renderVendorTable();
  setStatus($('mappingStatus'), count ? 'ok' : 'warn',
    count ? `Quick Fill applied to ${count} selected vendor(s).` : 'Select at least one vendor first.');
}

const MAP_ALIASES = {
  name: ['vendor name', 'vendor'],
  email: ['vendor email', 'vendor email address', 'email', 'email id', 'email address'],
  shift: ['shift', 'shift amount', 'shift rate', 'single/double shift', 'single shift / double shift', 'shift / double shift'],
  training: ['training', 'training amount', 'training rate'],
  enclosure: ['enclosure', 'enclosure amount', 'enclosure rate'],
  mock: ['mock', 'mock amount', 'mock rate'],
  cc: ['cc', 'cc email', 'cc emails']
};

async function uploadVendorMapping() {
  const input = $('vendorMapFile');
  const status = $('mappingStatus');
  if (!state.vendors.length) { setStatus(status, 'err', 'Please process the Center List first.'); return; }
  if (!input.files.length) { setStatus(status, 'err', 'Please select a vendor file first.'); return; }
  try {
    setStatus(status, 'info', '<i class="fa-solid fa-spinner fa-spin mr-1"></i> Processing file...');
    const aoa = await readFileAsRows(input.files[0]);

    let headerIdx = -1;
    for (let i = 0; i < Math.min(aoa.length, 10); i++) {
      if (aoa[i].some(c => MAP_ALIASES.name.includes(norm(c)))) { headerIdx = i; break; }
    }
    if (headerIdx === -1) throw new Error('"Vendor Name" column not found.');

    const colIdx = {};
    aoa[headerIdx].forEach((h, i) => {
      Object.keys(MAP_ALIASES).forEach(f => {
        if (colIdx[f] === undefined && MAP_ALIASES[f].includes(norm(h))) colIdx[f] = i;
      });
    });

    const byKey = {};
    state.vendors.forEach(v => { byKey[v.key] = v; });
    let matched = 0; const unmatched = [];

    aoa.slice(headerIdx + 1).forEach(r => {
      const name = (r[colIdx.name] || '').trim();
      if (!name) return;
      const v = byKey[norm(name)];
      if (!v) { unmatched.push(name); return; }
      Object.keys(colIdx).forEach(f => {
        if (f === 'name') return;
        const val = (r[colIdx[f]] || '').trim();
        if (val) v[f] = val;
      });
      v.selected = true;
      matched++;
    });

    renderVendorTable();
    setStatus(status, unmatched.length ? 'warn' : 'ok', `Applied details for ${matched} vendor(s).` + (unmatched.length ? ` ${unmatched.length} name(s) did not match.` : ''));
  } catch (err) {
    setStatus(status, 'err', escHtml(err.message || err));
  }
}

function downloadTemplate(format) {
  if (!state.vendors.length) { setStatus($('mappingStatus'), 'err', 'Please process the Center List first.'); return; }
  const header = ['Vendor Name', 'Vendor Email', 'Shift Amount', 'Training', 'Enclosure', 'Mock', 'CC'];
  const rows = state.vendors.map(v => [v.name, v.email, v.shift, v.training, v.enclosure, v.mock, v.cc]);
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Vendors');
  XLSX.writeFile(wb, format === 'csv' ? 'Vendor_Mapping_Template.csv' : 'Vendor_Mapping_Template.xlsx');
}

// =====================================================================
// PAYLOAD & VALIDATION
// =====================================================================
function vendorBasePayload(v) {
  return Object.assign(getCommon(), {
    vendor_name: v.name,
    vendor_mail: (v.email || '').trim(),
    shift: (v.shift || '').trim(),
    training: (v.training || '').trim(),
    enclosure: (v.enclosure || '').trim(),
    mock: (v.mock || '').trim(),
    cc: (v.cc || '').trim()
  });
}

function validateVendor(v, idx) {
  const problems = [];
  const row = $('vrow-' + idx);
  const mark = (field, msg) => {
    problems.push(msg);
    const el = row && row.querySelector(`input[data-field="${field}"]`);
    if (el) el.classList.add('invalid');
  };
  const to = splitEmails(v.email);
  if (!to.length || to.some(e => !EMAIL_RE.test(e))) mark('email', 'valid vendor email');
  if (!(v.shift || '').trim()) mark('shift', 'shift amount');
  if (isBiometric()) { if (!(v.training || '').trim()) mark('training', 'training amount'); }
  else if (!(v.enclosure || '').trim()) mark('enclosure', 'enclosure amount');
  if (!(v.mock || '').trim()) mark('mock', 'mock amount');
  if (splitEmails(v.cc).some(e => !EMAIL_RE.test(e))) mark('cc', 'valid CC email');
  if (!v.centerCount) problems.push('center records');
  return problems;
}

function openMailPreview(idx) {
  const missing = validateCommon();
  if (missing.length) { alert('Please complete the following common fields: ' + missing.join(', ')); return; }

  const v = (typeof idx === 'number') ? state.vendors[idx] : state.vendors.find(x => x.selected);
  if (!v) { alert('Please select at least one vendor to preview.'); return; }

  const payload = vendorBasePayload(v);
  $('modalVendor').innerText = '(' + v.name + ')';
  $('modalSubject').innerText = generateSubject(payload);
  $('modalBody').innerHTML = buildMailHtmlBody(payload);
  $('previewModal').classList.remove('hidden');
}

function closePreviewModal() {
  $('previewModal').classList.add('hidden');
}

// =====================================================================
// POPUPS (seQRview missing / duplicate) - asked every time for each vendor
// =====================================================================
let seqrResolve = null;

// Return: 'yes' | 'no' | 'all'
function askSeqrMissing(vendorName) {
  return new Promise(resolve => {
    seqrResolve = resolve;
    $('seqrModalVendor').innerText = vendorName;
    $('seqrModalReason').innerText = state.seqr
      ? 'No data for this vendor was found in the seQRview file.'
      : 'The seQRview file has not been uploaded.';
    $('seqrModal').classList.remove('hidden');
  });
}

function answerSeqrModal(choice) {
  $('seqrModal').classList.add('hidden');
  if (seqrResolve) { const r = seqrResolve; seqrResolve = null; r(choice); }
}

let dupResolve = null;

// Return: 'yes' | 'no' | 'all'
function askDuplicate(vendorName, info) {
  return new Promise(resolve => {
    dupResolve = resolve;
    $('dupModalVendor').innerText = vendorName;
    $('dupModalInfo').innerText = 'Previously sent: ' + (info && info.time ? info.time : '-') + ' | By: ' + (info && info.sender ? info.sender : '-');
    $('dupModal').classList.remove('hidden');
  });
}

function answerDupModal(choice) {
  $('dupModal').classList.add('hidden');
  if (dupResolve) { const r = dupResolve; dupResolve = null; r(choice); }
}

// =====================================================================
// EXCEL / CSV ATTACHMENT BUILDERS
// =====================================================================
async function buildXlsxBase64_(centerTable, centerHeaderRows, seqrTable, seqrHeaderRows) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'OpsCore - Innovatiview';

  const addSheet = (name, table, headerRowCount, merges) => {
    const rows = padRows_(table);
    const width = rows.length ? rows[0].length : 0;
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: headerRowCount }] });
    const maxLen = new Array(width).fill(8);

    rows.forEach((r, ri) => {
      const row = ws.addRow(r.map(c => String(c == null ? '' : c)));
      for (let ci = 1; ci <= width; ci++) {
        const c = row.getCell(ci);
        c.numFmt = '@';
        c.value = String(r[ci - 1] == null ? '' : r[ci - 1]);
        const len = String(r[ci - 1] == null ? '' : r[ci - 1]).length;
        if (len > maxLen[ci - 1]) maxLen[ci - 1] = len;
        if (ri < headerRowCount) {
          c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A56DB' } };
          c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
          c.alignment = { vertical: 'middle' };
        }
      }
    });
    ws.columns.forEach((col, i) => { col.width = Math.min(Math.max(maxLen[i] + 2, 10), 50); });
    (merges || []).forEach(m => {
      if (m.c2 > m.c1 && m.r < rows.length && m.c2 < width) {
        ws.mergeCells(m.r + 1, m.c1 + 1, m.r + 1, m.c2 + 1);
        ws.getCell(m.r + 1, m.c1 + 1).alignment = { horizontal: 'center', vertical: 'middle' };
      }
    });
  };

  addSheet('Center Details', centerTable, centerHeaderRows, (state.center && state.center.topMerges) || []);
  if (seqrTable.length) addSheet('Seqrview Data', seqrTable, seqrHeaderRows);

  const buffer = await wb.xlsx.writeBuffer();
  return bytesToB64_(new Uint8Array(buffer));
}

// =====================================================================
// GMAIL SEND
// =====================================================================
async function sendGmailWithAttachments(to, cc, subject, bodyHtml, vendorName, centerTable, centerHeaderRows, seqrTable, seqrHeaderRows, format) {
  const boundary = '----OpsCore_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  const fileBase = safeFileName_(vendorName);

  const lines = [];
  lines.push('To: ' + splitEmails(to).join(', '));
  if (splitEmails(cc).length) lines.push('Cc: ' + splitEmails(cc).join(', '));
  if (BCC_AUDIT_EMAIL) lines.push('Bcc: ' + BCC_AUDIT_EMAIL);
  lines.push('Subject: ' + encodeHeader_(subject));
  lines.push('MIME-Version: 1.0');
  lines.push('Content-Type: multipart/mixed; boundary="' + boundary + '"');
  lines.push('');

  lines.push('--' + boundary);
  lines.push('Content-Type: text/html; charset=UTF-8');
  lines.push('Content-Transfer-Encoding: base64');
  lines.push('');
  lines.push(wrap76_(utf8ToB64_(bodyHtml)));

  const addAttachment = (mimeType, fileName, b64) => {
    lines.push('--' + boundary);
    lines.push('Content-Type: ' + mimeType + '; name="' + fileName + '"');
    lines.push('Content-Disposition: attachment; filename="' + fileName + '"');
    lines.push('Content-Transfer-Encoding: base64');
    lines.push('');
    lines.push(wrap76_(b64));
  };

  if (format === 'csv') {
    addAttachment('text/csv', fileBase + '_Center_Details.csv', utf8ToB64_('\uFEFF' + tableToCsv_(padRows_(centerTable))));
    if (seqrTable.length) addAttachment('text/csv', fileBase + '_seQRview_Data.csv', utf8ToB64_('\uFEFF' + tableToCsv_(padRows_(seqrTable))));
  } else {
    const b64 = await buildXlsxBase64_(centerTable, centerHeaderRows, seqrTable, seqrHeaderRows);
    addAttachment('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileBase + '.xlsx', b64);
  }

  lines.push('--' + boundary + '--');
  lines.push('');

  // Standard JSON endpoint (raw = base64url of the full MIME message). Works from the browser without CORS problems.
  const rawMessage = utf8ToB64_(lines.join('\r\n')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  let res;
  try {
    res = await gFetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: rawMessage })
    });
  } catch (netErr) {
    if (netErr && netErr.code === 'AUTH_EXPIRED') throw netErr;
    throw new Error('Network error while calling Gmail API (' + (netErr && netErr.message ? netErr.message : netErr) + '). Check internet / ad-blocker / VPN and the browser console.');
  }

  if (!res.ok) {
    let msg = 'Gmail API Error (' + res.status + ')';
    try { const e = await res.json(); if (e.error && e.error.message) msg = e.error.message; } catch (x) {}
    const err = new Error(msg);
    if (res.status === 429 || (res.status === 403 && /limit|quota|rate/i.test(msg))) {
      err.code = 'LIMIT';
      err.message = 'Gmail sending limit / rate limit reached: ' + msg;
    }
    throw err;
  }
}

// ---------------- Daily counter (local, per user) ----------------
function dailyKey_() { return 'opscore_daily_' + currentUserEmail; }
function getDailyCount() {
  const d = storeGet(dailyKey_());
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' });
  return (d && d.date === today) ? d.count : 0;
}
function addDailyCount(n) {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' });
  storeSet(dailyKey_(), { date: today, count: getDailyCount() + n });
  updateDailyInfo();
}
function updateDailyInfo() {
  const el = $('dailyInfo');
  if (el) el.innerText = `Recipients sent today from this browser: ${getDailyCount()} / ${GMAIL_DAILY_LIMIT}`;
}

// =====================================================================
// DISPATCH QUEUE
// =====================================================================
function setProgress(done, total, text) {
  $('progressWrap').classList.remove('hidden');
  $('progressBar').style.width = (total ? Math.round(done / total * 100) : 0) + '%';
  $('progressText').innerText = text || `${done} of ${total} processed`;
}

function lockUi(locked) {
  state.running = locked;
  $('dispatchBtn').disabled = locked;
  $('backToStep2Btn').disabled = locked;
  $('stopBtn').classList.toggle('hidden', !locked);
  ['centerBtn', 'seqrBtn'].forEach(id => { $(id).disabled = locked; });
}

function stopDispatch() {
  state.cancel = true;
  $('stopBtn').disabled = true;
  setStatus($('dispatchStatus'), 'warn', 'Stopping after current vendor...');
}

function updateSummary() {
  $('sumSent').innerText = state.report.filter(r => r.status === 'sent').length;
  $('sumFailed').innerText = state.report.filter(r => r.status === 'failed').length;
  $('sumSkipped').innerText = state.report.filter(r => r.status === 'skipped').length;
}

function dispatchLogRow_(v, subject, status, details, centerCount, seqrCount, format) {
  const c = getCommon();
  const zm = ZM_DETAILS[c.zm_select] || { name: '' };
  const bio = c.service === 'Biometric';
  return [
    nowIST_(), currentUserEmail, v.name, (v.email || '').trim(), zm.name, (v.shift || '').trim(), (v.cc || '').trim(), subject, status, details,
    c.service, c.exam_name, c.exam_date, c.project_code,
    bio ? (v.training || '').trim() : '', bio ? '' : (v.enclosure || '').trim(), (v.mock || '').trim(), c.reporting_time,
    String(format).toUpperCase(), centerCount, seqrCount, seqrCount ? 'YES' : 'NO',
    c.operator_list_date, c.final_operator_date, c.csr_submit_date
  ];
}

async function markSkipped(i, label, message, centerRows, seqrRows, subject, format) {
  const v = state.vendors[i];
  v.status = 'skipped';
  v.message = message;
  await logAudit('Dispatch Audit', dispatchLogRow_(v, subject, label, message, centerRows, seqrRows, format));
  state.report.push({ vendor: v.name, email: v.email, status: 'skipped', message, time: new Date().toLocaleString() });
  paintStatus(i);
}

async function handleDispatch() {
  if (state.running) return;
  const status = $('dispatchStatus');

  if (!state.center) { setStatus(status, 'err', 'Please upload Center List first.'); return; }
    const staleSrc = staleSources_();
  if (staleSrc.length) {
    setStatus(status, 'err', 'Mail type change hua hai. Step 1 me ' + escHtml(staleSrc.join(' & ')) + ' dobara Fetch karein.');
    return;
  }
  const missing = validateCommon();
  if (missing.length) { setStatus(status, 'err', 'Complete common fields: ' + escHtml(missing.join(', '))); return; }

  const targets = [];
  state.vendors.forEach((v, i) => { if (v.selected && v.status !== 'sent') targets.push(i); });
  if (!targets.length) { setStatus(status, 'err', 'No pending vendors selected.'); return; }

  document.querySelectorAll('.vendor-input.invalid').forEach(el => el.classList.remove('invalid'));
  const issues = [];
  let firstBad = null;
  targets.forEach(i => {
    const p = validateVendor(state.vendors[i], i);
    if (p.length) { issues.push(`${state.vendors[i].name}: ${p.join(', ')}`); if (firstBad === null) firstBad = i; }
  });
  if (issues.length) {
    const row = $('vrow-' + firstBad);
    if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setStatus(status, 'err', `${issues.length} vendor(s) need correction (marked in red).`);
    return;
  }

  // Gmail daily limit awareness
  const recipientsNeeded = targets.reduce((sum, i) => sum + splitEmails(state.vendors[i].email).length + splitEmails(state.vendors[i].cc).length + (BCC_AUDIT_EMAIL ? 1 : 0), 0);
  if (getDailyCount() + recipientsNeeded > GMAIL_DAILY_LIMIT) {
    if (!confirm(`Warning: about ${getDailyCount()} recipients were already used today from this browser and this run needs ${recipientsNeeded} more. The Gmail daily limit (${GMAIL_DAILY_LIMIT}) may be exceeded. Continue anyway?`)) return;
  }

  setStatus(status, 'info', '<i class="fa-solid fa-spinner fa-spin mr-1.5"></i> Checking for duplicates...');
  let sentMap = {};
  try { sentMap = await loadSentFingerprints(); } catch (e) { sentMap = {}; }
  const dupMap = {};
  targets.forEach(i => {
    const hit = sentMap[dupFingerprint_(dupItem(state.vendors[i]))];
    if (hit) dupMap[state.vendors[i].key] = hit;
  });
  status.innerHTML = '';

  const missingSeqrCount = targets.filter(i => !state.vendors[i].seqrCount).length;
  const dupCount = targets.filter(i => dupMap[state.vendors[i].key]).length;
  let confirmText = `Dispatch emails to ${targets.length} vendor(s)?`;
  if (missingSeqrCount) confirmText += `\n\nNote: ${missingSeqrCount} vendor(s) have missing seQRview data - a popup will appear for each.`;
  if (dupCount) confirmText += `\n\nNote: ${dupCount} vendor(s) have already received an identical mail - a popup will appear.`;
  if (!confirm(confirmText)) return;

  state.cancel = false;
  $('stopBtn').disabled = false;
  lockUi(true);
  $('reportWrap').classList.add('hidden');
  const delay = parseInt($('delaySelect').value, 10) || 3000;
  const format = $('attachFormat').value;
  let done = 0, sent = 0, failed = 0, skipped = 0, authExpired = false, limitHit = false;
  setProgress(0, targets.length);
  setStatus(status, 'info', '<i class="fa-solid fa-spinner fa-spin mr-1.5"></i> Dispatching emails...');

  for (const i of targets) {
    if (state.cancel) break;
    const v = state.vendors[i];
    v.status = 'sending'; v.message = ''; paintStatus(i);
    setProgress(done, targets.length, `Processing ${done + 1} of ${targets.length}: ${v.name}`);

    const payload = vendorBasePayload(v);
    const subject = generateSubject(payload);
    const centerRows = state.center.rows.filter(r => norm(r[state.center.vIdx]) === v.key);
    const seqrRows = (state.seqr && state.seqr.vIdx !== -1)
      ? state.seqr.rows.filter(r => norm(r[state.seqr.vIdx]) === v.key)
      : [];

    // 1) Duplicate guard
    if (dupMap[v.key]) {
      const ans = await askDuplicate(v.name, dupMap[v.key]);
      if (ans === 'no') {
        await markSkipped(i, 'SKIPPED (duplicate)', 'Skipped: identical mail was already sent (NO selected)', centerRows.length, seqrRows.length, subject, format);
        skipped++; done++; setProgress(done, targets.length);
        continue;
      }
    }

    // 2) seQRview missing -> popup for every such vendor
    let withoutSeqr = false;
    if (!seqrRows.length) {
      const ans = await askSeqrMissing(v.name);
      if (ans === 'no') {
        await markSkipped(i, 'SKIPPED (seQRview missing)', 'Skipped: seQRview data missing (NO selected)', centerRows.length, 0, subject, format);
        skipped++; done++; setProgress(done, targets.length);
        continue;
      }
      withoutSeqr = true;
    }

    const centerHeaderRows = (state.center.topRows || []).length + 1;
    const seqrHeaderRows = state.seqr ? (state.seqr.topRows || []).length + 1 : 1;
    const centerTable = [...(state.center.topRows || []), state.center.headers, ...centerRows];
    const seqrTable = seqrRows.length ? [...(state.seqr.topRows || []), state.seqr.headers, ...seqrRows] : [];

    try {
      await sendGmailWithAttachments(v.email, v.cc, subject, buildMailHtmlBody(payload), v.name,
        centerTable, centerHeaderRows, seqrTable, seqrHeaderRows, format);
      v.status = 'sent';
      v.message = `Sent to ${v.email} (${centerRows.length} center rows, ${withoutSeqr ? 'WITHOUT seQRview data' : seqrRows.length + ' seQRview rows'})`;
      sent++;
      addDailyCount(splitEmails(v.email).length + splitEmails(v.cc).length + (BCC_AUDIT_EMAIL ? 1 : 0));
      await logAudit('Dispatch Audit', dispatchLogRow_(v, subject, withoutSeqr ? 'SENT (WITHOUT seQRview)' : 'SENT',
        withoutSeqr ? v.message + ' | seQRview data was missing - the sender confirmed YES in the popup' : v.message,
        centerRows.length, seqrRows.length, format));
      await saveVendorMemory(v);
    } catch (err) {
      if (err.code === 'AUTH_EXPIRED') {
        v.status = 'pending'; v.message = '';
        paintStatus(i);
        authExpired = true;
        break;
      }
      v.status = 'failed';
      v.message = 'Error: ' + (err && err.message ? err.message : err);
      failed++;
      await logAudit('Dispatch Audit', dispatchLogRow_(v, subject, 'FAILED', 'Dispatch failed: ' + v.message, centerRows.length, seqrRows.length, format));
      if (err.code === 'LIMIT') limitHit = true;
    }
    state.report.push({ vendor: v.name, email: v.email, status: v.status, message: v.message, time: new Date().toLocaleString() });
    paintStatus(i);
    done++;
    setProgress(done, targets.length);
    if (limitHit) break;
    if (done < targets.length && !state.cancel) await sleep(delay);
  }

  lockUi(false);
  updateSelectedCount();
  updateSummary();
  $('reportWrap').classList.remove('hidden');
  scheduleSave();

  if (authExpired) {
    storeDel(SESSION_KEY);
    setStatus(status, 'err', `Google session expired and could not be renewed. Sent: ${sent}, Failed: ${failed}, Skipped: ${skipped}. Click Terminate Session, sign in again and press Dispatch - vendors already sent are skipped.`);
  } else if (limitHit) {
    setStatus(status, 'err', `Gmail limit reached, queue stopped. Sent: ${sent}, Failed: ${failed}, Skipped: ${skipped}. Try again later.`);
  } else if (state.cancel) {
    setStatus(status, 'warn', `Stopped. Sent: ${sent}, Failed: ${failed}, Skipped: ${skipped}.`);
  } else if (failed || skipped) {
    setStatus(status, 'warn', `Completed. Sent: ${sent}, Failed: ${failed}, Skipped: ${skipped}.`);
  } else {
    setStatus(status, 'ok', `<i class="fa-solid fa-circle-check mr-1"></i> All ${sent} email(s) dispatched successfully.`);
  }
}

function downloadReport() {
  if (!state.report.length) return;
  const esc = s => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
  const lines = [['Vendor', 'Email', 'Status', 'Details', 'Time'].map(esc).join(',')]
    .concat(state.report.map(r => [r.vendor, r.email, r.status, r.message, r.time].map(esc).join(',')));
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'OpsCore_Dispatch_Report_' + new Date().toISOString().slice(0, 10) + '.csv';
  document.body.appendChild(a); a.click(); a.remove();
}

// =====================================================================
// DRAG & DROP
// =====================================================================
function setupDropzones() {
  ['dragover', 'drop'].forEach(ev => window.addEventListener(ev, e => e.preventDefault()));

  document.querySelectorAll('.dropzone').forEach(zone => {
    const input = $(zone.dataset.input);
    const statusEl = $(zone.dataset.status);
    const nameEl = zone.querySelector('.dz-name');
    const showName = () => { nameEl.innerText = input.files.length ? 'Selected: ' + input.files[0].name : ''; };

    ['dragenter', 'dragover'].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.add('dragover'); }));
    ['dragleave', 'drop'].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.remove('dragover'); }));

    zone.addEventListener('drop', e => {
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      if (!['csv', 'xlsx', 'xls'].includes(ext)) {
        setStatus(statusEl, 'err', 'Unsupported file type. Please drop a .csv, .xlsx or .xls file.');
        return;
      }
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      showName();
      setStatus(statusEl, 'info', 'File ready. Click the button below to process it.');
    });

    input.addEventListener('change', showName);
  });
}

// =====================================================================
// FULL EMAIL BODY GENERATOR (Biometric & Frisking)
// =====================================================================
function buildMailHtmlBody(payload) {
  const zmKey = payload.zm_select || "Girish";
  const zmInfo = ZM_DETAILS[zmKey] || ZM_DETAILS["Girish"];
  const service = payload.service || "Biometric";

  const examDateStr = esc_(payload.exam_date || "");
  const reportingTimeStr = esc_(payload.reporting_time || "");
  const opListDate = esc_(formatInputDate_(payload.operator_list_date));
  const finOpDate = esc_(formatInputDate_(payload.final_operator_date));
  const csrDate = esc_(formatInputDate_(payload.csr_submit_date));
  const singleDouble = esc_(payload.shift || "N/A");
  const trainingAmt = esc_(payload.training || "N/A");
  const mockAmt = esc_(payload.mock || "N/A");
  const enclosureAmt = esc_(payload.enclosure || "N/A");
  const policeUrl = esc_(POLICE_PORTAL_URL);

  // Yellow urgent note box (directly below "Dear Concern,")
  const customNotesHtml = (payload.custom_notes_check && payload.custom_notes && payload.custom_notes.trim())
    ? `<div style="background-color:#fff8e1; border:1px solid #ffe082; border-left:6px solid #ffb300; padding:12px 16px; margin:14px 0; border-radius:6px; color:#333; font-size:13px;">
         <div style="color:#d84315; font-weight:bold; font-size:14px; margin-bottom:4px;">&#9888;&#65039; URGENT NOTE / SPECIAL INSTRUCTION:</div>
         <div style="line-height:1.5; color:#212121;">${esc_(payload.custom_notes).replace(/\r?\n/g, "<br>")}</div>
       </div>`
    : "";

  const escalationHtml = `
    <p style="margin:0 0 4px 0;">In case of any issue, please escalate as per the matrix below:</p>
    <ul style="margin:0 0 12px 0; padding-left:20px;">
        <li>Zonal Manager: ${zmInfo.name} - <a href="mailto:${zmInfo.email}">${zmInfo.email}</a> / <a href="tel:+91${zmInfo.phone}">${zmInfo.phone}</a></li>
        <li>Department Head: Vishal Kaushik - <a href="mailto:vishal.kaushik@innovatiview.com">vishal.kaushik@innovatiview.com</a> / <a href="tel:+918384058706">8384058706</a></li>
    </ul>
  `;

  // ======================= FRISKING TEMPLATE =======================
  if (service === "Frisking") {
    return `
      <div class="email-container" style="font-family: Arial, sans-serif; font-size: 14px; color: #000; max-width: 100%; line-height: 1.6;">

    <p>Dear Concern,</p>

    ${customNotesHtml}

    <p>We are happy to engage your services for the upcoming exam on <b>${examDateStr}</b> as per the attached Excel file.</p>

    <table border="1" cellpadding="8" cellspacing="0"
        style="border-collapse:collapse; width:500px; margin-bottom:16px;">
        <tr>
            <td style="width:200px; background:#f0f4ff; color:#1a56db; font-weight:bold;">Exam Date</td>
            <td style="font-weight:bold;">${examDateStr}</td>
        </tr>
        <tr>
            <td style="background:#f0f4ff; color:#1a56db; font-weight:bold;">Reporting Time</td>
            <td>${reportingTimeStr}</td>
        </tr>
        <tr>
            <td style="background:#f0f4ff; color:#1a56db; font-weight:bold;">Mock Day</td>
            <td>As per ops team</td>
        </tr>
    </table>

    <h2 style="font-size:15px; font-weight:bold; margin:18px 0 10px 0; border-bottom:1px solid #ccc; padding-bottom:4px;">KEY POINTS</h2>

    <h3 style="font-size:14px; font-weight:bold; margin:14px 0 6px 0;">1. Guards Details Submission</h3>
    <ul style="margin:0 0 8px 0; padding-left:20px;">
        <li>Submit the complete list of guards, along with Mobile Number &amp; Aadhaar Number for all guards, by <b>${opListDate}</b></li>
        <li>All guards must be ${FRISKING_MIN_AGE} years of age or above</li>
    </ul>

    <p style="font-weight:bold; margin:10px 0 4px 0;">Strict Action:</p>
    <ul style="margin:0 0 8px 0; padding-left:20px;">
        <li>If any guard under ${FRISKING_MIN_AGE} years of age is found, disciplinary action will follow.</li>
        <li>No manpower should be hired from the center (5x penalties will apply).</li>
        <li>No changes in the guards list will be accepted after <b>${finOpDate}</b>. Entry to the center will be denied on exam day if alternate manpower arrives instead, and a 2× penalty will be imposed for each center in violation.</li>
    </ul>

    <p style="font-weight:bold; margin:10px 0 4px 0;">Mandatory:</p>
    <ul style="margin:0 0 8px 0; padding-left:20px;">
        <li>✔ Align only seQRview onboarded manpower (list attached)</li>
        <li>✔ Opsview is mandatory for reporting, and all operational tasks must be performed and updated in Opsview</li>
        <li>✔ Watch the interactive training video - it will be shared by the Ops team in the vendors' group.</li>
    </ul>
    <p style="margin:4px 0 8px 20px;">🔗 <a href="https://link.seqrview.com/" target="_blank">https://link.seqrview.com/</a></p>

    <p style="font-weight:bold; margin:10px 0 4px 0;">Additional Penalties:</p>
    <ul style="margin:0 0 12px 0; padding-left:20px; color:red; font-weight:bold;">
        <li>Underage manpower → Complete center payment deduction</li>
        <li>seQRview not onboarded manpower → Rs 250 deduction for 2 shifts and Rs 150 deduction for a single shift</li>
        <li>Sleeper on duty → Double deduction per guard</li>
        <li>100% center deduction if a fake or edited selfie is shared.</li>
    </ul>

    <hr style="border:none; border-top:1px solid #ccc; margin:16px 0;">

    <h3 style="font-size:14px; font-weight:bold; margin:14px 0 6px 0;">2. Attendance and Timings</h3>
    <ul style="margin:0 0 8px 0; padding-left:20px;">
        <li><b>Attendance is mandatory</b> and must be marked via a <b>selfie</b> with GEO tagging, posted in the designated WhatsApp group.</li>
        <li><b>Adherence to timing</b> is crucial. Any delay or deviation will attract penalties.</li>
        <li>Share <b>two group selfies with geo-tagging:</b>
            <ul style="padding-left:18px; margin-top:4px;">
                <li>On arrival at the center</li>
                <li>After the exam concludes</li>
            </ul>
        </li>
    </ul>
    <p style="margin:4px 0 12px 0;">Please refer to the <b>Deduction Terms</b> and <b>Scope of Work</b> documents for details.</p>

    <hr style="border:none; border-top:1px solid #ccc; margin:16px 0;">

    <h3 style="font-size:14px; font-weight:bold; margin:14px 0 6px 0;">3. Dress Code and Documentation</h3>
    <p style="margin:0 0 8px 0;">All security guards must be properly dressed in the prescribed uniform. This includes formal shoes and the jacket provided by Innovatiview, which must be worn on the exam day.</p>

    <p style="font-weight:bold; margin:10px 0 4px 0;">Mandatory Documents to Carry:</p>
    <ul style="margin:0 0 8px 0; padding-left:20px;">
        <li>Government-issued ID proof</li>
        <li>Authority letter</li>
        <li>Innovatiview ID card</li>
    </ul>

    <p style="color:red; font-weight:bold; margin:8px 0 12px 0;">
        Note: Strict action and penalties will be enforced in case of any dress code violation. Guards are strictly prohibited from wearing slippers, lower wear, or any inappropriate attire while on duty.
    </p>

    <hr style="border:none; border-top:1px solid #ccc; margin:16px 0;">

    <h3 style="font-size:14px; font-weight:bold; margin:14px 0 6px 0;">4. Attendance Malpractice</h3>
    <ul style="margin:0 0 8px 0; padding-left:20px;">
        <li>It has come to our notice that <b>selfies are being shared even when the guard is not present at the center</b>.</li>
        <li>Submission of edited or fake selfies is strictly prohibited and <b>may lead to deduction</b>.</li>
        <li>This is <b>strictly against policy</b> and may lead to <b>penalties</b> or even <b>blacklisting</b> of your vendor profile.</li>
        <li>Guards must <b>not leave the center before 5:30 PM</b>. Any violation will result in penalties.</li>
    </ul>
    <p style="color:red; font-weight:bold; margin:8px 0 12px 0;">
        If any of the above issues are found, the full center payment will be deducted.
    </p>

    <hr style="border:none; border-top:1px solid #ccc; margin:16px 0;">

    <h3 style="font-size:14px; font-weight:bold; margin:14px 0 6px 0;">5. CSR Feedback Form</h3>
    <ul style="margin:0 0 8px 0; padding-left:20px;">
        <li>The Feedback Report, signed by both the Observer and the Center SPOC, must be uploaded to the portal via the application and also shared in the WhatsApp group on the same day, no later than 7 PM on ${examDateStr}, with proper signature and stamp on the feedback report.</li>
        <li>The hard copy of the CSR must be dispatched no later than ${csrDate} EOD, with proper signature and stamp on each CSR.</li>
        <li style="color:red; font-weight:bold;">The second advance will not be initiated unless 95% of the CSRs have been received from the vendor.</li>
    </ul>

    <hr style="border:none; border-top:1px solid #ccc; margin:16px 0;">

    <h3 style="font-size:14px; font-weight:bold; margin:14px 0 6px 0;">6. Material Checklist (To be Verified on Mock Day)</h3>
    <p style="margin:0 0 6px 0;">Materials will be dispatched directly to the respective centers. Security guards are required to verify and confirm the material count on the mock day as per the prescribed format.</p>
    <p style="margin:0 0 6px 0;">The materials are as follows:</p>
    <ul style="margin:0 0 8px 0; padding-left:20px;">
        <li><b>Banners</b> (to be placed at the entry gate)</li>
        <li>Hand Held Metal Detector (HHMD)</li>
        <li><b>Enclosure</b>/partition for female frisking</li>
        <li><b>Extra batteries</b> (for HHMD or other devices)</li>
        <li><b>ID cards</b> (for all staff/guards)</li>
    </ul>

    <p style="margin:8px 0;"><b>After the exam is completed, all materials sent by Innovatiview must be properly repacked. A formal handover–takeover process must be conducted at the center with the Center Head once packing is finished and the materials are submitted.</b></p>

    <p style="font-weight:bold; margin:10px 0 4px 0;">Ensure the following during the sign-off process:</p>
    <ul style="margin:0 0 8px 0; padding-left:20px;">
        <li>The <b>name and contact number</b> must be clearly mentioned on the <b>handover/takeover form</b>, along with the <b>duly signed and official stamp</b> of the Center Head.</li>
        <li>The exact quantity of materials must be recorded, either as per the count shared by the team or based on the actual materials counted during mock activities or final verification.</li>
    </ul>

    <p style="color:red; font-weight:bold; margin:8px 0 4px 0;">Any discrepancy will lead to deductions based on the missing material quantity, including:</p>
    <ul style="margin:0 0 12px 0; padding-left:20px;">
        <li>Handover/takeover form not provided by the vendor</li>
        <li>Incorrect or lesser quantity mentioned</li>
        <li>Any overwriting or cutting on the form</li>
        <li>Submission of fake or invalid forms</li>
    </ul>

    <h3 style="font-size:14px; font-weight:bold; margin:14px 0 6px 0;">VENDOR AGREEMENT</h3>
    <p style="margin:0 0 6px 0;">We have sent you a hard copy of the vendor agreement, along with an e-sign link via email. Kindly either e-sign the document or sign/stamp the hard copy you receive, and share a soft copy with us.</p>
    <p style="font-weight:bold; margin:0 0 12px 0;">Please note that if this is not completed, the work order will be cancelled.</p>

    <hr style="border:none; border-top:1px solid #ccc; margin:16px 0;">

    <h3 style="font-size:14px; font-weight:bold; margin:14px 0 6px 0;">POLICE VERIFICATION</h3>
    <p style="margin:0 0 6px 0;">A police clearance certificate is mandatory for vendors and their city coordinators. Please upload it using the portal link below. The certificate must not be dated more than 6 months before ${examDateStr}.</p>
    <ul style="margin:0 0 8px 0; padding-left:20px;">
        <li><b>For GST firms, a notarized declaration is applicable (draft attached below).</b></li>
        <li><b>For non-GST firms, police verification is mandatory.</b></li>
    </ul>
    <p style="margin:4px 0;">🔗 <b>Link to apply for police verification:</b><br>
    <a href="https://digitalpolice.gov.in" target="_blank">digitalpolice.gov.in</a></p>
    <p style="margin:4px 0 12px 0;">🔗 <b>Portal link to upload:</b><br>
    <a href="${policeUrl}" target="_blank">${policeUrl}</a></p>

    <hr style="border:none; border-top:1px solid #ccc; margin:16px 0;">

    <h3 style="font-size:14px; font-weight:bold; margin:14px 0 6px 0;">7. Deductions &amp; Penalties</h3>
    <table border="1" cellpadding="8" cellspacing="0"
        style="border-collapse:collapse; width:100%; max-width:600px; margin-bottom:14px; font-size:13px;">
        <thead>
            <tr style="background:#f0f0f0; font-weight:bold;">
                <th style="width:40%; text-align:left; padding:8px;">Reason</th>
                <th style="width:15%; text-align:left; padding:8px;">Services</th>
                <th style="width:45%; text-align:left; padding:8px;">Amount</th>
            </tr>
        </thead>
        <tbody>
            <tr>
                <td rowspan="2" style="padding:8px;">Late for Exam Day (per Guard)</td>
                <td style="padding:8px;">Frisking</td>
                <td style="padding:8px;">25% (if reported after 30 mins of reporting time)</td>
            </tr>
            <tr>
                <td style="padding:8px;">Frisking</td>
                <td style="padding:8px;">50% (if reported after 1 hour of reporting time)</td>
            </tr>
            <tr>
                <td style="padding:8px;">Absent for Exam Day</td>
                <td style="padding:8px;">Frisking</td>
                <td style="padding:8px;">200% per guard</td>
            </tr>
            <tr>
                <td colspan="3" style="padding:8px; font-weight:bold;">Device Broken / Not Returned (per device)</td>
            </tr>
            <tr>
                <td style="padding:8px;">Jacket Loss (if provided by Innovatiview)</td>
                <td style="padding:8px;">Common</td>
                <td style="padding:8px;">500 INR</td>
            </tr>
            <tr>
                <td style="padding:8px;">HHMD Loss</td>
                <td style="padding:8px;">Frisking</td>
                <td style="padding:8px;">1000 INR</td>
            </tr>
            <tr>
                <td style="padding:8px;">Frisking Enclosure Loss</td>
                <td style="padding:8px;">Frisking</td>
                <td style="padding:8px;">1500 INR</td>
            </tr>
            <tr>
                <td style="padding:8px;">Banner Loss</td>
                <td style="padding:8px;">Frisking</td>
                <td style="padding:8px;">200 INR</td>
            </tr>
        </tbody>
    </table>

    <hr style="border:none; border-top:1px solid #ccc; margin:16px 0;">

    <h3 style="font-size:14px; font-weight:bold; margin:14px 0 6px 0;">8. Attachments</h3>
    <ol style="margin:0 0 12px 0; padding-left:20px;">
        <li>Frisking SOP</li>
        <li>Feedback Report / CSR (to be shared later)</li>
        <li>Deduction Terms</li>
        <li>Bank Details Format</li>
        <li>Material Handover Format</li>
        <li>Center-wise Details</li>
        <li>Vendor Agreement</li>
        <li>seQRview video</li>
        <li>Interactive video</li>
    </ol>

    <hr style="border:none; border-top:1px solid #ccc; margin:16px 0;">

    <h3 style="font-size:14px; font-weight:bold; margin:14px 0 6px 0;">9. Commercials</h3>
    <table border="1" cellpadding="8" cellspacing="0"
        style="border-collapse:collapse; width:300px; margin-bottom:12px; font-size:13px;">
        <thead>
            <tr style="background:#f0f0f0; font-weight:bold;">
                <th style="text-align:left; padding:8px;">Service</th>
                <th style="text-align:left; padding:8px;">Rate (INR)</th>
            </tr>
        </thead>
        <tbody>
            <tr>
                <td style="padding:8px;">Single Shift / Double Shift</td>
                <td style="padding:8px;">${singleDouble}</td>
            </tr>
            <tr>
                <td style="padding:8px;">Mock (Supervisor Only)</td>
                <td style="padding:8px;">${mockAmt}</td>
            </tr>
            <tr>
                <td style="padding:8px;">Enclosure</td>
                <td style="padding:8px;">${enclosureAmt}</td>
            </tr>
        </tbody>
    </table>
    <p style="margin:0 0 12px 0;"><b>Note:</b> For any additional amount, prior written approval from the Vendor Manager is mandatory. No extra charges will be reimbursed without approval.</p>

    <hr style="border:none; border-top:1px solid #ccc; margin:16px 0;">

    <h3 style="font-size:14px; font-weight:bold; margin:14px 0 6px 0;">10. Payment Terms</h3>
    <p style="margin:0 0 4px 0;">Following the confirmation mail, payment will be processed in 3 stages:</p>
    <ul style="margin:0 0 12px 0; padding-left:20px;">
        <li>40% Advance – 1 day before the exam</li>
        <li>30% Post material pickup and 95% CSR submission (4 to 10 days after the exam)</li>
        <li>30% After receipt of material at the Delhi Warehouse (60 to 75 days after the exam)</li>
    </ul>

    <hr style="border:none; border-top:1px solid #ccc; margin:16px 0;">

    <h3 style="font-size:14px; font-weight:bold; margin:14px 0 6px 0;">11. GST &amp; Invoicing</h3>
    <ul style="margin:0 0 12px 0; padding-left:20px;">
        <li>If GST billing is applicable, mention this in your account details and in your response email.</li>
        <li>Share the hard copy of the bill only after full payment (excluding GST) is received.</li>
        <li>Complete the necessary processes on the GST portal after dispatch.</li>
        <li>GST payment is processed monthly between the 25th and 30th, subject to:
            <ul style="padding-left:18px; margin-top:4px;">
                <li>Receipt of the hard copy at the Noida Office</li>
                <li>Completion reflected on the GST portal</li>
            </ul>
        </li>
    </ul>

    <hr style="border:none; border-top:1px solid #ccc; margin:16px 0;">

    <h3 style="font-size:14px; font-weight:bold; margin:14px 0 6px 0;">12. Escalation Matrix</h3>
    ${escalationHtml}

    <hr style="border:none; border-top:1px solid #ccc; margin:16px 0;">

    <h3 style="font-size:14px; font-weight:bold; margin:14px 0 6px 0;">13. Notes</h3>

    <p><b>Action Required:</b></p>
    <p style="margin:0 0 6px 0;">Please read all enclosed documents carefully and share your acceptance and required details at the earliest. For any clarification, feel free to reach out.</p>
    <p style="margin:0 0 12px 0;">In the absence of a response within two business days of receipt of this email, it shall be treated as an automatic acknowledgment (auto acceptance).</p>

    <p style="color:red; font-weight:bold; border:1px solid red; padding:10px; margin:12px 0;">
        Note:<br><br>
        Please note that the vendor shall be held fully responsible for any malpractice, misconduct, impersonation, or any other unauthorized activity carried out by any employee or operator deployed by them during the examination process. In such cases, strict legal action shall be initiated against both the vendor and the concerned operator/employee, and the vendor may also be blacklisted from future engagements.
    </p>

    <br><br>

    <p>
        Regards,<br>
        Operations Team
    </p>

</div>`;
  }

  // ======================= BIOMETRIC TEMPLATE =======================
  return `
      <div style="font-family: Arial, sans-serif; font-size:13px; line-height:1.6; color:#000;">

      <p>Dear Concern,</p>

      ${customNotesHtml}

      <p>
      We are happy to engage your services for the upcoming exam on
      <b>${examDateStr}</b> as per the attached Excel file.
      </p>

      <table border="1" cellpadding="8" cellspacing="0"
      style="border-collapse:collapse; width:500px;">

      <tr>
      <td><b>Exam Date</b></td>
      <td>${examDateStr}</td>
      </tr>

      <tr>
      <td><b>Reporting Time</b></td>
      <td>${reportingTimeStr}</td>
      </tr>

      <tr>
      <td><b>Mock Day</b></td>
      <td>As per ops team</td>
      </tr>

      </table>

      <br>

      <h3>TRAINING PAYMENT CONDITIONS</h3>

      <p>
      From now onwards, the training amount will be paid only if all the following conditions are fulfilled:
      </p>

      <ul>

      <li>✔ The operator is 100% seQRview onboarded</li>

      <li>✔ The operator has watched the interactive training video</li>

      <li>✔ The same approved manpower is deployed on the exam day as per the shared list</li>

      </ul>

      <p style="color:red; font-weight:bold;">
      ❌ If any of the above conditions are not met, the training amount for that operator will not be paid.
      </p>

      <br>

      <h3>KEY POINTS</h3>

      <h4>1. Operator Details Submission</h4>

      <ul>

      <li>
      Submit the complete list of Operator Name, Mobile Number &amp; Aadhaar Number for all operators by <b>${opListDate}</b>
      </li>

      <li>
      All operators must be ${BIOMETRIC_MIN_AGE} years of age or above
      </li>

      </ul>

      <p><b>Strict Action:</b></p>

      <ul>

      <li>
      If any operator under ${BIOMETRIC_MIN_AGE} years of age is found, the full center payment will be withheld and disciplinary action will follow
      </li>

      <li>
      No manpower should be hired from the center (5x penalties will apply)
      </li>

      <li>
      No changes in the operator list will be accepted after <b>${finOpDate}</b>.
      Entry to the center will be denied on exam day if alternate manpower arrives instead,
      and a 2× penalty will be imposed for each center in violation.
      </li>

      </ul>

      <p><b>Mandatory:</b></p>

      <ul>

      <li>Align only seQRview onboarded manpower (list attached)</li>
      <li>Opsview is mandatory for reporting, and all operational tasks must be performed and updated in Opsview</li>

      <li>Watch the interactive training video - it will be shared by the Ops team in the vendors' group</li>

      </ul>

      <p>
      🔗
      <a href="https://link.seqrview.com/">
      https://link.seqrview.com/
      </a>
      </p>

      <p style="color:red;">

      <b>Additional Penalties:</b><br><br>

      - Underage manpower → Full payment deduction<br>
      - seQRview not onboarded manpower → Rs 250 deduction for 2 shifts and Rs 150 deduction for a single shift<br>
      - Sleeper on duty → Double deduction

      </p>

      <br>

      <h4>2. Attendance and Timings</h4>

      <ul>

      <li>
      Attendance is mandatory and must be marked via a selfie with GEO tagging, posted in the designated WhatsApp group.
      </li>

      <li>
      Adherence to timing is crucial. Any delay or deviation will attract penalties.
      </li>

      <li>
      Share two group selfies with geo-tagging:
      <ul>
      <li>On arrival at the center</li>
      <li>After the exam concludes</li>
      </ul>
      </li>

      <li>
      Please refer to the Deduction Terms and Scope of Work documents for details.
      </li>

      </ul>

      <br>

      <h4>3. Dress Code and Documentation</h4>

      <ul>

      <li>
      The operator must be properly dressed in formal attire, including formal shoes
      </li>

      <li>
      Carry the following:
      <ul>
      <li>Government-issued ID proof</li>
      <li>Authority letter</li>
      <li>ID card</li>
      </ul>
      </li>

      </ul>

      <p>
      <b>Note:</b>
      Strict action and penalties will be applicable in case of dress code violations.
      Operators must not wear slippers, lower wear, or any inappropriate attire.
      </p>

      <br>

      <h4>4. Attendance Malpractice</h4>

      <ul>

      <li>
      It has come to our notice that selfies are being shared even when the operator is not present at the center.
      </li>

      <li>
      Submission of edited or fake selfies is strictly prohibited and may lead to deduction.
      </li>

      <li>
      This is strictly against policy and may lead to penalties or even blacklisting of your vendor profile.
      </li>

      <li>
      Operators must not leave the center before 5:30 PM.
      Any violation will result in penalties.
      </li>

      </ul>

      <p style="color:red;">
      If any of the above issues are found, the full center payment will be deducted.
      </p>

      <br>

      <h4>5. CSR Feedback Form</h4>

      <ul>

      <li>
      The Feedback Report, signed by both the Observer and the Center SPOC,
      must be uploaded to the portal via the application and shared in the WhatsApp group no later than <b>${csrDate}</b>.
      </li>

      <li>
      The hard copy of the CSR must be dispatched no later than the next day EOD, with proper signature and stamp.
      </li>

      <li>
      The second advance will not be initiated unless 95% of the CSRs have been received from the vendor.
      </li>

      <li>
      The Supervisor must confirm entry &amp; biometric points during the mock
      </li>

      <li>
      A demo transaction must be performed
      </li>

      </ul>

      <br>

      <h4>6. Material Checklist</h4>

      <p>Ensure the following items are available:</p>

      <ul>

      <li>Tablet with buffer stock</li>

      <li>FPS device</li>

      <li>OTG cables (Type-C &amp; B-Type)</li>

      <li>One hologram sheet per operator</li>

      </ul>

      <p>
      <b>Note:</b>
      This is an Aadhaar-based exam.
      All devices must have internet connectivity via mobile hotspot.
      A shortfall in working devices will lead to payment deductions.
      </p>

      <br>

      <h4>7. Attachments</h4>

      <ol>

      <li>Biometric SOP</li>

      <li>Feedback Report / CSR (to be shared later)</li>

      <li>Deduction Terms</li>

      <li>Bank Details Format</li>

      <li>Center-wise Details</li>

      <li>Vendor Agreement</li>

      <li>seQRview video</li>

      <li>Interactive video</li>

      </ol>

      <br>

      <h4>8. Commercials</h4>

      <table border="1" cellpadding="8" cellspacing="0"
      style="border-collapse: collapse; width:350px; font-size:13px;">

      <tr>
      <th>Service</th>
      <th>Rate (INR)</th>
      </tr>

      <tr>
      <td>Single Shift / Double Shift</td>
      <td>${singleDouble}</td>
      </tr>

      <tr>
      <td>Training</td>
      <td>${trainingAmt}</td>
      </tr>

      <tr>
      <td>Mock (Supervisor Only)</td>
      <td>${mockAmt}</td>
      </tr>

      </table>

      <br>

      <p>
      <b>Note:</b>
      For any additional amount, prior written approval from the Vendor Manager is mandatory.
      No extra charges will be reimbursed without approval.
      </p>

      <br>

      <h4>9. Payment Terms</h4>

      <p>
      Following the confirmation mail, payment will be processed in 3 stages:
      </p>

      <ul>

      <li>
      40% Advance – 1 day before the exam
      </li>

      <li>
      30% Post material pickup and 95% CSR submission (4 to 10 days after the exam)
      </li>

      <li>
      30% After receipt of material at the Delhi Warehouse (60 to 75 days after the exam)
      </li>

      </ul>

      <br>

      <h4>10. GST &amp; Invoicing</h4>

      <ul>

      <li>
      If GST billing is applicable, mention this in your account details and in your response email.
      </li>

      <li>
      Share the hard copy of the bill only after full payment (excluding GST) is received.
      </li>

      <li>
      Complete the necessary processes on the GST portal after dispatch.
      </li>

      <li>
      GST payment is processed monthly between the 25th and 30th.
      </li>

      </ul>

      <h4>11. Escalation Matrix</h4>

      ${escalationHtml}

      <h4>12. Notes</h4>

      <p><b>Action Required:</b></p>

      <p>
      Please read all enclosed documents carefully and share your acceptance and required details at the earliest.
      For any clarification, feel free to reach out.
      </p>

      <p>
      In the absence of a response within two business days of receipt of this email,
      it shall be treated as an automatic acknowledgment (auto acceptance).
      </p>

      <p style="color:red; font-weight:bold;">

      Note:<br><br>

      Please note that the vendor shall be held fully responsible for any malpractice, misconduct, impersonation, or any other unauthorized activity carried out by any employee or operator deployed by them during the examination process. In such cases, strict legal action shall be initiated against both the vendor and the concerned operator/employee, and the vendor may also be blacklisted from future engagements.

      </p>

      <p>
      Regards,<br>
      Operations Team
      </p>

      </div>
  `;
}

// =====================================================================
// STARTUP
// =====================================================================
onServiceChange();
updateStepper(1);
setupDropzones();
initSourceUi();
window.addEventListener('load', initAuth);