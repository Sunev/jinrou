'use strict';

// Exercise real game code with only persistence, publishing and timers stubbed.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const coffee = require('coffee-script');
const yaml = require('js-yaml');
require('coffee-script/register');

const shared = require('../client/code/shared/game.coffee');
const libgame = require('../server/libs/game.coffee');
const i18n = require('i18next').createInstance();
i18n.init({
  lng: 'ja', initImmediate: false, defaultNS: 'game',
  resources: { ja: Object.fromEntries(['game', 'roles'].map(ns => [
    ns, yaml.safeLoad(fs.readFileSync(path.join(__dirname, '../language/ja', ns + '.yaml'), 'utf8')),
  ])) },
});
const context = {
  module: { exports: {} }, console, Buffer, clearTimeout,
  M: { users: { update() {} }, rooms: { update() {}, findOne(query, cb) { cb(null, null); } } },
  require(name) {
    if (name.endsWith('/shared/game.coffee')) return shared;
    if (name === '../../libs/game.coffee') return libgame;
    if (name.endsWith('/i18n.coffee')) return { getWithDefaultNS: () => i18n };
    if (name.endsWith('/time.coffee')) return require('../server/libs/time.coffee');
    if (name.endsWith('/savelogs.coffee')) return {
      LogSaver: class { constructor() { this.logs = []; } saveLog(log) { this.logs.push(log); } },
    };
    if (name === 'cron') return { CronJob: class {} };
    return {};
  },
};
const source = fs.readFileSync(path.join(__dirname, '../server/rpc/game/game.coffee'), 'utf8');
vm.runInNewContext(coffee.compile(source, { bare: true }), context);
const FOX = '特殊规则.量子人狼（妖狐）';
const ORIGINAL = '特殊规则.量子人狼';
const ss = { publish: { channel() {}, user() {} } };
function game(rule = FOX) {
  const g = new context.Game(ss);
  g.id = 'quantum-test';
  g.rule = { jobrule: rule, scapegoat: 'off', day: 0, night: 0,
    quantumwerewolf_table: 'open', quantumwerewolf_diviner: 'on', deadfox: 'obvious' };
  g.day = 2;
  g.phase = 'day';
  g.participants = g.players;
  g.save = g.saveUserRawLogs = g.prize_check = g.splashjobinfo = () => {};
  let shortId = 0;
  g.generateShortId = () => String(++shortId);
  return g;
}
// H/D/F/W1/W2 denote villagers, diviners, foxes and ranked wolves.
function world(roles, dead = []) {
  return Object.fromEntries(Object.entries(roles).map(([id, role]) => {
    const state = { jobtype: role[0] === 'W' ? 'Werewolf' :
      { H: 'Human', D: 'Diviner', F: 'Fox' }[role], dead: dead.includes(id) };
    if (role[0] === 'W') state.rank = Number(role.slice(1));
    return [id, state];
  }));
}
function scenario(worlds, dead = [], rule = FOX) {
  const g = game(rule);
  g.quantum_patterns = JSON.parse(JSON.stringify(worlds));
  for (const id of Object.keys(worlds[0])) {
    const p = context.Player.factory('QuantumPlayer', g);
    p.setProfile({ id, realid: id, name: id });
    if (dead.includes(id)) p.setDead(true, 'punish');
    g.players.push(p);
  }
  g.updateQuantumProbability();
  return g;
}
function fixedRandom(value, fn) {
  const original = Math.random;
  Math.random = () => value;
  try { return fn(); } finally { Math.random = original; }
}
function defaults(rules, result = {}) {
  for (const item of rules) {
    if (item.type === 'group') defaults(item.items, result);
    else if (item.type === 'item') {
      const r = item.value;
      result[r.id] = r.type === 'checkbox' ? (r.defaultChecked ? r.value : '') :
        r.type === 'hidden' ? r.value : r.defaultValue;
    }
  }
  return result;
}
function start(size, extra = {}) {
  const g = game();
  g.phase = 'preparing';
  g.day = 0;
  g.nextturn = () => {};
  context.games[g.id] = g;
  const profiles = Array.from({ length: size }, (_, i) => ({
    userid: 'p' + i, realid: 'p' + i, name: 'p' + i, mode: 'player', start: true,
  }));
  context.Server.game = { rooms: { oneRoomS(id, cb) {
    cb({ owner: { userid: 'owner' }, players: profiles, mode: 'waiting', number: size });
  } } };
  const query = Object.assign(defaults(shared.new_rules), {
    jobrule: FOX, scapegoat: 'on', yaminabe_hidejobs: '', rolerequest: 'on',
  }, extra);
  let result = 'callback not called';
  const actions = context.module.exports.actions({ use() {}, session: { userId: 'owner' } }, r => { result = r; }, ss);
  actions.gameStart(g.id, query);
  return { g, result, query };
}

