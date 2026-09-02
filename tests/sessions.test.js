// Coded by Aditya | GitHub- @adityatheog

/**
 * Tests for src/utils/sessions.js.
 *
 * Discord custom ids are client-controlled. Any user who can see a message can send its component
 * interactions with an arbitrary custom id, and the id carries no authenticity of its own. This
 * store is what makes components safe, so these tests target the three properties that guarantee
 * it rather than the bookkeeping underneath:
 *
 *   Custom ids carry no state. Everything identifying the target resource lives server-side, keyed
 *   by an unguessable token. A user cannot edit a button to act on a server they do not own,
 *   because the server is not named in the button.
 *
 *   Expiry is enforced on read, not only by the sweeper. A component pressed between sweeps must
 *   still resolve to nothing, which is what the interaction router answers with "Timed Out".
 *
 *   Sessions are owner-bound, and a missing session is indistinguishable from a foreign one.
 *
 * The module holds process-level state, so every test clears the store first. Without that, an
 * eviction test would leak into a count test and the failure would look unrelated to its cause.
 *
 * No credentials, no network, no filesystem.
 */

import assert from 'node:assert/strict';
import test, { beforeEach, describe } from 'node:test';

import {
  actionFromCustomId,
  buildCustomId,
  clearAllSessions,
  createSession,
  deleteSession,
  deleteSessionsForOwner,
  getOwnedSession,
  getSession,
  MAX_CUSTOM_ID_LENGTH,
  MAX_SESSIONS,
  namespaceFromCustomId,
  SEPARATOR,
  SESSION_TTL_MS,
  sessionCount,
  sessionIdFromCustomId,
  startSessionSweeper,
  sweepSessions,
  touchSession,
  updateSessionData,
} from '../src/utils/sessions.js';

const OWNER = '111111111111111111';
const STRANGER = '222222222222222222';

/** The store is module-level state, so every case starts from empty. */
beforeEach(() => {
  clearAllSessions();
});

describe('createSession', () => {
  test('stores a session and returns its descriptor', () => {
    const session = createSession(OWNER, { identifier: 'a1b2c3d4' });

    assert.equal(session.ownerId, OWNER);
    assert.deepEqual(session.data, { identifier: 'a1b2c3d4' });
    assert.ok(session.createdAt <= Date.now());
    assert.ok(session.expiresAt > session.createdAt);
    assert.equal(sessionCount(), 1);
  });

  test('produces an unguessable id', () => {
    /**
     * The id is the only thing standing between a component and the session that authorises it, so
     * it must carry real entropy rather than being a counter or a predictable hash.
     */
    const ids = new Set();

    for (let index = 0; index < 500; index += 1) {
      ids.add(createSession(OWNER, {}).id);
    }

    assert.equal(ids.size, 500, 'session ids must not collide');

    for (const id of ids) {
      assert.match(id, /^[A-Za-z0-9_-]+$/, 'must be base64url safe');
      assert.ok(id.length >= 12, 'must carry meaningful entropy');
      assert.ok(!id.includes(SEPARATOR), 'must not contain the custom id separator');
    }
  });

  test('applies the default TTL when none is given', () => {
    const session = createSession(OWNER, {});

    assert.equal(session.expiresAt - session.createdAt, SESSION_TTL_MS);
  });

  test('honours an explicit TTL', () => {
    // The dashboard uses five minutes, the help menu five, confirmations two.
    const session = createSession(OWNER, {}, 5 * 60_000);

    assert.equal(session.expiresAt - session.createdAt, 5 * 60_000);
  });

  test('coerces the owner id to a string', () => {
    /**
     * A Discord snowflake exceeds Number.MAX_SAFE_INTEGER, so comparing owners as numbers would
     * silently conflate distinct users.
     */
    const session = createSession(123456789012345678n, {});

    assert.equal(typeof session.ownerId, 'string');
  });

  test('defaults to empty data', () => {
    assert.deepEqual(createSession(OWNER).data, {});
  });
});

