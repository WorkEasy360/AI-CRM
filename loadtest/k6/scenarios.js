/**
 * One exported function per scenario. Each is a k6 `exec` target; stages.js decides how many VUs run
 * which scenario and for how long.
 *
 *   A browse            login -> dashboard -> board -> contacts list -> one company -> one deal
 *   B moveDeal          login -> board -> move a random deal to another open stage -> move it back
 *   C search            login -> 5 searches with realistic prefixes
 *   D dashboardHeavy    dashboard for 7d / 30d / 90d / 365d
 *   E largeTenant       A, large-tenant users only, three pages of contacts
 *   F multiTenant       A, VUs spread evenly across all organisations
 *   G importExportWhileBrowsing   contacts export + contacts import cycle (paired with `browse` in STAGE=g)
 *   H reportWhilePipeline         dashboard 365d + deals export (paired with `moveDeal` in STAGE=h)
 *
 * Throttle budget per user (server): user 600/min, search+dashboard 120/min, imports/exports 30/min.
 * The pacing below keeps one VU well under those; see README "Throttles".
 */
import { group, sleep } from 'k6';
import http from 'k6/http';
import exec from 'k6/execution';

import {
  EXPECT_MOVE,
  apiGet,
  apiPost,
  apiPostMultipart,
  cursorOf,
  ensureLoggedIn,
  ensureRecentAuth,
  reauthenticate,
} from './lib/auth.js';
import {
  SEARCH_PREFIXES,
  ioUser,
  largeTenantUser,
  pick,
  randomInt,
  shortPause,
  thinkTime,
  userForVU,
  userSpreadByOrg,
} from './lib/data.js';
import { conflicts, expectStatus, jobDuration, jobsFailed, safeJson } from './lib/checks.js';

const POLL_INTERVAL_S = Number(__ENV.JOB_POLL_SECONDS || 2);
const POLL_MAX_S = Number(__ENV.JOB_POLL_MAX_SECONDS || 60);
const IMPORT_ROWS = Number(__ENV.IMPORT_ROWS || 25);
/** Minimum wall time of one G / H iteration so the `sensitive` scope (30/min) is never exceeded by one VU. */
const IO_MIN_ITERATION_S = Number(__ENV.IO_MIN_ITERATION_SECONDS || 30);

// ------------------------------------------------------------------------------------------ building blocks

function allBoardDeals(board) {
  const out = [];
  if (!board || !Array.isArray(board.stages)) return out;
  for (const stage of board.stages) {
    if (Array.isArray(stage.deals)) for (const d of stage.deals) out.push(d);
  }
  return out;
}

/**
 * Scenario A body. `pages` > 1 follows the contacts cursor for extra pages (scenario E).
 * The company id comes from the contacts page (contact.company), the deal id from the board; both
 * fall back to their list endpoints when the first page has none.
 */
function browseFlow(user, opts) {
  const pages = (opts && opts.pages) || 1;
  ensureLoggedIn(user);

  let res = apiGet('/dashboard/?period=30d', 'dashboard');
  expectStatus(res, [200], 'dashboard');
  shortPause();

  res = apiGet('/deals/board/', 'board');
  expectStatus(res, [200], 'board');
  const boardDeals = allBoardDeals(safeJson(res));
  shortPause();

  res = apiGet('/contacts/?limit=50', 'contacts_list');
  expectStatus(res, [200], 'contacts_list');
  let contactsPage = safeJson(res);
  for (let i = 1; i < pages; i++) {
    const cursor = cursorOf(contactsPage && contactsPage.next);
    if (!cursor) break;
    shortPause();
    res = apiGet(`/contacts/?limit=50&cursor=${encodeURIComponent(cursor)}`, 'contacts_page');
    expectStatus(res, [200], 'contacts_page');
    contactsPage = safeJson(res);
  }
  shortPause();

  // Pick the company from the companies list, not from a contact's company reference: an own-scope
  // sales rep can see a contact whose company belongs to someone else, and the detail is then a
  // correct 404 (authorization working), which must not be counted as a failure.
  res = apiGet('/companies/?limit=50', 'companies_list');
  expectStatus(res, [200], 'companies_list');
  const companies = safeJson(res);
  const company = companies && Array.isArray(companies.results) ? pick(companies.results) : undefined;
  const companyId = company && company.id;
  if (companyId) {
    res = apiGet(`/companies/${companyId}/`, 'company_detail');
    expectStatus(res, [200], 'company_detail');
    shortPause();
  }

  let deal = pick(boardDeals);
  if (!deal) {
    res = apiGet('/deals/?limit=50', 'deals_list');
    expectStatus(res, [200], 'deals_list');
    const deals = safeJson(res);
    deal = deals && Array.isArray(deals.results) ? pick(deals.results) : undefined;
  }
  if (deal && deal.id) {
    res = apiGet(`/deals/${deal.id}/`, 'deal_detail');
    expectStatus(res, [200], 'deal_detail');
  }
}

