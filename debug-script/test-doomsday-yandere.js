'use strict';

// Run the real role and judgement code without starting MongoDB or SocketStream.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const coffee = require('coffee-script');
const yaml = require('js-yaml');
require('coffee-script/register');

const root = path.join(__dirname, '..');
const shared = require('../client/code/shared/game.coffee');
const source = fs.readFileSync(path.join(root, 'server/rpc/game/game.coffee'), 'utf8');
const i18n = require('i18next').createInstance();
i18n.init({
  lng: 'ja', initImmediate: false, defaultNS: 'game',
  resources: { ja: Object.fromEntries(['game', 'roles'].map(ns => [
    ns, yaml.safeLoad(fs.readFileSync(path.join(root, 'language/ja', ns + '.yaml'), 'utf8')),
  ])) },
});
const context = {
  module: { exports: {} }, console, clearTimeout,
  M: { users: { update() {} }, rooms: { update() {}, findOne(query, cb) { cb(null, null); } } },
  require(name) {
    if (name.endsWith('/shared/game.coffee')) return shared;
    if (name === '../../libs/game.coffee') return require('../server/libs/game.coffee');
    if (name.endsWith('/i18n.coffee')) return { getWithDefaultNS: () => i18n };
    if (name.endsWith('/savelogs.coffee')) return {
      LogSaver: class { constructor() { this.logs = []; } saveLog(log) { this.logs.push(log); } },
    };
    if (name.endsWith('/time.coffee')) return require('../server/libs/time.coffee');
    if (name === 'cron') return { CronJob: class {} };
    return {};
  },
};
vm.runInNewContext(coffee.compile(source, { bare: true }), context);

function game() {
  const g = new context.Game({ publish: { channel() {}, user() {} } });
  g.id = 'doomsday-test';
  g.rule = { scapegoat: 'off' };
  g.day = 2;
  g.phase = 'night';
  g.participants = g.players;
  g.save = g.saveUserRawLogs = g.prize_check = g.splashjobinfo = () => {};
  return g;
}
function player(g, type) {
  const p = context.Player.factory(type, g);
  assert.strictEqual(p.type, type, 'Role must be registered: ' + type);
  const id = String(g.players.length);
  p.setProfile({ id, realid: id, name: type + id });
  g.players.push(p);
  return p;
}
function awakened(g) {
  const p = player(g, 'DoomsdayYandere');
  p.setFlag({ beloved: 'dead-beloved', awakened: true });
  return p;
}
function wrap(g, main, type, sub = null) {
  if (sub) sub.setProfile(main);
  const p = context.Player.factory(null, g, main, sub, context[type]);
  g.players[g.players.indexOf(main)] = p;
  return p;
}
function attack(g, actor, target) {
  actor.setFlag(Object.assign({}, actor.flag, { attack: target.id, attackDay: g.day }));
  actor.midnight(g);
}