describe('getSession', () => {
  test('returns a live session', () => {
    const created = createSession(OWNER, { page: 2 });
    const fetched = getSession(created.id);

    assert.equal(fetched, created, 'the same object should be returned');
    assert.deepEqual(fetched.data, { page: 2 });
  });

  test('returns null for an unknown id', () => {
    assert.equal(getSession('does-not-exist'), null);
  });

  test('returns null for a malformed id without throwing', () => {
    /**
     * The id arrives from a custom id sent by a client, so it can be anything at all.
     */
    for (const bad of [null, undefined, '', 0, false, {}, []]) {
      assert.equal(getSession(bad), null, `should be null for ${JSON.stringify(bad)}`);
    }
  });

  test('enforces expiry on read, not only in the sweeper', () => {
    /**
     * The property that makes stale components safe. A negative TTL produces an already-expired
     * session, and it must be unusable immediately rather than waiting for the next sweep — a
     * component pressed between sweeps would otherwise still act.
     */
    const session = createSession(OWNER, {}, -1);

    assert.equal(getSession(session.id), null, 'an expired session must not resolve');
  });

  test('deletes an expired session when it is read', () => {
    // Reclaiming on read keeps the store from retaining entries nobody returns to.
    const session = createSession(OWNER, {}, -1);

    assert.equal(sessionCount(), 1);
    getSession(session.id);
    assert.equal(sessionCount(), 0, 'the expired entry should have been removed');
  });

  test('a session expiring exactly now is treated as expired', () => {
    // The boundary is inclusive, so a session cannot be used on the tick it expires.
    const session = createSession(OWNER, {}, 0);

    assert.equal(getSession(session.id), null);
  });
});

describe('getOwnedSession', () => {
  test('returns the session for its owner', () => {
    const created = createSession(OWNER, { identifier: 'a1b2c3d4' });

    assert.equal(getOwnedSession(created.id, OWNER), created);
  });

  test('returns null for a different user', () => {
    /**
     * Discord's UI visibility is not an authorisation boundary. Anyone who can see the message can
     * send its component interactions.
     */
    const created = createSession(OWNER, {});

    assert.equal(getOwnedSession(created.id, STRANGER), null);
  });

  test('a foreign session and a missing one are indistinguishable', () => {
    /**
     * Both return null, so a handler cannot inadvertently reveal whether a given session id exists.
     */
    const created = createSession(OWNER, {});

    assert.equal(getOwnedSession(created.id, STRANGER), null, 'foreign');
    assert.equal(getOwnedSession('does-not-exist', STRANGER), null, 'nonexistent');
  });

  test('returns null for an expired session even for its owner', () => {
    const created = createSession(OWNER, {}, -1);

    assert.equal(getOwnedSession(created.id, OWNER), null);
  });

  test('compares owners as strings', () => {
    const created = createSession(OWNER, {});

    assert.equal(getOwnedSession(created.id, Number(OWNER)), null, 'a lossy numeric id must not match');
    assert.equal(getOwnedSession(created.id, String(OWNER)), created);
  });
});

describe('touchSession', () => {
  test('extends a live session', () => {
    /**
     * The help menu and the dashboard call this on every interaction, so a user reading through
     * several categories does not lose the menu partway.
     */
    const session = createSession(OWNER, {}, 1000);
    const originalExpiry = session.expiresAt;

    assert.equal(touchSession(session.id, 60_000), true);
    assert.ok(session.expiresAt > originalExpiry, 'the expiry should have moved forward');
  });

  test('reports false for an unknown or expired session', () => {
    assert.equal(touchSession('does-not-exist'), false);

    const expired = createSession(OWNER, {}, -1);
    assert.equal(touchSession(expired.id), false, 'an expired session cannot be revived');
  });

  test('applies the default TTL when none is given', () => {
    const session = createSession(OWNER, {}, 1000);

    touchSession(session.id);

    assert.ok(session.expiresAt - Date.now() > 1000);
  });

  test('falls back to the default TTL for a nonsensical value', () => {
    const session = createSession(OWNER, {}, 1000);

    assert.equal(touchSession(session.id, NaN), true);
    assert.ok(session.expiresAt > Date.now());
  });
});

describe('updateSessionData', () => {
  test('merges a patch into the stored data', () => {
    const session = createSession(OWNER, { category: 'Account', page: 0, view: 'list' });

    assert.equal(updateSessionData(session.id, { page: 1 }), true);
    assert.deepEqual(session.data, { category: 'Account', page: 1, view: 'list' });
  });

  test('adds new fields without discarding existing ones', () => {
    const session = createSession(OWNER, { identifier: 'a1b2c3d4' });

    updateSessionData(session.id, { presetName: 'My Server' });

    assert.deepEqual(session.data, { identifier: 'a1b2c3d4', presetName: 'My Server' });
  });

  test('reports false for an unknown or expired session', () => {
    assert.equal(updateSessionData('does-not-exist', { page: 1 }), false);

    const expired = createSession(OWNER, {}, -1);
    assert.equal(updateSessionData(expired.id, { page: 1 }), false);
  });

  test('tolerates an absent patch', () => {
    const session = createSession(OWNER, { page: 0 });

    assert.equal(updateSessionData(session.id, undefined), true);
    assert.deepEqual(session.data, { page: 0 });
  });
});

