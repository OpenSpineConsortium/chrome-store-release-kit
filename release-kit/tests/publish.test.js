// store/publish.mjs: the requests to the Chrome Web Store API (V2), the
// words for its answers, and the rule that no credential ever reaches the
// log. Everything runs against a fake fetch; no socket is opened.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const pub = await import(pathToFileURL(path.join(HERE, '..', 'store', 'publish.mjs')).href);
const lib = await import(pathToFileURL(path.join(HERE, '..', 'lib.mjs')).href);

const ITEM = 'abcdefghijklmnopabcdefghijklmnop';
const PUBLISHER = 'a1b2c3d4-publisher';
const NAME = `publishers/${PUBLISHER}/items/${ITEM}`;
const ENV = {
  CWS_PUBLISHER_ID: PUBLISHER,
  CWS_ITEM_ID: ITEM,
  CWS_CLIENT_ID: '1234567890-clientid.apps.googleusercontent.com',
  CWS_CLIENT_SECRET: 'GOCSPX-secret-secret-secret',
  CWS_REFRESH_TOKEN: '1//0refresh-token-refresh-token',
};
const TOKEN = 'ya29.access-token-access-token';
const ZIP = Buffer.from('PK\x03\x04 not really a zip but it starts like one');
// What sha256sum prints for ZIP, so the test does not trust the function under test.
const ZIP_SHA256 = '7cc8f9bb1bdfe888be8ef5abdec5d98ecd18f9f6e404a7372f4efa123a1659d6';
// A real zip whose manifest names a build, for the runs that read it.
const BUILD = '25.0.0.125';
const BUILD_ZIP = lib.zip([['manifest.json', Buffer.from(JSON.stringify({ manifest_version: 3, name: 'x', version: BUILD }))]]);

// A fetch that answers each URL from a script and records what was sent.
function fakeFetch(answers) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const answer = answers.find(a => a.match(url, init));
    if (!answer) throw new Error(`unexpected request ${url}`);
    const body = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body);
    return { status: answer.status || 200, text: async () => body };
  };
  return { fetch, calls };
}

const tokenOk = { match: u => u === pub.TOKEN_URL, body: { access_token: TOKEN, expires_in: 3600, token_type: 'Bearer' } };
const isUpload = (u, i) => i.method === 'POST' && u.endsWith(':upload');
const isPublish = (u, i) => i.method === 'POST' && u.endsWith(':publish');
const isStatus = (u, i) => i.method === 'GET' && u.endsWith(':fetchStatus');
const isCancel = (u, i) => i.method === 'POST' && u.endsWith(':cancelSubmission');

function harness(answers, env = ENV, zipBytes = ZIP) {
  const lines = [];
  const sleeps = [];
  const { fetch, calls } = fakeFetch(answers);
  const log = line => lines.push(String(line));
  const readFile = () => zipBytes;
  const sleep = async ms => { sleeps.push(ms); };
  return { run: argv => pub.run({ argv, env, fetch, log, readFile, sleep }), lines, calls, sleeps };
}

function noSecretLeaks(lines) {
  const joined = lines.join('\n');
  for (const secret of [ENV.CWS_CLIENT_SECRET, ENV.CWS_REFRESH_TOKEN, TOKEN]) assert.ok(!joined.includes(secret), `log carries ${secret}`);
}