// Counts, current identities, and complex roles.
assert(shared.jobs.includes('DoomsdayYandere'));
assert(shared.SAFETY_EXCLUDED_JOBS.includes('DoomsdayYandere'));
assert(shared.teams.Friend.includes('DoomsdayYandere'));
assert(shared.jobinfo.Friend.DoomsdayYandere);
for (const type of shared.nonhumans) {
  const g = game(), actor = awakened(g);
  player(g, type);
  assert.strictEqual(actor.canWinAfterAwakening(g), false, type + ' must block victory');
}
for (const [types, winner] of [
  [[], 'Friend'], [['Human'], 'Friend'], [['Madman'], 'Friend'],
  [['Human', 'RemoteWorker'], 'Friend'], [['Human', 'Madman'], null],
  [['Devil'], null], [['Lorelei'], 'Lorelei'], [['Fox'], 'Fox'],
  [['DoomsdayYandere'], null], [['Werewolf'], 'Werewolf'],
]) {
  const g = game(), actor = awakened(g);
  for (const type of types) type === 'DoomsdayYandere' ? awakened(g) : player(g, type);
  assert.strictEqual(g.judge(), winner !== null, types.join('+') + ': game ends');
  assert.strictEqual(g.winner, winner, types.join('+') + ': global winner');
  assert.strictEqual(actor.winner, winner === null ? null : winner === 'Friend');
}
{
  const g = game(), actor = awakened(g), human = player(g, 'Human');
  const devil = context.Player.factory('Devil', g);
  wrap(g, human, 'Chemical', devil);
  assert.strictEqual(actor.canWinAfterAwakening(g), false, 'Second Chemical slot blocks');
}
for (const type of ['Human', 'Madman']) {
  for (const secondSlot of [false, true]) {
    const g = game();
    const main = secondSlot ? player(g, type) : awakened(g);
    const sub = context.Player.factory(secondSlot ? 'DoomsdayYandere' : type, g);
    if (secondSlot) sub.setFlag({ beloved: 'dead-beloved', awakened: true });
    const chemical = wrap(g, main, 'Chemical', sub);
    assert.strictEqual(chemical.werewolfCount(), 1, 'Chemical retains awakened wolf count');
    assert.strictEqual(g.judge(), true);
    assert.strictEqual(g.winner, 'Friend');
  }
}
{
  const g = game(), actor = awakened(g), devil = player(g, 'Devil');
  wrap(g, devil, 'PhantomStolen');
  assert.strictEqual(actor.canWinAfterAwakening(g), true, 'Obsolete stolen role does not block');
}
{
  const g = game(), actor = awakened(g), human = player(g, 'Human');
  wrap(g, human, 'FoxMinion');
  assert.strictEqual(actor.canWinAfterAwakening(g), false, 'Dynamic fox identity blocks');
}
{
  const g = game(), actor = awakened(g), devil = player(g, 'Devil');
  devil.setDead(true, 'werewolf');
  player(g, 'Madman');
  assert.strictEqual(g.judge(), true);
  assert.strictEqual(g.winner, 'Friend', 'Dead nonhumans do not block');
  assert.strictEqual(actor.winner, true);
}
for (const [types, winner] of [
  [[], 'Draw'], [['Human'], 'Human'], [['Werewolf'], 'Werewolf'],
  [['Werewolf', 'Human', 'Human'], null], [['Human', 'DarkClown'], 'Werewolf'],
  [['Fox', 'Human'], 'Fox'], [['Vampire', 'Human'], 'Vampire'],
]) {
  const g = game();
  types.forEach(type => player(g, type));
  assert.strictEqual(g.judge(), winner !== null, 'Existing judgement still ends correctly');
  assert.strictEqual(g.winner, winner, 'Existing faction winner is preserved');
}

// Ordinary lovers retain their pairing, victory, and suicide rules.
{
  const g = game(), actor = awakened(g), main = player(g, 'Human'), partner = player(g, 'RemoteWorker');
  const left = wrap(g, main, 'Friend'), right = wrap(g, partner, 'Friend');
  left.cmplFlag = right.id;
  right.cmplFlag = left.id;
  player(g, 'Cupid');
  // Cupid is a human head, so remove it from the living endgame first.
  g.players[3].setDead(true, 'punish');
  assert.strictEqual(g.judge(), true);
  assert.strictEqual(g.winner, 'Friend');
  assert.strictEqual(actor.winner, true);
  assert.strictEqual(left.winner, true);
  assert.strictEqual(right.winner, true);
  assert.strictEqual(g.players[3].winner, true);
}
{
  const g = game(), actor = player(g, 'DoomsdayYandere'), partner = player(g, 'Human');
  const left = wrap(g, actor, 'Friend'), right = wrap(g, partner, 'Friend');
  left.cmplFlag = right.id;
  right.cmplFlag = left.id;
  left.setFlag({ beloved: right.id, awakened: false });
  right.setDead(true, 'werewolf');
  left.beforebury(g, 'other', []);
  assert.strictEqual(left.dead, true, 'Cupid pairing still causes lovers suicide');
}

