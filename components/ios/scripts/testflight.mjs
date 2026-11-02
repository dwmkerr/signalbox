import { sign } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const apiOrigin = 'https://api.appstoreconnect.apple.com';

/** Selects one existing group without creating groups or changing membership. */
export function selectGroup(groups, audience, name = '') {
  if (!['none', 'internal', 'external'].includes(audience)) throw new Error('Invalid tester audience');
  if (audience === 'none') return undefined;
  const matches = groups.filter(group =>
    group.attributes.isInternalGroup === (audience === 'internal') &&
    (!name || group.attributes.name === name));
  if (matches.length !== 1) {
    throw new Error(`Expected one ${audience} group; found ${matches.length}. Set tester_group to an existing name.`);
  }
  return matches[0];
}

function report(message) {
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n\n`);
}

function token() {
  const now = Math.floor(Date.now() / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'ES256', kid: process.env.ASC_KEY_ID, typ: 'JWT' })}.${encode({
    iss: process.env.ASC_ISSUER_ID, iat: now, exp: now + 300, aud: 'appstoreconnect-v1',
  })}`;
  const signature = sign('sha256', Buffer.from(unsigned), {
    key: Buffer.from(process.env.ASC_KEY_P8, 'base64'), dsaEncoding: 'ieee-p1363',
  });
  return `${unsigned}.${signature.toString('base64url')}`;
}

async function request(path, method = 'GET', data) {
  const url = new URL(path, apiOrigin);
  if (url.origin !== apiOrigin) throw new Error('Unexpected App Store Connect pagination origin');
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    ...(data ? { body: JSON.stringify({ data }) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`App Store Connect ${method} ${url.pathname}: ${response.status} ${body}`);
  return body ? JSON.parse(body) : {};
}

async function list(path) {
  const items = [];
  while (path) {
    const response = await request(path);
    items.push(...response.data);
    path = response.links?.next;
  }
  return items;
}

function query(path, params) {
  return `${path}?${new URLSearchParams(params)}`;
}

async function main() {
  for (const name of ['ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_KEY_P8', 'VERSION', 'BUILD']) {
    if (!process.env[name]) throw new Error(`Missing ${name}`);
  }
  const apps = await list(query('/v1/apps', { 'filter[bundleId]': 'com.dwmkerr.signalbox.ios' }));
  if (apps.length !== 1) throw new Error('Expected one Signalbox app');
  const app = apps[0];
  const groups = await list(query('/v1/betaGroups', { 'filter[app]': app.id, limit: 200 }));
  for (const group of groups) {
    report(`Group: ${group.attributes.name} (${group.attributes.isInternalGroup ? 'internal' : 'external'})`);
  }
  const audience = process.env.TESTERS || 'none';
  const group = selectGroup(groups, audience, process.env.TESTER_GROUP);
  const buildPath = query('/v1/builds', {
    'filter[app]': app.id,
    'filter[version]': process.env.BUILD,
    'filter[preReleaseVersion.version]': process.env.VERSION,
  });
  let build;
  for (let attempt = 0; attempt < 30; attempt++) {
    const builds = await list(buildPath);
    if (builds.length > 1) throw new Error('Ambiguous build');
    build = builds[0];
    const state = build?.attributes.processingState;
    console.log(`Build ${process.env.VERSION} (${process.env.BUILD}): ${state || 'not visible yet'}`);
    if (state === 'VALID') break;
    if (['FAILED', 'INVALID'].includes(state)) throw new Error(`Apple processing failed: ${state}`);
    await delay(30_000);
  }
  if (build?.attributes.processingState !== 'VALID') throw new Error('Apple is still processing. Retry this job later.');
  report(`Build ${process.env.VERSION} (${process.env.BUILD}) processed successfully. https://appstoreconnect.apple.com/apps/${app.id}/testflight/ios/${build.id}`);
  if (build.attributes.expired) throw new Error('Build has expired');
  if (group) {
    const notes = readFileSync(new URL('../testflight-notes.txt', import.meta.url), 'utf8').trim();
    const localizations = await list(query('/v1/betaBuildLocalizations', { 'filter[build]': build.id, 'filter[locale]': 'en-US' }));
    if (localizations.length) {
      await request(`/v1/betaBuildLocalizations/${localizations[0].id}`, 'PATCH', {
        type: 'betaBuildLocalizations', id: localizations[0].id, attributes: { whatsNew: notes },
      });
    } else {
      await request('/v1/betaBuildLocalizations', 'POST', {
        type: 'betaBuildLocalizations', attributes: { locale: 'en-US', whatsNew: notes },
        relationships: { build: { data: { type: 'builds', id: build.id } } },
      });
    }
    const groupBuilds = await list(`/v1/betaGroups/${group.id}/relationships/builds?limit=200`);
    if (!groupBuilds.some(item => item.id === build.id)) {
      await request(`/v1/betaGroups/${group.id}/relationships/builds`, 'POST', [{ type: 'builds', id: build.id }]);
    }
    const verified = await list(`/v1/betaGroups/${group.id}/relationships/builds?limit=200`);
    if (!verified.some(item => item.id === build.id)) throw new Error('Build was not assigned to the tester group');
    report(`Assigned to ${group.attributes.name}.`);
  }
  let detail = (await request(`/v1/builds/${build.id}/buildBetaDetail`)).data;
  if (audience === 'external') {
    await request(`/v1/buildBetaDetails/${detail.id}`, 'PATCH', {
      type: 'buildBetaDetails', id: detail.id, attributes: { autoNotifyEnabled: true },
    });
    if (detail.attributes.externalBuildState === 'READY_FOR_BETA_SUBMISSION') {
      const submissions = await list(query('/v1/betaAppReviewSubmissions', { 'filter[build]': build.id }));
      if (!submissions.length) {
        await request('/v1/betaAppReviewSubmissions', 'POST', {
          type: 'betaAppReviewSubmissions', relationships: { build: { data: { type: 'builds', id: build.id } } },
        });
        report('Submitted for Apple beta review. External availability depends on approval.');
      }
    }
    detail = (await request(`/v1/builds/${build.id}/buildBetaDetail`)).data;
    if (group.attributes.publicLinkEnabled) report(`Existing public invite: ${group.attributes.publicLink}`);
  }
  report(`Internal state: ${detail.attributes.internalBuildState}. External state: ${detail.attributes.externalBuildState}.`);
  if (audience !== 'none') {
    const state = audience === 'internal' ? detail.attributes.internalBuildState : detail.attributes.externalBuildState;
    const expected = ['READY_FOR_BETA_TESTING', 'IN_BETA_TESTING', ...(audience === 'external' ? ['WAITING_FOR_BETA_REVIEW', 'IN_BETA_REVIEW', 'BETA_APPROVED'] : [])];
    if (!expected.includes(state)) throw new Error(`TestFlight requires attention: ${state}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