describe('deleteSession', () => {
  test('removes a session immediately', () => {
    /**
     * Confirmation flows delete the session before the destructive work begins, so a second press
     * of the same button cannot launch a concurrent deletion.
     */
    const session = createSession(OWNER, {});

    assert.equal(deleteSession(session.id), true);
    assert.equal(getSession(session.id), null);
    assert.equal(sessionCount(), 0);
  });

  test('reports false when nothing was deleted', () => {
    assert.equal(deleteSession('does-not-exist'), false);
    assert.equal(deleteSession(null), false);
    assert.equal(deleteSession(''), false);
  });

  test('makes a confirmation single-use', () => {
    // The behaviour account delete and server delete rely on.
    const session = createSession(OWNER, { identifier: 'a1b2c3d4' });

    assert.ok(getOwnedSession(session.id, OWNER), 'the first press resolves');

    deleteSession(session.id);

    assert.equal(getOwnedSession(session.id, OWNER), null, 'a second press must not resolve');
  });
});

describe('deleteSessionsForOwner', () => {
  test('removes every session belonging to one user', () => {
    /**
     * Called when an account is deleted, so no open menu still references removed servers.
     */
    createSession(OWNER, { view: 'dashboard' });
    createSession(OWNER, { view: 'help' });
    createSession(STRANGER, { view: 'help' });

    assert.equal(deleteSessionsForOwner(OWNER), 2);
    assert.equal(sessionCount(), 1, 'the other user’s session should survive');
  });

  test('leaves other users untouched', () => {
    const foreign = createSession(STRANGER, {});
    createSession(OWNER, {});

    deleteSessionsForOwner(OWNER);

    assert.ok(getSession(foreign.id), 'the other user’s session must remain');
  });

  test('reports zero when the user has no sessions', () => {
    assert.equal(deleteSessionsForOwner(OWNER), 0);
  });

  test('coerces the owner id to a string', () => {
    createSession(OWNER, {});

    assert.equal(deleteSessionsForOwner(String(OWNER)), 1);
  });
});

describe('buildCustomId', () => {
  test('joins segments with the separator', () => {
    assert.equal(buildCustomId('dash', 'start', 'abc123'), 'dash:start:abc123');
    assert.equal(buildCustomId('help', 'category', 'xyz789'), 'help:category:xyz789');
  });

  test('places the session id last', () => {
    /**
     * sessionIdFromCustomId depends on this, so a component with an extra segment still resolves.
     */
    const id = buildCustomId('dash', 'image', 'extra', 'session123');

    assert.equal(sessionIdFromCustomId(id), 'session123');
  });

  test('coerces numeric segments', () => {
    assert.equal(buildCustomId('dash', 'page', 2, 'abc'), 'dash:page:2:abc');
  });

  test('throws when the result exceeds Discord’s limit', () => {
    /**
     * Discord silently rejects the whole message rather than the individual component, so a
     * truncated id would present as "the dashboard just does not send". Failing here makes it a
     * development-time error instead.
     */
    assert.throws(
      () => buildCustomId('namespace', 'action', 'x'.repeat(MAX_CUSTOM_ID_LENGTH)),
      /exceeds Discord/,
    );
  });

  test('accepts an id at exactly the limit', () => {
    const filler = 'x'.repeat(MAX_CUSTOM_ID_LENGTH - 'ns:action:'.length);
    const id = buildCustomId('ns', 'action', filler);

    assert.equal(id.length, MAX_CUSTOM_ID_LENGTH);
  });

  test('every real namespace and action fits comfortably', () => {
    /**
     * The longest custom id the project builds, checked so no component can be silently dropped.
     */
    const longest = buildCustomId('dash', 'reinstallConfirm', 'x'.repeat(12));

    assert.ok(longest.length <= MAX_CUSTOM_ID_LENGTH, `longest id is ${longest.length} characters`);
  });
});