// Actual start RPC, including role requests, bounds and forced scapegoat setting.
for (const size of [6, 7, 8, 12]) {
  const { g, result, query } = start(size);
  assert.strictEqual(result, null, 'Start at ' + size + ': ' + JSON.stringify(result));
  assert.strictEqual(query.scapegoat, 'off');
  assert.strictEqual(g.rule.scapegoat, 'off');
  assert(g.players.every(p => p.type === 'QuantumPlayer'));
  assert.notStrictEqual(g.phase, 'rolerequesting');
  const wolves = size < 8 ? 1 : 2;
  const expected = wolves === 1 ? size * (size - 1) * (size - 2) : size * (size - 1) * (size - 2) * (size - 3);
  assert.strictEqual(g.quantum_patterns.length, expected);
  for (const w of g.quantum_patterns) {
    const roles = Object.values(w);
    assert.strictEqual(roles.filter(s => s.jobtype === 'Fox').length, 1);
    assert.strictEqual(roles.filter(s => s.jobtype === 'Diviner').length, 1);
    assert.strictEqual(roles.filter(s => s.jobtype === 'Werewolf').length, wolves);
  }
  const table = g.updateQuantumProbability();
  assert.strictEqual(table[g.players[0].id].Fox, 1 / size);
  const doc = g.serialize();
  assert(Buffer.byteLength(JSON.stringify(doc)) < 16 * 1024 * 1024);
  // Restore actual Game and Player objects, not only the packing helper.
  doc.day = 2;
  doc.phase = 'day';
  doc.rule.day = 0;
  const restored = context.Game.unserialize(JSON.parse(JSON.stringify(doc)), ss);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(restored.quantum_patterns)), JSON.parse(JSON.stringify(g.quantum_patterns)));
}
for (const size of [5, 13]) assert.strictEqual(start(size).result, i18n.t('error.gamestart.quantumFoxPlayerCount'));
assert.strictEqual(start(6, { chemical: 'on' }).result, i18n.t('error.gamestart.noChemical'));
{
  const { g, result } = start(6, { quantumwerewolf_table: 'anonymous' });
  assert.strictEqual(result, null);
  const table = g.updateQuantumProbability();
  assert(Object.keys(table).every(id => id.startsWith('_$_player')));
  assert(Object.values(table).every(row => row.Fox === 1 / 6));
}
assert.throws(() => context.unpackQuantumFoxWorlds(Buffer.from([10]).toString('base64'), [{ id: 'A' }]));
assert.throws(() => context.unpackQuantumFoxWorlds(Buffer.from([0]).toString('base64'), [{ id: 'A' }, { id: 'B' }]));

// Fox-hunting continuation, fixed fox identity, and ordinary werewolf regression.
const foxA = world({ W: 'W1', A: 'F', B: 'D', C: 'H' }, ['W']);
const foxC = world({ W: 'W1', A: 'H', B: 'D', C: 'F' }, ['W']);
for (const [worlds, dead, winner] of [
  [[foxA, foxC], ['W'], null],
  [[foxA], ['W'], 'Fox'],
  [[world({ W: 'W1', A: 'F', B: 'D', C: 'H' }, ['W', 'A'])], ['W', 'A'], 'Human'],
  [[world({ W: 'W1', A: 'F' })], [], 'Fox'],
  [[world({ W: 'W1', A: 'F' }, ['A'])], ['A'], 'Werewolf'],
  [[world({ W: 'W1', A: 'F' }, ['W', 'A'])], ['W', 'A'], 'Human'],
]) {
  const g = scenario(worlds, dead);
  assert.strictEqual(g.judge(), winner !== null);
  assert.strictEqual(g.winner, winner);
  if (winner) {
    assert.strictEqual(g.quantum_patterns.length, 1);
    assert.strictEqual(g.serialize().quantumFoxWorlds, null);
    assert(g.logsaver.logs.some(log => log.mode === 'probability_table'));
    const final = g.quantum_patterns[0];
    for (const p of g.players) {
      const state = final[p.id];
      const team = state.jobtype === 'Fox' ? 'Fox' : state.jobtype === 'Werewolf' ? 'Werewolf' : 'Human';
      assert.strictEqual(p.winner, team === winner && (team !== 'Fox' || !state.dead));
    }
  }
}
for (const [draw, winner] of [[0, 'Fox'], [.99, 'Human']]) {
  const g = scenario([
    world({ W: 'W1', A: 'F', B: 'D', C: 'H' }, ['W', 'C']),
    world({ W: 'W1', A: 'H', B: 'D', C: 'F' }, ['W', 'C']),
  ], ['W', 'C']);
  fixedRandom(draw, () => assert.strictEqual(g.judge(), true));
  assert.strictEqual(g.winner, winner, 'Last two players observe one remaining world');
}
{
  const g = scenario([world({ W: 'W1', A: 'F', B: 'D', C: 'H' }, ['W', 'A'])], ['W']);
  const restored = context.Game.unserialize(JSON.parse(JSON.stringify(g.serialize())), ss);
  assert.strictEqual(restored.quantum_patterns[0].A.dead, true, 'Snapshot keeps uncertain deaths');
  assert.strictEqual(restored.quantum_patterns[0].W.dead, true, 'Snapshot keeps confirmed deaths');
  assert.strictEqual(g.judge(), true);
  assert.strictEqual(g.getPlayer('A').dead, true, 'Settle chain deaths before last-two judgement');
  assert(g.gamelogs.some(log => log.id === 'A' && log.event === 'found' && log.flag === 'curse'));
}
for (const [w, dead, winner] of [
  [world({ W: 'W1', D: 'D', H: 'H' }), [], null],
  [world({ W: 'W1', H: 'H' }), [], 'Werewolf'],
  [world({ W: 'W1', D: 'D', H: 'H' }, ['W']), ['W'], 'Human'],
]) {
  const g = scenario([w], dead, ORIGINAL);
  assert.strictEqual(g.judge(), winner !== null);
  assert.strictEqual(g.winner, winner);
  assert(!Object.prototype.hasOwnProperty.call(g.updateQuantumProbability()[g.players[0].id], 'Fox'));
}
{
  const g = scenario([foxA], ['W']);
  g.quantum_patterns = [];
  assert.strictEqual(g.judge(), true);
  assert.strictEqual(g.winner, 'Draw');
  assert(g.players.some(p => !p.dead), 'Empty worlds do not kill all players');
}