test('the requests are the ones the Chrome Web Store API V2 documents', () => {
  const t = pub.tokenRequest(ENV);
  assert.equal(t.url, 'https://oauth2.googleapis.com/token');
  assert.equal(t.init.method, 'POST');
  const form = new URLSearchParams(t.init.body);
  assert.equal(form.get('grant_type'), 'refresh_token');
  assert.equal(form.get('client_id'), ENV.CWS_CLIENT_ID);
  assert.equal(form.get('client_secret'), ENV.CWS_CLIENT_SECRET);
  assert.equal(form.get('refresh_token'), ENV.CWS_REFRESH_TOKEN);

  assert.equal(pub.itemName(ENV), NAME);
  const u = pub.uploadRequest(NAME, TOKEN, ZIP);
  assert.equal(u.url, `https://chromewebstore.googleapis.com/upload/v2/${NAME}:upload`);
  assert.equal(u.init.method, 'POST');
  assert.deepEqual(u.init.headers, { authorization: `Bearer ${TOKEN}` }, 'only the bearer header, as the documented curl sends');
  assert.equal(u.init.body, ZIP);

  const p = pub.publishRequest(NAME, TOKEN);
  assert.equal(p.url, `https://chromewebstore.googleapis.com/v2/${NAME}:publish`);
  assert.equal(p.init.method, 'POST');
  assert.equal(p.init.body, undefined, 'no body: publish on approval with the item\'s own visibility');
  const staged = pub.publishRequest(NAME, TOKEN, { staged: true });
  assert.deepEqual(JSON.parse(staged.init.body), { publishType: 'STAGED_PUBLISH' });
  assert.equal(staged.init.headers['content-type'], 'application/json');

  const s = pub.statusRequest(NAME, TOKEN);
  assert.equal(s.url, `https://chromewebstore.googleapis.com/v2/${NAME}:fetchStatus`);
  assert.equal(s.init.method, 'GET');

  const c = pub.cancelRequest(NAME, TOKEN);
  assert.equal(c.url, `https://chromewebstore.googleapis.com/v2/${NAME}:cancelSubmission`);
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.body, undefined, 'an empty request, as CancelSubmissionRequest has no fields');
  for (const req of [u, p, staged, s, c]) assert.ok(!req.url.includes('v1.1'), 'never the V1 API, which ends on 15 October 2026');
});

test('the store\'s answers become sentences that say what to do', () => {
  const ok = pub.describeUpload({ uploadState: 'SUCCEEDED', crxVersion: '0.2.0' });
  assert.equal(ok.ok, true);
  assert.match(ok.text, /version 0\.2\.0/);
  for (const state of ['IN_PROGRESS', 'UPLOAD_IN_PROGRESS']) {
    const inProgress = pub.describeUpload({ uploadState: state });
    assert.equal(inProgress.ok, true, 'the store took the package');
    assert.equal(inProgress.pending, true);
    assert.match(inProgress.text, /--status/);
  }
  assert.equal(pub.describeUpload({ uploadState: 'NOT_FOUND' }).ok, false);
  assert.match(pub.describeUpload({ uploadState: 'FAILED' }).text, /raise the version in the manifest, or push to the default branch again/);
  assert.match(pub.describeUpload({}).text, /uploadState missing/);

  assert.equal(pub.describePublish({ state: 'PENDING_REVIEW' }).ok, true);
  assert.match(pub.describePublish({ state: 'PENDING_REVIEW' }).text, /submitted for review/);
  assert.match(pub.describePublish({ state: 'PUBLISHED_TO_TESTERS' }).text, /trusted testers/);
  assert.equal(pub.describePublish({ state: 'STAGED' }).ok, true);
  const warned = pub.describePublish({ state: 'PENDING_REVIEW', warningInfo: { warnings: [{ reason: 'X', description: 'Something to look at.' }] } });
  assert.match(warned.text, /Warnings: Something to look at\./);
  const bad = pub.describePublish({ state: 'REJECTED' });
  assert.equal(bad.ok, false);
  assert.match(bad.text, /state REJECTED/);
  assert.equal(pub.describePublish({}).ok, false);

  const status = pub.describeStatus({
    publishedItemRevisionStatus: { state: 'PUBLISHED_TO_TESTERS', distributionChannels: [{ crxVersion: '0.1.0', deployPercentage: 100 }] },
    submittedItemRevisionStatus: { state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: '0.2.0' }] },
    lastAsyncUploadState: 'SUCCEEDED', takenDown: false, warned: true,
  });
  assert.equal(status, 'published PUBLISHED_TO_TESTERS (version 0.1.0), submitted PENDING_REVIEW (version 0.2.0), last upload SUCCEEDED, warned');
  assert.equal(pub.describeStatus({}), 'published none, submitted none, last upload none');
});

