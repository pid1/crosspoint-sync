import { describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { makeTestApp, md5, registerUser } from './helpers.js';
import type { AppEnv } from '../src/auth/middleware.js';

/**
 * Optional multi-identifier document matching, SPEC.md §5.8 of
 * pid1/kosync-conformance (tracking koreader/koreader-sync-server#55).
 *
 * The three copies are the worked example from that section: `repack` shares
 * structure and metadata with `original`, `edition` shares only metadata.
 */
const XP = '/body/DocFragment[20]/body/p[22]';

const C1 = md5('original-content');
const C2 = md5('repack-content');
const C3 = md5('edition-content');
const S1 = md5('original-structure');
const S3 = md5('edition-structure');
const M = md5('shared-metadata');

const original = [
  { type: 'content', value: C1 },
  { type: 'structure', value: S1 },
  { type: 'metadata', value: M },
];
const repack = [
  { type: 'content', value: C2 },
  { type: 'structure', value: S1 },
  { type: 'metadata', value: M },
];
const edition = [
  { type: 'content', value: C3 },
  { type: 'structure', value: S3 },
  { type: 'metadata', value: M },
];

type Ids = { type: string; value: string }[];

function push(
  app: Hono<AppEnv>,
  headers: Record<string, string>,
  document: string,
  identifiers: Ids | null,
  progress: string,
  percentage = 0.32
) {
  return app.request('/syncs/progress', {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      document,
      ...(identifiers ? { identifiers } : {}),
      progress,
      percentage,
      device: 'kpw',
      device_id: 'kpw',
    }),
  });
}

function read(
  app: Hono<AppEnv>,
  headers: Record<string, string>,
  document: string,
  identifiers: Ids | string | null
) {
  const ids =
    identifiers === null
      ? ''
      : `?ids=${typeof identifiers === 'string' ? identifiers : identifiers.map((i) => `${i.type}:${i.value}`).join(',')}`;
  return app.request(`/syncs/progress/${document}${ids}`, { headers });
}

async function seeded() {
  const { app } = makeTestApp();
  const { headers } = await registerUser(app);
  await push(app, headers, C1, original, XP);
  return { app, headers };
}