// Attacks and divination change only worlds in which the actor can act.
{
  const g = scenario([world({ W: 'W1', D: 'D', F: 'F', H: 'H' })]);
  g.getPlayer('W').setTarget(JSON.stringify({ Werewolf: 'F' }));
  g.getPlayer('W').midnight(g);
  assert.strictEqual(g.quantum_patterns[0].F.dead, false, 'Fox resists wolf attack');
  g.getPlayer('W').setTarget(JSON.stringify({ Werewolf: 'D' }));
  g.getPlayer('W').midnight(g);
  assert.strictEqual(g.quantum_patterns[0].D.dead, true);
}
{
  const alive = world({ W: 'W1', D: 'D', F: 'F', H: 'H' });
  const dead = world({ W: 'W1', D: 'D', F: 'F', H: 'H' }, ['D']);
  const g = scenario([alive, dead]);
  g.getPlayer('D').setTarget(JSON.stringify({ Diviner: 'F' }));
  g.getPlayer('D').midnight(g);
  assert.strictEqual(g.quantum_patterns[0].F.dead, true, 'Living diviner curses fox');
  assert.strictEqual(g.quantum_patterns[1].F.dead, false, 'Dead diviner cannot curse');
  assert.strictEqual(g.getPlayer('F').dead, false, 'Uncertain death is not public death');
  const noDiviner = scenario([dead]);
  noDiviner.getPlayer('D').sunset(noDiviner);
  assert.strictEqual(JSON.parse(noDiviner.getPlayer('D').target).Diviner, '');
}
{
  const g = scenario([world({ W: 'W1', U: 'W2', F: 'F', H: 'H' })]);
  const second = g.getPlayer('U');
  second.setTarget(JSON.stringify({ Werewolf: 'H' }));
  second.midnight(g);
  assert.strictEqual(g.quantum_patterns[0].H.dead, false, 'Only leading living wolf attacks');
  g.quantum_patterns[0].W.dead = true;
  second.midnight(g);
  assert.strictEqual(g.quantum_patterns[0].H.dead, true);
}
for (const hasDiviner of [false, true]) {
  const rolesA = { W: 'W1', D: 'D', A: 'F', B: 'H', C: 'H' };
  const rolesB = { W: 'W1', D: 'D', A: 'H', B: 'F', C: 'H' };
  const dead = hasDiviner ? ['W'] : ['W', 'D'];
  const g = scenario([world(rolesA, dead), world(rolesB, dead)], dead);
  g.phase = 'night';
  let forced;
  g.checkjobs = value => { forced = value; };
  g.beginturn();
  assert.strictEqual(forced, !hasDiviner, 'Skip empty hunting nights only when no living diviner is possible');
}
console.log('Quantum fox: start RPC, bounds, worlds, reload, judgement, chain deaths, attacks and original mode passed.');