test('missing variables: a plain line, exit 1, or exit 0 with --if-configured', async () => {
  const none = harness([], {});
  assert.equal(await none.run(['--upload', '--zip', 'x.zip']), 1);
  assert.match(none.lines[0], /CWS_PUBLISHER_ID, CWS_ITEM_ID, CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN are not set/);
  assert.equal(none.calls.length, 0, 'nothing was sent');
  const soft = harness([], { CWS_ITEM_ID: ITEM });
  assert.equal(await soft.run(['--upload', '--zip', 'x.zip', '--if-configured']), 0);
  assert.match(soft.lines[0], /Nothing was sent/);
  const badId = harness([], { ...ENV, CWS_ITEM_ID: 'nope' });
  assert.equal(await badId.run(['--status']), 1);
  assert.match(badId.lines[0], /32 letters/);
  const badPublisher = harness([], { ...ENV, CWS_PUBLISHER_ID: 'a/b' });
  assert.equal(await badPublisher.run(['--status']), 1);
  assert.match(badPublisher.lines[0], /publisher id/);
});

test('upload then publish: token, upload, publish, and the log keeps no secret', async () => {
  const h = harness([
    tokenOk,
    { match: isUpload, body: { name: NAME, itemId: ITEM, crxVersion: '0.2.0', uploadState: 'SUCCEEDED' } },
    { match: isPublish, body: { name: NAME, itemId: ITEM, state: 'PENDING_REVIEW' } },
  ]);
  assert.equal(await h.run(['--upload', '--zip', 'x.zip', '--publish']), 0);
  assert.deepEqual(h.calls.map(c => c.url.split('/').pop()), ['token', `${ITEM}:upload`, `${ITEM}:publish`]);
  assert.equal(h.calls[1].init.body, ZIP);
  assert.match(h.lines.join('\n'), /accepted the package as the item's new draft \(version 0\.2\.0\)/);
  assert.match(h.lines.join('\n'), /submitted for review/);
  // The log names the bytes it sent, the way the release's .sha256 does.
  assert.match(h.lines.join('\n'), new RegExp(`Uploading x\\.zip \\(${ZIP.length} bytes, SHA-256 ${ZIP_SHA256}\\)`));
  noSecretLeaks(h.lines);
});

test('a refused upload stops before any publish, with the store\'s reason', async () => {
  const refused = { match: isUpload, status: 400, body: { error: { code: 400, message: 'Version number in manifest must be greater than 0.2.0', status: 'INVALID_ARGUMENT' } } };
  const h = harness([tokenOk, refused, { match: isStatus, body: { publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ crxVersion: '0.2.0' }] } } }], ENV, BUILD_ZIP);
  assert.equal(await h.run(['--upload', '--zip', 'x.zip', '--publish']), 1);
  assert.deepEqual(h.calls.map(c => c.url.replace(/^.*[:/]/, '')), ['token', 'upload', 'fetchStatus'], 'the item is read to say why; no withdrawal and no publish');
  assert.match(h.lines.join('\n'), /HTTP 400: Version number in manifest must be greater than 0\.2\.0/);
  assert.match(h.lines.join('\n'), /raise the version in the manifest/);
  noSecretLeaks(h.lines);
  // An item that cannot be read leaves the refusal as the store said it.
  const unread = harness([tokenOk, refused, { match: isStatus, status: 500, body: { error: { message: 'backend error' } } }], ENV, BUILD_ZIP);
  assert.equal(await unread.run(['--upload', '--zip', 'x.zip', '--publish']), 1);
  assert.equal(unread.calls.filter(c => isCancel(c.url, c.init) || isPublish(c.url, c.init)).length, 0);
  assert.match(unread.lines.join('\n'), /HTTP 400: Version number.*raise the version in the manifest/);
});

// The store's refusal while a review is under way, as it said it on 2026-10-25.
const IN_REVIEW = { error: { code: 400, message: 'You may not edit or publish an item that is in review.', status: 'FAILED_PRECONDITION' } };
const reviewOf = version => ({ submittedItemRevisionStatus: { state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: version }] }, publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ crxVersion: '24.1.0.120' }] } });
// An upload refused while the review stands and taken once it is withdrawn.
function uploadAfterWithdrawal(second = { body: { name: NAME, itemId: ITEM, crxVersion: BUILD, uploadState: 'SUCCEEDED' } }) {
  let withdrawn = false;
  const answers = [
    { match: (u, i) => { if (!isCancel(u, i)) return false; withdrawn = true; return true; }, body: {} },
    { match: (u, i) => isUpload(u, i) && !withdrawn, status: 400, body: IN_REVIEW },
    { match: (u, i) => isUpload(u, i) && withdrawn, ...second },
  ];
  return answers;
}

