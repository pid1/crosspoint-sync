import { describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { makeTestApp, md5, registerUser } from './helpers.js';
import type { AppEnv } from '../src/auth/middleware.js';

/**
 * Optional multi-identifier document matching, SPEC.md §5.8 of
 * pid1/kosync-conformance (tracking koreader/koreader-sync-server#55).
 *
 * The three copies are the worked example from that section: `repack` shares
 * structure and filename with `original`, `edition` shares only the filename.
 */
const XP = '/body/DocFragment[20]/body/p[22]';

const C1 = md5('original-content');
const C2 = md5('repack-content');
const C3 = md5('edition-content');
const S1 = md5('original-structure');
const S3 = md5('edition-structure');
const F = md5('shared-filename');

const original = [
  { type: 'content', value: C1 },
  { type: 'structure', value: S1 },
  { type: 'filename', value: F },
];
const repack = [
  { type: 'content', value: C2 },
  { type: 'structure', value: S1 },
  { type: 'filename', value: F },
];
const edition = [
  { type: 'content', value: C3 },
  { type: 'structure', value: S3 },
  { type: 'filename', value: F },
];

/**
 * Two different books a library tagged alike, so the only identifier they share
 * is the weakest one a client offers. The second has never been pushed.
 */
const MISTAGGED = md5('mistagged-filename');
const B1 = md5('one-content');
const B1S = md5('one-structure');
const B2 = md5('two-content');
const B2S = md5('two-structure');

const one = [
  { type: 'content', value: B1 },
  { type: 'structure', value: B1S },
  { type: 'filename', value: MISTAGGED },
];
const two = [
  { type: 'content', value: B2 },
  { type: 'structure', value: B2S },
  { type: 'filename', value: MISTAGGED },
];
const retagged = [
  { type: 'content', value: B2 },
  { type: 'structure', value: B2S },
  { type: 'filename', value: md5('two-filename') },
];

/**
 * The same two mistagged books, but the client says what the shared tag is
 * worth: an identifier that can name a different work, offered to be seeded
 * from and not to claim a record.
 */
const weakOne = [
  { type: 'content', value: B1 },
  { type: 'structure', value: B1S },
  { type: 'filename', value: MISTAGGED, weak: true },
];
const weakTwo = [
  { type: 'content', value: B2 },
  { type: 'structure', value: B2S },
  { type: 'filename', value: MISTAGGED, weak: true },
];

type Ids = { type: string; value: string; weak?: boolean }[];

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
    const weakest = await read(app, headers, F, [
      { type: 'filename', value: F },
      { type: 'structure', value: S1 },
      { type: 'content', value: C1 },
    ]);
    expect(await weakest.json()).toMatchObject({ document: C1, match: 'filename' });

    const strongest = await read(app, headers, C1, original);
    expect(await strongest.json()).toMatchObject({ document: C1, match: 'content' });
  });

  it('separates how the record was found from who wrote the position', async () => {
    const { app, headers } = await seeded();
    // A third edition sharing only the filename digest takes the position over.
    const write = await push(app, headers, C3, edition, '/body/DocFragment[3]/body/p[9]', 0.5);
    expect(await write.json()).toMatchObject({ document: C1, match: 'filename' });

    const res = await read(app, headers, C1, original);
    expect(await res.json()).toMatchObject({
      document: C1,
      match: 'content',
      progress_match: 'filename',
      progress: '/body/DocFragment[3]/body/p[9]',
    });
  });

  it('reports progress_match none when the reader shares nothing with the writer', async () => {
    const { app, headers } = await seeded();
    // The repack takes the position over through the structure digest, leaving
    // a writer the filename-only reader shares nothing with.
    await push(app, headers, C2, [
      { type: 'content', value: C2 },
      { type: 'structure', value: S1 },
    ], '/body/p[4]', 0.4);
    const res = await read(app, headers, F, [{ type: 'filename', value: F }]);
    expect(await res.json()).toMatchObject({ document: C1, match: 'filename', progress_match: 'none' });
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

  it('registers no identifier the caller ranks above the one that matched', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    await push(app, headers, B1, one, XP, 0.8);
    const merged = await push(app, headers, B2, two, '/body/p[1]', 0.01);
    expect(await merged.json()).toMatchObject({ document: B1, match: 'filename' });

    // The match was a guess made on the filename, so the second book's own
    // content and structure digests are not aliases for the first book.
    for (const ids of [
      [{ type: 'content', value: B2 }],
      [{ type: 'structure', value: B2S }],
    ]) {
      const res = await read(app, headers, ids[0].value, ids);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({});
    }
  });

  it('gives a wrongly matched copy its own record back once the tagging is corrected', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    await push(app, headers, B1, one, XP, 0.8);
    await push(app, headers, B2, two, '/body/p[1]', 0.01);

    const corrected = await push(app, headers, B2, retagged, '/body/p[4]', 0.05);
    expect(await corrected.json()).toMatchObject({ document: B2, match: 'content' });
    const res = await read(app, headers, B2, retagged);
    expect(await res.json()).toMatchObject({
      document: B2,
      progress: '/body/p[4]',
      percentage: 0.05,
    });

    // What the rule recovers is the separation, not the position the wrong
    // match overwrote on the first book.
    const first = await read(app, headers, B1, one);
    expect(await first.json()).toMatchObject({ document: B1, progress: '/body/p[1]' });
  });

  it('does not adopt a record its walk reached through a weak identifier', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    await push(app, headers, B1, weakOne, XP, 0.8);
    const second = await push(app, headers, B2, weakTwo, '/body/p[1]', 0.01);

    // Its own digest, and the type of the entry naming it: a push that adopts
    // nothing answers exactly as a create does.
    expect(await second.json()).toMatchObject({ document: B2, match: 'content' });

    const first = await read(app, headers, B1, [{ type: 'content', value: B1 }]);
    expect(await first.json()).toMatchObject({ document: B1, progress: XP, percentage: 0.8 });
    const own = await read(app, headers, B2, [{ type: 'content', value: B2 }]);
    expect(await own.json()).toMatchObject({ document: B2, progress: '/body/p[1]', percentage: 0.01 });
  });

  it('seeds a reader from a weak identifier it did not adopt', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    await push(app, headers, B1, weakOne, XP, 0.8);
    await push(app, headers, B2, weakTwo, '/body/p[1]', 0.01);

    // The tag still resolves, to the book that registered it. A read is where
    // a weak identifier is worth something, and progress_match says so.
    const seeded = await read(app, headers, MISTAGGED, [
      { type: 'filename', value: MISTAGGED },
    ]);
    expect(await seeded.json()).toMatchObject({
      document: B1,
      match: 'filename',
      progress_match: 'filename',
      progress: XP,
    });

    // And the second book's own digests describe the record it created, so a
    // recompressed copy of it still finds it.
    const repacked = await read(app, headers, md5('two-repack'), [
      { type: 'content', value: md5('two-repack') },
      { type: 'structure', value: B2S },
    ]);
    expect(await repacked.json()).toMatchObject({ document: B2, match: 'structure' });
  });

  it('adopts through a strong identifier even when the list carries weak ones', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    await push(app, headers, B1, weakOne, XP, 0.8);

    const repack = md5('one-repack');
    const adopted = await push(
      app,
      headers,
      repack,
      [
        { type: 'content', value: repack },
        { type: 'structure', value: B1S },
        { type: 'filename', value: MISTAGGED, weak: true },
      ],
      '/body/p[6]',
      0.9
    );
    expect(await adopted.json()).toMatchObject({ document: B1, match: 'structure' });

    const res = await read(app, headers, B1, [{ type: 'content', value: B1 }]);
    expect(await res.json()).toMatchObject({ progress: '/body/p[6]', percentage: 0.9 });
  });

  it('rejects a weak that is not a boolean, and has no grammar for one on a read', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    for (const weak of ['yes', 1, null]) {
      const res = await push(
        app,
        headers,
        C1,
        [{ type: 'content', value: C1, weak }] as Ids,
        XP
      );
      expect(res.status, JSON.stringify(weak)).toBe(403);
      expect(await res.json()).toMatchObject({ code: 2003 });
    }

    // false is a valid value and means strong.
    const strong = await push(app, headers, C1, [{ type: 'content', value: C1, weak: false }], XP);
    expect(strong.status).toBe(200);

    const read403 = await read(app, headers, C1, `content:${C1}:true`);
    expect(read403.status).toBe(403);
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

  it('rejects a list that names the document nowhere', async () => {
    const { app, headers } = await seeded();
    const write = await push(app, headers, C1, [{ type: 'structure', value: S1 }], XP);
    expect(write.status).toBe(403);
    expect(await write.json()).toMatchObject({ code: 2003 });
    const res = await read(app, headers, C1, [{ type: 'structure', value: S1 }]);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 2003 });
  });

  it('creates the record under the document wherever the list ranks it', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    // KOReader set to match documents by filename: the digest it is addressed
    // by is the weakest thing it knows, and it ranks the others above it.
    const write = await push(app, headers, F, original, XP);
    expect(write.status).toBe(200);
    expect(await write.json()).toMatchObject({ document: F, match: 'filename' });

    // A client naming no identifiers reaches the record it is addressed by.
    const plain = await read(app, headers, F, null);
    expect((await plain.json()).progress).toBe(XP);

    // The record is the caller's own, so the digests it ranked above the
    // filename are aliases for it and the next read matches on the strongest.
    const matched = await read(app, headers, F, original);
    expect(await matched.json()).toMatchObject({ document: F, match: 'content' });
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
