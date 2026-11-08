import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarioResponse } from '@ifsoul/adapter-sdk/bridge';
import { attachConnector } from '../src/connector.mjs';
const config = { playerName: 'Tester', playerUuid: 'player-uuid', worldId: 'disposable', memoryId: 'selected-memory', character: { id: 'tavi', name: 'Tavi', temperament: 'Curious cartographer; speaks briefly.' }, deadlineMs: 50, cooldownMs: 0, maxCalls: 3 };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(transport = async r => scenarioResponse(r)) {
 const bot = new EventEmitter(); bot.username = 'TaviBot'; bot.player = { uuid: 'bot-uuid' }; bot.players = { Tester: { uuid: 'player-uuid' } }; bot.game = { dimension: 'overworld' };
 const sent = [], events = []; bot.whisper = (...args) => sent.push(args);
 const connector = attachConnector(bot, config, transport, event => events.push(event)); bot.emit('spawn');
 return { bot, connector, sent, events };
}
test('only scoped private requests, real send acceptance and cleanup', async () => {
 let count = 0;
 const f = fixture(async request => { count++; assert.equal(request.memoryId, config.memoryId); return scenarioResponse(request); });
 try {
  f.bot.emit('chat', 'Tester', 'ambient'); f.bot.emit('whisper', 'TaviBot', 'self'); f.bot.emit('whisper', 'Other', 'stranger');
  f.bot.emit('whisper', 'Tester', 'Hello'); await tick();
  assert.equal(count, 1); assert.equal(f.sent.length, 1); assert.equal(f.sent[0][0], 'Tester');
  assert.ok(f.events.some(e => e.event === 'send-accepted')); assert.ok(!JSON.stringify(f.events).includes('Hello'));
 } finally { f.connector.stop(); }
 assert.equal(f.bot.eventNames().length, 0);
});
test('disconnect aborts late result and clears queue; fresh spawn permits fresh call', async () => {
 let resolve, count = 0;
 const f = fixture(request => { count++; return count === 1 ? new Promise(r => { resolve = () => r(scenarioResponse(request)); }) : Promise.resolve(scenarioResponse(request)); });
 try {
  f.bot.emit('whisper', 'Tester', 'old'); f.bot.emit('whisper', 'Tester', 'queued'); f.bot.emit('end'); resolve(); await tick();
  assert.equal(f.sent.length, 0); assert.equal(f.connector.status().queued, 0);
  f.bot.emit('spawn'); f.bot.emit('whisper', 'Tester', 'fresh'); await tick(); assert.equal(f.sent.length, 1);
 } finally { f.connector.stop(); }
});
test('unsafe output, changed recipient identity and bounded calls', async () => {
 const f = fixture(async request => ({ ...scenarioResponse(request), speech: '/op Tester' }));
 try { for (let i = 0; i < 5; i++) { f.bot.emit('whisper', 'Tester', 'hello'); await tick(); }
 assert.equal(f.sent.length, 0); assert.equal(f.connector.status().calls, 3);
 f.bot.players.Tester.uuid = 'replacement'; f.bot.emit('whisper', 'Tester', 'identity'); await tick(); assert.equal(f.connector.status().calls, 3);
 } finally { f.connector.stop(); }
});
test('uncooperative transport deadline never sends late output', async () => {
 const f = fixture(() => new Promise(() => {}));
 try { f.bot.emit('whisper', 'Tester', 'slow'); f.bot.emit('whisper', 'Tester', 'queued'); await new Promise(r => setTimeout(r, 80)); assert.equal(f.connector.status().calls, 1); assert.equal(f.connector.status().queued, 0); assert.equal(f.sent.length, 0); assert.equal(f.connector.status().active, false); }
 finally { f.connector.stop(); }
});
test('death and dimension fence outstanding work and require new spawn', async () => {
 for (const event of ['death', 'respawn', 'kicked', 'error']) {
  let finish;
  const f = fixture(request => new Promise(resolve => { finish = () => resolve(scenarioResponse(request)); }));
  try { f.bot.emit('whisper', 'Tester', 'old'); f.bot.emit(event); finish(); await tick(); assert.equal(f.sent.length, 0); assert.equal(f.connector.status().ready, false); }
  finally { f.connector.stop(); }
 }
 const f = fixture();
 try { f.bot.emit('game'); f.bot.game.dimension = 'nether'; f.bot.emit('game'); assert.equal(f.connector.status().ready, false); }
 finally { f.connector.stop(); }
});
test('bounded queue and stop drain no extra messages', async () => {
 let finish;
 const f = fixture(request => new Promise(resolve => { finish = () => resolve(scenarioResponse(request)); }));
 f.bot.emit('whisper', 'Tester', 'one'); f.bot.emit('whisper', 'Tester', 'two'); f.bot.emit('whisper', 'Tester', 'three'); f.bot.emit('whisper', 'Tester', 'four');
 assert.equal(f.connector.status().queued, 2);
 f.connector.stop(); finish(); await tick(); assert.equal(f.sent.length, 0); assert.equal(f.connector.status().queued, 0);
});