test('an older version in review is withdrawn and this build submitted in its place', async () => {
  const h = harness([tokenOk, ...uploadAfterWithdrawal(), { match: isStatus, body: reviewOf('24.2.0.124') }, { match: isPublish, body: { name: NAME, state: 'PENDING_REVIEW' } }], ENV, BUILD_ZIP);
  assert.equal(await h.run(['--upload', '--zip', 'x.zip', '--publish']), 0);
  assert.deepEqual(h.calls.map(c => c.url.replace(/^.*[:/]/, '')), ['token', 'upload', 'fetchStatus', 'cancelSubmission', 'upload', 'publish']);
  assert.equal(h.calls[4].init.body, BUILD_ZIP, 'the same bytes, sent once more');
  const log = h.lines.join('\n');
  assert.match(log, /HTTP 400: You may not edit or publish an item that is in review\./, 'the store\'s own words');
  assert.match(log, /Version 24\.2\.0\.124 is in review; withdrawing that submission so this build \(25\.0\.0\.125\) is submitted in its place/);
  assert.match(log, /The review of 24\.2\.0\.124 is withdrawn\./);
  assert.match(log, /new draft \(version 25\.0\.0\.125\)/);
  assert.match(log, /submitted for review/);
  noSecretLeaks(h.lines);
});