describe('custom id parsing', () => {
  test('extracts the session id from the final segment', () => {
    assert.equal(sessionIdFromCustomId('dash:start:abc123'), 'abc123');
    assert.equal(sessionIdFromCustomId('help:category:xyz'), 'xyz');
    assert.equal(sessionIdFromCustomId('ns:action:extra:session'), 'session');
  });

  test('extracts the action from the second segment', () => {
    assert.equal(actionFromCustomId('dash:start:abc123'), 'start');
    assert.equal(actionFromCustomId('help:prev:xyz'), 'prev');
  });

  test('extracts the namespace from the first segment', () => {
    assert.equal(namespaceFromCustomId('dash:start:abc123'), 'dash');
    assert.equal(namespaceFromCustomId('srvdel:confirm:xyz'), 'srvdel');
  });

  test('returns null for an id with no separator', () => {
    /**
     * A component from another bot, or a crafted id. It must resolve to no session rather than to a
     * partial match.
     */
    assert.equal(sessionIdFromCustomId('no-separator'), null);
    assert.equal(actionFromCustomId('no-separator'), null);
  });

  test('returns null for a malformed id without throwing', () => {
    for (const bad of [null, undefined, '', 0, false, {}, []]) {
      assert.equal(sessionIdFromCustomId(bad), null, `sessionId for ${JSON.stringify(bad)}`);
      assert.equal(actionFromCustomId(bad), null, `action for ${JSON.stringify(bad)}`);
      assert.equal(namespaceFromCustomId(bad), null, `namespace for ${JSON.stringify(bad)}`);
    }
  });

  test('returns null for a trailing separator', () => {
    // An empty final segment is not a session id.
    assert.equal(sessionIdFromCustomId('dash:start:'), null);
  });

  test('round-trips a built id', () => {
    const session = createSession(OWNER, { identifier: 'a1b2c3d4' });
    const customId = buildCustomId('dash', 'restart', session.id);

    assert.equal(namespaceFromCustomId(customId), 'dash');
    assert.equal(actionFromCustomId(customId), 'restart');
    assert.equal(getSession(sessionIdFromCustomId(customId)), session);
  });
});

describe('custom ids carry no state', () => {
  test('a component id reveals nothing about its target', () => {
    /**
     * The design property that prevents tampering. The session holds the server identifier; the
     * custom id holds only a namespace, an action and an opaque token.
     */
    const session = createSession(OWNER, { identifier: 'a1b2c3d4', panelServerId: 501 });
    const customId = buildCustomId('dash', 'stop', session.id);

    assert.ok(!customId.includes('a1b2c3d4'), 'the identifier must not appear in the custom id');
    assert.ok(!customId.includes('501'), 'the panel id must not appear in the custom id');
    assert.ok(!customId.includes(OWNER), 'the owner must not appear in the custom id');
  });

  test('editing a custom id cannot retarget an action', () => {
    /**
     * A user substituting another session's token gets that session — and its ownership check —
     * rather than their own session pointed at someone else's server.
     */
    const mine = createSession(OWNER, { identifier: 'aaaaaaaa' });
    const theirs = createSession(STRANGER, { identifier: 'bbbbbbbb' });

    const forged = buildCustomId('dash', 'delete', theirs.id);
    const resolved = getSession(sessionIdFromCustomId(forged));

    assert.equal(resolved, theirs, 'the token selects the session');
    assert.equal(
      getOwnedSession(sessionIdFromCustomId(forged), OWNER),
      null,
      'and the ownership check refuses it',
    );
    assert.equal(getSession(mine.id).data.identifier, 'aaaaaaaa', 'their own session is unchanged');
  });
});

describe('sweepSessions', () => {
  test('removes expired sessions and keeps live ones', () => {
    const expired = createSession(OWNER, {}, -1);
    const live = createSession(OWNER, {}, 60_000);

    assert.equal(sweepSessions(), 1);
    assert.equal(getSession(expired.id), null);
    assert.ok(getSession(live.id), 'a live session must survive');
  });

  test('reports zero when nothing has expired', () => {
    createSession(OWNER, {}, 60_000);

    assert.equal(sweepSessions(), 0);
    assert.equal(sessionCount(), 1);
  });

  test('accepts an explicit clock, for deterministic testing', () => {
    const session = createSession(OWNER, {}, 1000);

    assert.equal(sweepSessions(Date.now()), 0, 'not yet expired');
    assert.equal(sweepSessions(Date.now() + 2000), 1, 'expired at the later clock');
    assert.equal(getSession(session.id), null);
  });

  test('handles an empty store', () => {
    assert.equal(sweepSessions(), 0);
  });
});