describe('multi-identifier document matching', () => {
  it('answers a push that names none with exactly the pre-proposal body', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const res = await push(app, headers, C1, null, XP);
    expect(res.status).toBe(200);
    expect(Object.keys(await res.json()).sort()).toEqual(['document', 'timestamp']);
  });

  it('follows no alias for a read that names none', async () => {
    const { app, headers } = await seeded();
    const direct = await read(app, headers, C1, null);
    const body = await direct.json();
    expect(body.progress).toBe(XP);
    expect(body.match).toBeUndefined();
    expect(body.progress_match).toBeUndefined();

    // S1 is an alias of C1, and an alias exists only for callers who opt in.
    const viaAlias = await read(app, headers, S1, null);
    expect(viaAlias.status).toBe(200);
    expect(await viaAlias.json()).toEqual({});
  });

  it('reports the type that created the record on the first push', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const res = await push(app, headers, C1, original, XP);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['document', 'match', 'timestamp']);
    expect(body.document).toBe(C1);
    expect(body.match).toBe('content');
  });

  it('resolves a repacked copy through the identifier it shares, and echoes the canonical digest', async () => {
    const { app, headers } = await seeded();
    const res = await read(app, headers, C2, repack);
    const body = await res.json();
    expect(body.document).toBe(C1);
    expect(body.match).toBe('structure');
    expect(body.progress).toBe(XP);
    expect(body.progress_match).toBe('structure');
  });

  it('lets the caller order decide which identifier matches', async () => {
    const { app, headers } = await seeded();
    const weakest = await read(app, headers, M, [
      { type: 'metadata', value: M },
      { type: 'structure', value: S1 },
      { type: 'content', value: C1 },
    ]);
    expect(await weakest.json()).toMatchObject({ document: C1, match: 'metadata' });

    const strongest = await read(app, headers, C1, original);
    expect(await strongest.json()).toMatchObject({ document: C1, match: 'content' });
  });

  it('separates how the record was found from who wrote the position', async () => {
    const { app, headers } = await seeded();
    // A third edition sharing only the metadata digest takes the position over.
    const write = await push(app, headers, C3, edition, '/body/DocFragment[3]/body/p[9]', 0.5);
    expect(await write.json()).toMatchObject({ document: C1, match: 'metadata' });

    const res = await read(app, headers, C1, original);
    expect(await res.json()).toMatchObject({
      document: C1,
      match: 'content',
      progress_match: 'metadata',
      progress: '/body/DocFragment[3]/body/p[9]',
    });
  });

  it('reports progress_match none when the reader shares nothing with the writer', async () => {
    const { app, headers } = await seeded();
    // The repack takes the position over through the structure digest, leaving
    // a writer the metadata-only reader shares nothing with.
    await push(app, headers, C2, [
      { type: 'content', value: C2 },
      { type: 'structure', value: S1 },
    ], '/body/p[4]', 0.4);
    const res = await read(app, headers, M, [{ type: 'metadata', value: M }]);
    expect(await res.json()).toMatchObject({ document: C1, match: 'metadata', progress_match: 'none' });
  });

  it('attributes a position written without identifiers to its own digest', async () => {
    const { app, headers } = await seeded();
    await push(app, headers, C1, null, '/body/p[7]', 0.4);
    const res = await read(app, headers, C1, original);
    expect(await res.json()).toMatchObject({
      progress: '/body/p[7]',
      match: 'content',
      progress_match: 'content',
    });
  });

  it('never lets an alias shadow a document that exists in its own right', async () => {
    const { app, headers } = await seeded();
    // C2 becomes a document of its own before it ever offers S1.
    await push(app, headers, C2, [{ type: 'content', value: C2 }], '/body/p[2]', 0.1);
    await push(app, headers, C2, repack, '/body/p[3]', 0.5);

    const own = await read(app, headers, C2, [{ type: 'content', value: C2 }]);
    expect(await own.json()).toMatchObject({ document: C2, progress: '/body/p[3]' });
    const other = await read(app, headers, C1, [{ type: 'content', value: C1 }]);
    expect(await other.json()).toMatchObject({ document: C1, progress: XP });
  });

  it('creates an alias once and never repoints it', async () => {
    const { app, headers } = await seeded();
    // A later copy offering S1 resolves to C1 rather than claiming S1 for itself.
    await push(app, headers, C2, repack, '/body/p[4]', 0.4);
    const res = await read(app, headers, S1, [{ type: 'structure', value: S1 }]);
    expect(await res.json()).toMatchObject({ document: C1 });
  });

  it('carries aliases onto the canonical document when two books are merged', async () => {
    const { app, headers } = await seeded();
    const other = md5('merge-target');
    await push(app, headers, other, null, '/body/p[9]', 0.6);
    const merge = await app.request('/api/v1/documents/merge', {
      method: 'POST',
      headers,
      body: JSON.stringify({ document: C1, into: other }),
    });
    expect(merge.status).toBe(200);

    const res = await read(app, headers, C2, repack);
    expect(await res.json()).toMatchObject({ document: other, match: 'structure' });
  });

  it('returns 200 with an empty body for a book unknown under every identifier', async () => {
    const { app, headers } = await seeded();
    const unknown = md5('never-seen');
    const res = await read(app, headers, unknown, [
      { type: 'content', value: unknown },
      { type: 'structure', value: md5('never-seen-structure') },
    ]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it('keeps one account out of another account aliases', async () => {
    const { app, headers } = await seeded();
    const other = await registerUser(app);
    const res = await read(app, other.headers, C2, repack);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it('rejects a list that does not open with the document', async () => {
    const { app, headers } = await seeded();
    const write = await push(app, headers, C1, [...original].reverse(), XP);
    expect(write.status).toBe(403);
    expect(await write.json()).toMatchObject({ code: 2003 });
    const res = await read(app, headers, C1, [{ type: 'structure', value: S1 }]);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 2003 });
  });

  it('caps a list at eight entries', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const nine: Ids = [{ type: 'content', value: C1 }];
    for (let i = 1; i <= 8; i++) nine.push({ type: `t${i}`, value: md5(`extra-${i}`) });

    expect((await push(app, headers, C1, nine, XP)).status).toBe(403);
    expect((await read(app, headers, C1, nine)).status).toBe(403);
    expect((await push(app, headers, C1, nine.slice(0, 8), XP)).status).toBe(200);
  });

  it('rejects a duplicate type', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const dup: Ids = [
      { type: 'content', value: C1 },
      { type: 'content', value: C2 },
    ];
    expect((await push(app, headers, C1, dup, XP)).status).toBe(403);
    expect((await read(app, headers, C1, dup)).status).toBe(403);
  });

  it('rejects a malformed ids parameter rather than treating it as none named', async () => {
    const { app, headers } = await seeded();
    for (const ids of [C1, '', 'CONTENT:' + C1, `content:${C1},`]) {
      const res = await read(app, headers, C1, ids);
      expect(res.status, ids).toBe(403);
      expect(await res.json()).toMatchObject({ code: 2003 });
    }
  });
});