// Private selection, exactly-once awakening, and saved night actions.
{
  const g = game(), actor = player(g, 'DoomsdayYandere'), beloved = player(g, 'Human');
  assert.strictEqual(actor.flag, null);
  assert.strictEqual(actor.humanCount(), 1);
  assert.strictEqual(actor.werewolfCount(), 0);
  assert.strictEqual(actor.getFortuneResult(), 'human');
  assert.strictEqual(actor.getPsychicResult(), 'human');
  assert.strictEqual(actor.getOpenForms(g)[0].type, 'DoomsdayYandere');
  assert(!actor.makeJobSelection(g, false).some(p => p.value === actor.id));
  assert(actor.job(g, actor.id));
  assert.strictEqual(actor.job(g, beloved.id), null);
  assert.strictEqual(beloved.flag, null);
  assert.strictEqual(beloved.isFriend(), false);
  assert.strictEqual(actor.isWinner(g, 'Human'), true);
  assert.strictEqual(actor.isWinner(g, 'Draw'), false);
  assert.strictEqual(beloved.isWinner(g, 'Friend'), false);
  assert(g.logsaver.logs.every(log => log.to === actor.id));
  beloved.setDead(true, 'punish');
  actor.beforebury(g);
  actor.beforebury(g);
  const publicLogs = g.logsaver.logs.filter(log => log.mode === 'system');
  assert.strictEqual(publicLogs.length, 1);
  assert.strictEqual(publicLogs[0].to, undefined);
  assert.strictEqual(publicLogs[0].comment, '由于爱的人已经死去，终末病娇决心毁灭世界。');
  assert.strictEqual(actor.humanCount(), 0);
  assert.strictEqual(actor.werewolfCount(), 1);
  assert.strictEqual(actor.getFortuneResult(), 'werewolf');
  assert.strictEqual(actor.getPsychicResult(), 'werewolf');
  assert.strictEqual(actor.sleeping(g), true, 'No new action required on awakening night');
  g.day++;
  actor.sunset(g);
  const target = player(g, 'Human');
  assert.strictEqual(actor.getOpenForms(g)[0].type, 'DoomsdayYandereAttack');
  assert.strictEqual(actor.job(g, target.id), null);
  const restored = context.Player.unserialize(JSON.parse(JSON.stringify(actor.serialize())), g);
  restored.sunset(g);
  assert.strictEqual(restored.flag.attack, target.id, 'Reload keeps selected attack');
  g.players[0] = restored;
  restored.midnight(g);
  assert.strictEqual(target.dead, true);
  g.day++;
  restored.sunset(g);
  assert.strictEqual(restored.flag.attack, null, 'Next night requires a new attack');
}
{
  const g = game(), actor = player(g, 'DoomsdayYandere'), beloved = player(g, 'Human');
  actor.setFlag({ beloved: beloved.id, awakened: false });
  actor.setDead(true, 'werewolf');
  beloved.setDead(true, 'punish');
  actor.beforebury(g);
  assert.strictEqual(actor.flag.awakened, false, 'Dead role cannot awaken');
  assert.strictEqual(g.logsaver.logs.length, 0);
}

// Attacks use real death/resistance/retaliation hooks, including fox families.
for (const type of ['Werewolf', ...shared.categories.Fox]) {
  const g = game(), actor = awakened(g), target = player(g, type);
  attack(g, actor, target);
  assert.strictEqual(target.dead, true, 'Attack kills ' + type);
}
for (const type of ['Hero', 'Elder']) {
  const g = game(), actor = awakened(g), target = player(g, type);
  attack(g, actor, target);
  assert.strictEqual(target.dead, false, type + ' resists once');
  attack(g, actor, target);
  assert.strictEqual(target.dead, true, type + ' dies on second attack');
}
for (const type of ['Poisoner', 'Cat']) {
  const g = game(), actor = awakened(g), target = player(g, type), bystander = player(g, 'Human');
  attack(g, actor, target);
  assert.strictEqual(actor.dead, true, type + ' retaliates against attacker');
  assert.strictEqual(bystander.dead, false);
}
for (const [status, guardType] of [['Guarded', 'Guard'], ['TrapGuarded', 'Trapper'], ['SamuraiGuarded', 'Samurai']]) {
  const g = game(), actor = awakened(g), human = player(g, 'Human'), guard = player(g, guardType);
  const target = wrap(g, human, status);
  target.cmplFlag = guard.id;
  attack(g, actor, target);
  assert.strictEqual(target.dead, false, status + ' prevents attack');
  assert.strictEqual(actor.dead, status !== 'Guarded', status + ' retaliation');
}

// Execute the actual inline love-role allocation block with fixed random draws.
const start = source.indexOf('                    # 恋人陣営\n');
const end = source.indexOf('                    # 決闘者陣営\n', start);
assert(start >= 0 && end > start);
const block = source.slice(start, end).replace(/^ {16}/gm, '');
const casting = 'allocate = (playersnumber, nonavs, joblist, frees, exceptions)->\n' + block + '    {joblist, frees, exceptions}\n';
const castingContext = { Math: Object.create(Math) };
vm.runInNewContext(coffee.compile(casting, { bare: true }), castingContext);
for (const [size, draws] of [[8, [.9,.9,.9,.9,.02]], [12, [.9,.9,.9,.9,.9,.05]], [18, [.1,.9,.9,.9,.9,.9,.07,.9]]]) {
  for (const excluded of [false, true]) {
    let index = 0;
    castingContext.Math.random = () => draws[index++] ?? .99;
    const counts = Object.fromEntries(shared.jobs.map(type => [type, 0]));
    const result = castingContext.allocate(size, { DoomsdayYandere: excluded }, counts, 5, []);
    assert.strictEqual(result.joblist.DoomsdayYandere, excluded ? 0 : 1, 'Inline casting at size ' + size);
    assert.strictEqual(result.frees, excluded ? 5 : 4);
    assert(result.exceptions.includes('DoomsdayYandere'));
  }
}
console.log('DoomsdayYandere: judgement, selection, awakening, reload, attacks, guards, and inline casting passed.');