test('a review is left alone where the run does not submit, the build is not newer, or a version cannot be read', async () => {
  const refusedInReview = { match: isUpload, status: 400, body: IN_REVIEW };
  const neverCancelled = calls => assert.equal(calls.filter(c => isCancel(c.url, c.init)).length, 0, 'no withdrawal');
  // Only an upload: withdrawing would leave nothing in review.
  const only = harness([tokenOk, refusedInReview, { match: isStatus, body: reviewOf('24.2.0.124') }], ENV, BUILD_ZIP);
  assert.equal(await only.run(['--upload', '--zip', 'x.zip']), 1);
  neverCancelled(only.calls);
  assert.match(only.lines.join('\n'), /Version 24\.2\.0\.124 is in review.*This run does not submit.*release again with publish ticked/);
  // The version in review is this one or a later one.
  for (const later of [BUILD, '25.0.0.126', '26.0.0']) {
    const h = harness([tokenOk, refusedInReview, { match: isStatus, body: reviewOf(later) }], ENV, BUILD_ZIP);
    assert.equal(await h.run(['--upload', '--zip', 'x.zip', '--publish']), 1, later);
    neverCancelled(h.calls);
    assert.match(h.lines.join('\n'), /this build \(25\.0\.0\.125\) is not above it, so that review is left alone/);
  }
  // The store names no version for the review.
  const unnamed = harness([tokenOk, refusedInReview, { match: isStatus, body: { submittedItemRevisionStatus: { state: 'PENDING_REVIEW' } } }], ENV, BUILD_ZIP);
  assert.equal(await unnamed.run(['--upload', '--zip', 'x.zip', '--publish']), 1);
  neverCancelled(unnamed.calls);
  assert.match(unnamed.lines.join('\n'), /Version \(not named\) is in review.*cannot be set beside it/);
  // The zip's own version cannot be read.
  const opaque = harness([tokenOk, refusedInReview, { match: isStatus, body: reviewOf('24.2.0.124') }]);
  assert.equal(await opaque.run(['--upload', '--zip', 'x.zip', '--publish']), 1);
  neverCancelled(opaque.calls);
  assert.match(opaque.lines.join('\n'), /this build's version \(unreadable\) cannot be set beside it/);
});

test('after a withdrawal, every stop says nothing is in review now', async () => {
  const review = { match: isStatus, body: reviewOf('24.2.0.124') };
  const said = /The review of 24\.2\.0\.124 was withdrawn, so nothing is in review now/;
  // The store will not withdraw it: the run ends there and uploads nothing more.
  const kept = harness([tokenOk, { match: isUpload, status: 400, body: IN_REVIEW }, review, { match: isCancel, status: 403, body: { error: { message: 'The caller does not have permission' } } }], ENV, BUILD_ZIP);
  assert.equal(await kept.run(['--upload', '--zip', 'x.zip', '--publish']), 1);
  assert.deepEqual(kept.calls.map(c => c.url.replace(/^.*[:/]/, '')), ['token', 'upload', 'fetchStatus', 'cancelSubmission']);
  assert.match(kept.lines.join('\n'), /did not withdraw the review of 24\.2\.0\.124 \(HTTP 403: The caller does not have permission\)/);
  assert.doesNotMatch(kept.lines.join('\n'), said);
  // The upload is refused again once the review is withdrawn.
  const again = harness([tokenOk, ...uploadAfterWithdrawal({ status: 400, body: { error: { message: 'Package is invalid' } } }), review], ENV, BUILD_ZIP);
  assert.equal(await again.run(['--upload', '--zip', 'x.zip', '--publish']), 1);
  assert.equal(again.calls.filter(c => isUpload(c.url, c.init)).length, 2, 'once more, not a loop');
  assert.equal(again.calls.filter(c => isPublish(c.url, c.init)).length, 0);
  assert.match(again.lines.join('\n'), /HTTP 400: Package is invalid/);
  assert.match(again.lines.join('\n'), said);
  // The submission is refused, as it is while a permission's reason is unanswered.
  const unsent = harness([tokenOk, ...uploadAfterWithdrawal(), review, { match: isPublish, status: 400, body: { error: { message: 'Item has missing fields' } } }], ENV, BUILD_ZIP);
  assert.equal(await unsent.run(['--upload', '--zip', 'x.zip', '--publish']), 1);
  assert.match(unsent.lines.join('\n'), /refused the submission \(HTTP 400: Item has missing fields\)/);
  assert.match(unsent.lines.join('\n'), said);
  noSecretLeaks([...kept.lines, ...again.lines, ...unsent.lines]);
});

test('versions: the one in review, the zip\'s own, and their order', () => {
  assert.equal(pub.versionInReview(reviewOf('24.2.0.124')), '24.2.0.124');
  assert.equal(pub.versionInReview({ submittedItemRevisionStatus: { state: 'PENDING_REVIEW', distributionChannels: [{}, { crxVersion: '1.2' }] } }), '1.2');
  assert.equal(pub.versionInReview({ submittedItemRevisionStatus: { state: 'PENDING_REVIEW' } }), '');
  for (const state of ['STAGED', 'CANCELLED', 'REJECTED', 'PUBLISHED']) assert.equal(pub.versionInReview({ submittedItemRevisionStatus: { state, distributionChannels: [{ crxVersion: '1.0' }] } }), null, state);
  assert.equal(pub.versionInReview({}), null);
  assert.equal(pub.versionInReview(null), null);
  assert.equal(pub.zipVersion(BUILD_ZIP), BUILD);
  assert.equal(pub.zipVersion(ZIP), '', 'not a zip it can read');
  assert.equal(pub.zipVersion(lib.zip([['manifest.json', Buffer.from('{"version":"1.02"}')]])), '', 'not a version Chrome takes');
  assert.equal(pub.zipVersion(lib.zip([['other.json', Buffer.from('{}')]])), '', 'no manifest');
  assert.ok(pub.compareVersions('25.0.0.125', '24.2.0.124') > 0);
  assert.ok(pub.compareVersions('25.0.0.125', '25.0.0.126') < 0);
  assert.ok(pub.compareVersions('1.10', '1.9') > 0, 'by number, not by text');
  assert.equal(pub.compareVersions('1.0', '1.0.0.0'), 0, 'a missing part counts as 0');
});

test('a package the store is still processing: done as an upload, waited for within bounds before a publish', async () => {
  const taken = { match: isUpload, body: { name: NAME, uploadState: 'IN_PROGRESS' } };
  const only = harness([tokenOk, taken]);
  assert.equal(await only.run(['--upload', '--zip', 'x.zip']), 0, 'the upload itself succeeded');
  assert.equal(only.calls.length, 2, 'nothing is polled when no publish follows');
  assert.deepEqual(only.sleeps, []);
  assert.match(only.lines.join('\n'), /--status says when it is the draft/);
  // The draft arrives on the third look; the publish follows.
  let looks = 0;
  const status = { match: (u, i) => { if (!isStatus(u, i)) return false; looks += 1; status.body = { lastAsyncUploadState: looks < 3 ? 'IN_PROGRESS' : 'SUCCEEDED' }; return true; }, body: null };
  const h = harness([tokenOk, taken, status, { match: isPublish, body: { name: NAME, state: 'PENDING_REVIEW' } }]);
  assert.equal(await h.run(['--upload', '--zip', 'x.zip', '--publish']), 0);
  assert.deepEqual(h.calls.map(c => c.url.split('/').pop().replace(/^.*:/, '')), ['token', 'upload', 'fetchStatus', 'fetchStatus', 'fetchStatus', 'publish']);
  assert.deepEqual(h.sleeps, [pub.UPLOAD_WAITS.ms, pub.UPLOAD_WAITS.ms, pub.UPLOAD_WAITS.ms], 'each look waits the fixed time first');
  assert.match(h.lines.join('\n'), /Waiting 30 s for the store to finish \(1 of 10\)/);
  assert.match(h.lines.join('\n'), /submitted for review/);
  // Never settles: the waits run out, nothing is submitted, the way on is said.
  const stuck = harness([tokenOk, taken, { match: isStatus, body: { lastAsyncUploadState: 'IN_PROGRESS' } }]);
  assert.equal(await stuck.run(['--upload', '--zip', 'x.zip', '--publish']), 1);
  assert.equal(stuck.sleeps.length, pub.UPLOAD_WAITS.tries, 'a bounded wait, not a loop');
  assert.equal(stuck.calls.filter(c => c.url.endsWith(':publish')).length, 0);
  assert.match(stuck.lines.join('\n'), /still processing the package after 5 minutes.*Run workflow/);
  // The store reports the upload failed while waiting.
  const failed = harness([tokenOk, taken, { match: isStatus, body: { lastAsyncUploadState: 'FAILED' } }]);
  assert.equal(await failed.run(['--upload', '--zip', 'x.zip', '--publish']), 1);
  assert.equal(failed.sleeps.length, 1);
  assert.match(failed.lines.join('\n'), /last upload FAILED/);
});

test('a token the store refuses is reported without echoing anything', async () => {
  const h = harness([{ match: u => u === pub.TOKEN_URL, status: 400, body: { error: 'invalid_grant', error_description: `Bad token ${ENV.CWS_REFRESH_TOKEN}` } }]);
  assert.equal(await h.run(['--status']), 1);
  assert.match(h.lines.join('\n'), /Could not get an access token \(HTTP 400: invalid_grant\)/);
  assert.match(h.lines.join('\n'), /release-kit\/README\.md/);
  noSecretLeaks(h.lines);
  // An error body that echoes a secret is redacted even when the message is used.
  const echo = harness([tokenOk, { match: isStatus, status: 403, body: { error: { message: `forbidden for ${ENV.CWS_CLIENT_SECRET}`, details: [{ fieldViolations: [{ description: `and ${ENV.CWS_REFRESH_TOKEN}` }] }] } } }]);
  assert.equal(await echo.run(['--status']), 1);
  assert.match(echo.lines.join('\n'), /forbidden for <CWS_CLIENT_SECRET> \(and <CWS_REFRESH_TOKEN>\)/);
  noSecretLeaks(echo.lines);
  // The access token is not a repository secret, so Actions would not mask
  // it; an answer that echoes the bearer is redacted here.
  const bearer = harness([tokenOk, { match: isStatus, status: 401, body: { error: { message: `Invalid Credentials: Bearer ${TOKEN}` } } }]);
  assert.equal(await bearer.run(['--status']), 1);
  assert.match(bearer.lines.join('\n'), /Invalid Credentials: Bearer <token>/);
  noSecretLeaks(bearer.lines);
  // A secret typed where an argument goes is not echoed by the usage error either.
  const stray = harness([]);
  assert.equal(await stray.run(['--status', ENV.CWS_CLIENT_SECRET]), 2);
  assert.match(stray.lines[0], /unknown argument <CWS_CLIENT_SECRET>/);
  noSecretLeaks(stray.lines);
});

test('--dry-run names the requests and sends nothing; --status reads the item', async () => {
  const dry = harness([]);
  assert.equal(await dry.run(['--upload', '--zip', 'x.zip', '--publish', '--staged', '--dry-run']), 0);
  assert.equal(dry.calls.length, 0);
  assert.match(dry.lines.join('\n'), new RegExp(`POST https://chromewebstore\\.googleapis\\.com/upload/v2/${NAME}:upload`));
  assert.match(dry.lines.join('\n'), /:publish \(STAGED_PUBLISH\)/);
  assert.match(dry.lines.join('\n'), new RegExp(`SHA-256 ${ZIP_SHA256}\\)`));
  assert.match(dry.lines.join('\n'), /:cancelSubmission and the upload again, only if an older version than this build is in review/);
  const dryBuild = harness([], ENV, BUILD_ZIP);
  assert.equal(await dryBuild.run(['--upload', '--zip', 'x.zip', '--publish', '--dry-run']), 0);
  assert.match(dryBuild.lines.join('\n'), /only if an older version than 25\.0\.0\.125 is in review/);
  const dryUpload = harness([]);
  assert.equal(await dryUpload.run(['--upload', '--zip', 'x.zip', '--dry-run']), 0);
  assert.doesNotMatch(dryUpload.lines.join('\n'), /cancelSubmission/, 'a run that only uploads never withdraws');
  const st = harness([tokenOk, { match: isStatus, body: { publishedItemRevisionStatus: { state: 'PUBLISHED' }, lastAsyncUploadState: 'SUCCEEDED' } }]);
  assert.equal(await st.run(['--status']), 0);
  assert.match(st.lines.join('\n'), /published PUBLISHED, submitted none, last upload SUCCEEDED/);
});

test('arguments: no verb, an unknown flag, a lone --staged and --upload without --zip are refused with the usage', async () => {
  for (const argv of [[], ['--bogus'], ['--staged'], ['--upload']]) {
    const h = harness([]);
    assert.equal(await h.run(argv), 2, argv.join(' '));
    assert.match(h.lines.join('\n'), /usage:/);
  }
  const help = harness([]);
  assert.equal(await help.run(['--help']), 0);
  const unreadable = harness([]);
  const readFails = pub.run({ argv: ['--upload', '--zip', 'gone.zip'], env: ENV, fetch: async () => { throw new Error('no'); }, log: l => unreadable.lines.push(l), readFile: () => { throw new Error('ENOENT'); }, sleep: async () => {} });
  assert.equal(await readFails, 1);
  assert.match(unreadable.lines.join('\n'), /Cannot read gone\.zip/);
});

test('a value pasted with a newline at its end is the value', () => {
  const padded = Object.fromEntries(Object.entries(ENV).map(([k, v]) => [k, `${v}\n`]));
  const form = new URLSearchParams(pub.tokenRequest(padded).init.body);
  assert.equal(form.get('client_id'), ENV.CWS_CLIENT_ID);
  assert.equal(form.get('client_secret'), ENV.CWS_CLIENT_SECRET);
  assert.equal(form.get('refresh_token'), ENV.CWS_REFRESH_TOKEN);
  assert.equal(pub.itemName(padded), NAME);
  assert.deepEqual(pub.missing(padded), []);
});

test('a secret pasted with a newline at its end is hidden in the form the store echoes', async () => {
  const padded = Object.fromEntries(Object.entries(ENV).map(([k, v]) => [k, `${v}\n`]));
  const h = harness([{ match: u => u === pub.TOKEN_URL, status: 400, body: { error: 'invalid_grant', error_description: `Bad token ${ENV.CWS_REFRESH_TOKEN}` } }], padded);
  assert.equal(await h.run(['--status']), 1);
  noSecretLeaks(h.lines);
  assert.equal(pub.redact(`x ${ENV.CWS_CLIENT_SECRET} y ${ENV.CWS_CLIENT_SECRET}\n z`, padded), 'x <CWS_CLIENT_SECRET> y <CWS_CLIENT_SECRET> z', 'both the pasted and the trimmed form');
  assert.equal(pub.redact(`bearer ${TOKEN}`, padded, [`${TOKEN}\n`]), 'bearer <token>');
});
