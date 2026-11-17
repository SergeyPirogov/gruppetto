import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clean, SendGate, ChatLog, Reactions, Watchers, QUICK, REACTS, MAX_LEN, guestId } from '../js/chat.js';

test('chat: a message is one line, links out, rude words masked, at most 140 characters', () => {
  assert.equal(clean('  привіт\n\tвсім  '), 'привіт всім');
  assert.equal(clean('глянь https://evil.example/x і www.spam.ru'), 'глянь … і …');
  assert.equal(clean('free stuff at bit.ly/abc now'), 'free stuff at … now');
  assert.equal(clean('ну ти сука'), 'ну ти с***');
  assert.equal(clean('БЛЯХА'), 'Б***');
  assert.equal(clean('what the fuck'), 'what the f***');
  assert.equal(clean('сyка'), 'с***'); // a Latin y in a Cyrillic word
  assert.equal(clean('гарний темп, тримаю колесо'), 'гарний темп, тримаю колесо');
  assert.equal(clean('Classic shitake'), 'Classic s***'); // a little too careful, but never rude
  assert.equal(clean('x'.repeat(500)).length, MAX_LEN);
  assert.equal(clean('a‮b\u0007c'), 'a b c');
  assert.equal(clean(null), '');
});

test('chat: you send at most one a second and five in 15 s', () => {
  const g = new SendGate();
  assert.equal(g.ok(0), true);
  assert.equal(g.ok(500), false);
  for (const t of [1000, 2000, 3000, 4000]) assert.equal(g.ok(t), true);
  assert.equal(g.ok(5000), false); // the sixth in 15 s
  assert.equal(g.ok(15001), true);
});

test('chat: the log shows the others\' messages and quick phrases, drops a flood, and mutes', () => {
  const log = new ChatLog('me');
  assert.equal(log.receive({ u: 'me', n: 'Me', m: 'echo' }, 0), null); // your own comes back only as sent
  assert.equal(log.receive({ u: 'me', n: 'Me', m: 'hi' }, 0, { mine: true }).me, true);
  const q = log.receive({ u: 'a', n: 'Ann', q: 'wheel' }, 0);
  assert.equal(q.text, QUICK.find((x) => x.id === 'wheel').text);
  assert.equal(q.quick, 'wheel');
  assert.equal(log.receive({ u: 'a', n: 'Ann', m: 'again' }, 200), null); // under a second
  assert.equal(log.receive({ u: 'a', n: 'Ann', q: 'nope' }, 5000), null); // no such phrase, no text
  assert.equal(log.receive({ u: 'bad id!', n: 'X', m: 'x' }, 0), null);
  log.receive({ u: 'b', n: 'Bo', m: 'yo' }, 100);
  log.mute('a');
  assert.deepEqual(log.recent(200).map((e) => e.from), ['me', 'b']);
  assert.equal(log.receive({ u: 'a', n: 'Ann', m: 'still here' }, 9000), null);
  assert.deepEqual(log.recent(30000, 5, 20000).map((e) => e.from), []); // all older than 20 s by then
});

test('chat: the log keeps the last 40', () => {
  const log = new ChatLog('me');
  for (let i = 0; i < 50; i++) log.receive({ u: 'me', n: 'Me', m: `m${i}` }, i, { mine: true });
  assert.equal(log.items.length, 40);
  assert.equal(log.items[0].text, 'm10');
});

test('reactions: a known emoji, one a second per sender', () => {
  const r = new Reactions();
  assert.deepEqual(r.receive({ u: 'g-1', n: 'Fan', to: 'rider', e: 1 }, 0), { from: 'g-1', name: 'Fan', to: 'rider', emoji: REACTS[1] });
  assert.equal(r.receive({ u: 'g-1', to: 'rider', e: 0 }, 500), null);
  assert.equal(r.receive({ u: 'g-1', to: 'rider', e: 99 }, 5000), null);
  assert.equal(r.receive({ u: 'g-1', to: 'rider', e: 0 }, 5000).name, null);
});

test('watchers: counted for 25 s after they last said so', () => {
  const w = new Watchers();
  w.receive({ u: 'a' }, 0); w.receive({ u: 'b' }, 10000); w.receive({ u: 'a' }, 12000);
  assert.equal(w.count(20000), 2);
  assert.equal(w.count(36000), 1);
});

test('a spectator\'s id: random, the same for the tab', () => {
  const m = new Map(), store = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
  const a = guestId(store);
  assert.match(a, /^g-[a-z0-9]+$/);
  assert.equal(guestId(store), a);
});