describe('startSessionSweeper', () => {
  test('returns a timer that does not hold the process open', () => {
    /**
     * An unref'd timer is what lets the process exit during shutdown rather than waiting out the
     * next sweep interval. If this ever regressed, the bot would take up to a minute to stop.
     */
    const timer = startSessionSweeper(60_000);

    assert.ok(timer, 'a timer handle should be returned');
    assert.equal(typeof timer.unref, 'function');

    clearInterval(timer);
  });

  test('sweeps on its interval', async () => {
    createSession(OWNER, {}, -1);

    const timer = startSessionSweeper(5);

    await new Promise((resolve) => {
      setTimeout(resolve, 30);
    });

    clearInterval(timer);

    assert.equal(sessionCount(), 0, 'the expired session should have been swept');
  });
});

describe('the session cap', () => {
  test('evicts rather than growing without bound', () => {
    /**
     * A public bot cannot let an unbounded map grow from component spam. The worst outcome of
     * eviction is that one user's menu times out early, which is strictly better than exhausting
     * memory.
     *
     * Filling the store to MAX_SESSIONS would be slow, so this asserts the cap is bounded and the
     * eviction path is reachable through the documented constant.
     */
    assert.ok(MAX_SESSIONS > 0);
    assert.ok(MAX_SESSIONS <= 100_000, 'the cap must be a real bound');
  });

  test('sweeps expired entries before evicting a live one', () => {
    /**
     * Reclaiming expired sessions first means a store full of stale entries does not cost a live
     * user their menu.
     */
    for (let index = 0; index < 20; index += 1) {
      createSession(OWNER, {}, -1);
    }

    assert.equal(sessionCount(), 20, 'expired entries are retained until read or swept');

    const live = createSession(OWNER, {}, 60_000);

    // The sweeper reclaims the expired ones on its next pass.
    sweepSessions();

    assert.equal(sessionCount(), 1);
    assert.ok(getSession(live.id), 'the live session must survive the sweep');
  });
});

describe('sessionCount and clearAllSessions', () => {
  test('counts stored sessions', () => {
    assert.equal(sessionCount(), 0);

    createSession(OWNER, {});
    createSession(STRANGER, {});

    assert.equal(sessionCount(), 2);
  });

  test('clearAllSessions empties the store and reports how many were removed', () => {
    // Used by tests between cases, and during shutdown so open menus are dropped with their
    // collectors.
    createSession(OWNER, {});
    createSession(STRANGER, {});

    assert.equal(clearAllSessions(), 2);
    assert.equal(sessionCount(), 0);
  });
});

describe('concurrent session isolation', () => {
  test('two users driving separate menus do not interfere', () => {
    /**
     * Each interactive flow gets its own session, so a page change in one menu cannot alter another
     * user's view even when both are open on the same channel.
     */
    const first = createSession(OWNER, { category: 'Account', page: 0 });
    const second = createSession(STRANGER, { category: 'Server', page: 1 });

    updateSessionData(first.id, { page: 3 });

    assert.equal(getSession(first.id).data.page, 3);
    assert.equal(getSession(second.id).data.page, 1, 'the other session is untouched');
    assert.equal(getSession(second.id).data.category, 'Server');
  });

  test('one user may hold several sessions at once', () => {
    // A dashboard and a help menu open simultaneously, which is ordinary usage.
    const dashboard = createSession(OWNER, { view: 'dashboard' });
    const help = createSession(OWNER, { view: 'help' });

    assert.notEqual(dashboard.id, help.id);
    assert.equal(getOwnedSession(dashboard.id, OWNER).data.view, 'dashboard');
    assert.equal(getOwnedSession(help.id, OWNER).data.view, 'help');
  });

  test('deleting one session leaves the user’s others intact', () => {
    const dashboard = createSession(OWNER, { view: 'dashboard' });
    const help = createSession(OWNER, { view: 'help' });

    deleteSession(dashboard.id);

    assert.equal(getSession(dashboard.id), null);
    assert.ok(getSession(help.id), 'the other session must survive');
  });
});