function moveStage(dealId, stageId, version) {
  const res = apiPost(`/deals/${dealId}/stage/`, { stage_id: stageId, version }, 'deal_move', {
    responseCallback: EXPECT_MOVE,
  });
  if (res.status === 409) {
    conflicts.add(1);
    return { conflict: true, res };
  }
  return { conflict: false, ok: expectStatus(res, [200], 'deal_move'), res };
}

/** Scenario B body: move a random deal between two *open* stages of its pipeline and back. */
function moveDealFlow(user) {
  ensureLoggedIn(user);
  let res = apiGet('/deals/board/', 'board');
  if (!expectStatus(res, [200], 'board')) return;
  const board = safeJson(res);
  if (!board || !Array.isArray(board.stages)) return;

  // Won/lost stages change the status of the deal (and lost may need a reason); stay within open stages.
  const openStages = board.stages.filter((s) => s.kind === 'open');
  const withDeals = openStages.filter((s) => Array.isArray(s.deals) && s.deals.length > 0);
  if (openStages.length < 2 || withDeals.length === 0) {
    if (__ENV.VERBOSE) console.warn(`moveDeal: pipeline ${board.pipeline && board.pipeline.id} has no movable deals`);
    return;
  }
  const from = pick(withDeals);
  const deal = pick(from.deals);
  const to = pick(openStages.filter((s) => s.id !== from.id));
  shortPause();

  const first = moveStage(deal.id, to.id, deal.version);
  if (first.conflict || !first.ok) return;
  const moved = safeJson(first.res);
  const newVersion = moved && typeof moved.version === 'number' ? moved.version : deal.version + 1;

  sleep(0.5 + Math.random());
  moveStage(deal.id, from.id, newVersion);
}

/** Poll a job until completed / failed or the deadline passes. Returns the final job or null. */
function pollJob(path, name) {
  const deadline = Date.now() + POLL_MAX_S * 1000;
  while (Date.now() < deadline) {
    sleep(POLL_INTERVAL_S);
    const res = apiGet(path, name);
    if (!expectStatus(res, [200], name)) return null;
    const job = safeJson(res);
    if (job && (job.status === 'completed' || job.status === 'failed')) return job;
  }
  return null;
}

/** Create an export, wait for it, download it. `entity` is contacts | companies | products | deals. */
function exportCycle(user, entity) {
  ensureRecentAuth(user);
  const started = Date.now();
  let res = apiPost(`/exports/${entity}/`, { filters: {} }, 'export_create');
  if (res.status === 403) {
    // Recent-auth window elapsed on the server side: re-authenticate once and retry.
    reauthenticate();
    res = apiPost(`/exports/${entity}/`, { filters: {} }, 'export_create');
  }
  if (!expectStatus(res, [202], 'export_create')) return null;
  const job = safeJson(res);
  if (!job || !job.id) return null;

  const done = pollJob(`/exports/${entity}/${job.id}/`, 'export_status');
  const kind = `export_${entity}`;
  if (!done || done.status !== 'completed') {
    jobsFailed.add(1, { kind, reason: done ? 'failed' : 'timeout' });
    return null;
  }
  jobDuration.add(Date.now() - started, { kind });

  // Production answers 302 to object storage; do not follow it (that is not our server under test).
  res = apiGet(`/exports/${entity}/${job.id}/download/`, 'export_download', {
    redirects: 0,
    headers: { Accept: 'text/csv, application/json;q=0.5, */*;q=0.1' },
  });
  expectStatus(res, [200, 302], 'export_download');
  return done;
}

function buildContactsCsv(rows) {
  const vu = exec.vu.idInTest;
  const iter = exec.vu.iterationInScenario;
  const stamp = Date.now().toString(36);
  const lines = ['first_name,last_name,email,phone'];
  for (let i = 0; i < rows; i++) {
    lines.push(`Load${i},Test${vu},lt-${vu}-${iter}-${i}-${stamp}@loadtest.invalid,+1555${String(randomInt(1000000, 9999999))}`);
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** Upload a small contacts CSV, start it with an explicit mapping, wait for completion. */
function importCycle(user) {
  ensureLoggedIn(user);
  const started = Date.now();
  const csv = buildContactsCsv(IMPORT_ROWS);
  let res = apiPostMultipart(
    '/imports/contacts/',
    { file: http.file(csv, `loadtest-${exec.vu.idInTest}-${exec.vu.iterationInScenario}.csv`, 'text/csv') },
    'import_upload',
  );
  if (!expectStatus(res, [201], 'import_upload')) return null;
  const job = safeJson(res);
  if (!job || !job.id) return null;

  res = apiPost(
    `/imports/contacts/${job.id}/start/`,
    {
      mapping: { first_name: 'first_name', last_name: 'last_name', email: 'email', phone: 'phone' },
      options: {},
    },
    'import_start',
  );
  if (!expectStatus(res, [202], 'import_start')) return null;

  const done = pollJob(`/imports/contacts/${job.id}/`, 'import_status');
  if (!done || done.status !== 'completed') {
    jobsFailed.add(1, { kind: 'import_contacts', reason: done ? 'failed' : 'timeout' });
    return null;
  }
  jobDuration.add(Date.now() - started, { kind: 'import_contacts' });
  if (done.error_rows > 0 && __ENV.VERBOSE) {
    console.warn(`import ${done.id}: ${done.error_rows} error rows, first: ${JSON.stringify((done.errors || [])[0])}`);
  }
  return done;
}

/** Sleep so that one iteration lasts at least `minSeconds` (throttle pacing for the sensitive scope). */
function padIteration(startedMs, minSeconds) {
  const elapsed = (Date.now() - startedMs) / 1000;
  if (elapsed < minSeconds) sleep(minSeconds - elapsed);
}

// ------------------------------------------------------------------------------------------ scenarios

export function browse() {
  group('A browse', () => browseFlow(userForVU()));
  thinkTime();
}

export function moveDeal() {
  group('B moveDeal', () => moveDealFlow(userForVU()));
  thinkTime();
}

export function search() {
  group('C search', () => {
    ensureLoggedIn(userForVU());
    for (let i = 0; i < 5; i++) {
      const q = pick(SEARCH_PREFIXES);
      const res = apiGet(`/search/?q=${encodeURIComponent(q)}`, 'search');
      expectStatus(res, [200], 'search');
      if (i < 4) shortPause(); // typing pause; keeps one VU under the 120/min search scope
    }
  });
  thinkTime();
}

export function dashboardHeavy() {
  group('D dashboardHeavy', () => {
    ensureLoggedIn(userForVU());
    const periods = ['7d', '30d', '90d', '365d'];
    for (let i = 0; i < periods.length; i++) {
      const res = apiGet(`/dashboard/?period=${periods[i]}`, 'dashboard');
      expectStatus(res, [200], 'dashboard');
      if (i < periods.length - 1) shortPause();
    }
  });
  thinkTime(2, 4); // dashboard shares the 120/min "search" scope: 4 calls per ~4 s is safe
}

export function largeTenant() {
  group('E largeTenant', () => browseFlow(largeTenantUser(), { pages: 3 }));
  thinkTime();
}

export function multiTenant() {
  group('F multiTenant', () => browseFlow(userSpreadByOrg()));
  thinkTime();
}

/**
 * G: the "small group" half of the stage. One contacts export followed by one contacts import per
 * iteration, padded to IO_MIN_ITERATION_S so a single VU issues at most ~2 cycles/min against the
 * 30/min sensitive scope. stages.js runs `browse` alongside this for the majority of VUs.
 */
export function importExportWhileBrowsing() {
  const started = Date.now();
  group('G importExport', () => {
    const user = ioUser();
    exportCycle(user, 'contacts');
    thinkTime();
    importCycle(user);
  });
  padIteration(started, IO_MIN_ITERATION_S);
}

/**
 * H: "report generation" = dashboard over 365 days plus a deals export (there is no separate report
 * endpoint). stages.js runs `moveDeal` alongside this for the pipeline-heavy VUs.
 */
export function reportWhilePipeline() {
  const started = Date.now();
  group('H report', () => {
    const user = ioUser();
    ensureLoggedIn(user);
    const res = apiGet('/dashboard/?period=365d', 'dashboard');
    expectStatus(res, [200], 'dashboard');
    shortPause();
    exportCycle(user, 'deals');
  });
  padIteration(started, Math.max(20, IO_MIN_ITERATION_S / 1.5));
}
