#!/usr/bin/env node
/**
 * 月下人狼: 悪霊憑依(SpiritPossessed)の転送ログ(转发发言)の回帰テスト
 * ==============================================================
 * 悪霊憑依が生存している間, 霊界(heaven)の発言は「転送」されて昼の発言として
 * 生きているプレイヤーにも見える。この転送ログは DB には保存されず,
 * makelogsFor() が配信時に合成する(server/rpc/game/game.coffee)。
 *
 * 検証内容:
 *   1. 原本が見えないプレイヤー(生存者・観戦者)には mode:"day" の転送ログだけを渡す。
 *      このログがその人にとって唯一の実体なので, 原本の shortId を引き継いで
 *      >>N で引用できるようにする。
 *   2. 原本も見えるプレイヤー(霊界視点の死者)には mode:"half-day" の複製も渡すが,
 *      短IDは原本側だけに持たせる(同じ短IDが2行に現れると引用の解決先が曖昧になる)。
 *   3. ゲーム終了後は原本が全員に公開されるので複製を渡さない
 *      (同じ発言がログに2行並ぶ「終了後の倍増」を避ける)。
 *
 * 使い方:
 *   node debug-script/test-possess-forward-logs.js
 *
 * 注意:
 *   * DB(MongoDB)もサーバーも使わない. global.Config / M / ss はスタブする.
 *   * Game クラスは module の外に公開されていないため, Game のコンストラクタが
 *     server/libs/savelogs.coffee の LogSaver に自分自身を渡すことを利用して
 *     インスタンスを捕まえる(test-quantum-werewolf.js と同じ手口).
 */
'use strict';

const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// --- Config (i18n の初期化に Config.language が要る) -------------------------
try {
  require('coffee-script/register');
} catch (e) {
  console.error('coffee-script/register が見つかりません (devDependencies)');
  process.exit(1);
}

let config = null;
for (const rel of ['../config/app.coffee', '../config.default/app.coffee']) {
  try {
    const c = require(path.join(__dirname, rel));
    if (c && c.language) {
      config = c;
      break;
    }
  } catch (e) {
    // 次の候補へ
  }
}
global.Config =
  config ||
  {
    language: { value: 'ja', fallback: 'ja' },
    mongo: { database: 'werewolf', host: '127.0.0.1', port: 27017 },
    admin: { password: '' },
  };

// --- 復元に使うゲーム文書 ---------------------------------------------------
// 転送ログの配信可否は「そのプレイヤーが原本を見られるか」だけで決まるので,
// 役職は悪霊憑依 + 死者 + 生存者の3人で足りる。
const RULE = {
  day: 300,
  night: 120,
  remain: 60,
  voteresult: '',
  wolfsound: '',
  couplesound: '',
};

const gameDoc = {
  id: 999999,
  rule: RULE,
  players: [
    {
      type: 'SpiritPossessed',
      id: 'p1',
      realid: 'u1',
      name: '悪霊憑依',
      dead: false,
      norevive: false,
      winner: false,
      flag: null,
    },
    {
      type: 'Human',
      id: 'p2',
      realid: 'u2',
      name: '死者',
      dead: true,
      norevive: false,
      winner: false,
      flag: null,
    },
    {
      type: 'Human',
      id: 'p3',
      realid: 'u3',
      name: '生存者',
      dead: false,
      norevive: false,
      winner: false,
      flag: null,
    },
  ],
  additionalParticipants: [],
  finished: false,
  day: 4,
  phase: 'day',
  winner: null,
  jobscount: {},
  gamelogs: [],
  gm: null,
  watchspeak: true,
  iconcollection: {},
  werewolf_flag: [],
  werewolf_target: [],
  werewolf_target_remain: 0,
  log_save_mode: 'v2',
  shortIdEnabled: true,
};

// --- チェック用ヘルパ -------------------------------------------------------
const failures = [];
function check(name, fn) {
  try {
    fn();
    console.log('  OK  ' + name);
  } catch (e) {
    failures.push(name);
    console.log('  NG  ' + name);
    console.log('      ' + ((e && e.message) || e));
  }
}

// --- DB スタブ --------------------------------------------------------------
// どのコレクションも no-op (Promise を返しておく)。
function stubCollection() {
  return new Proxy(
    {},
    {
      get: function () {
        return function () {
          return Promise.resolve();
        };
      },
    },
  );
}

function setup() {
  global.M = {
    games: {
      findOne: function (query, options, cb) {
        cb(null, gameDoc);
      },
      update: function () {
        return Promise.resolve();
      },
      updateOne: function () {
        return Promise.resolve();
      },
      insertOne: function () {
        return Promise.resolve();
      },
    },
    // ensureShortIds (v2) は find(...).toArray(cb) を使う
    gamelogs: {
      find: function () {
        return {
          toArray: function (cb) {
            cb(null, []);
          },
        };
      },
      bulkWrite: function () {
        return Promise.resolve();
      },
      insertMany: function () {
        return Promise.resolve();
      },
    },
    rooms: stubCollection(),
    users: stubCollection(),
    userlogs: stubCollection(),
    userrawlogs: stubCollection(),
    usersummary: stubCollection(),
  };

  // Game のコンストラクタは `new libsavelogs.LogSaver this` で自分自身を渡す.
  const libsavelogs = require(path.join(ROOT, 'server', 'libs', 'savelogs.coffee'));
  const OriginalLogSaver = libsavelogs.LogSaver;
  let captured = null;
  libsavelogs.LogSaver = function (game) {
    captured = game;
    return new OriginalLogSaver(game);
  };

  const gameModule = require(path.join(ROOT, 'server', 'rpc', 'game', 'game.coffee'));
  const fakeSs = {
    publish: {
      channel: function () {},
      user: function () {},
    },
  };

  // loadGame -> Game.unserialize の中で Game が作られ, 上のフックで捕まる
  gameModule.playerchannel(fakeSs, gameDoc.id, {
    userId: 'test-observer',
    channel: { subscribe: function () {} },
  });

  const game = captured;
  assert.ok(game, 'Game を取得できなかった');
  // DB やタイマー, 配信に触らないように差し替える
  clearTimeout(game.timerid);
  game.timer = function () {};
  game.save = function () {};
  game.saveUserRawLogs = function () {};
  game.prize_check = function () {};
  game.logsaver = { saveLog: function () {} };
  game.ss = fakeSs;
  return game;
}

// 霊界発言(悪霊憑依が昼の発言として転送するもの)を模したログ
function heavenLog(shortId) {
  return {
    mode: 'heaven',
    comment: '転送される霊界発言',
    userid: 'u2',
    name: '死者',
    to: null,
    time: 1792000000000,
    possess_name: '悪霊憑依',
    possess_id: 'p1',
    shortId: shortId,
  };
}

function main() {
  const game = setup();
  const alive = game.getPlayer('p3'); // 転送先の生きているプレイヤー
  const possessor = game.getPlayer('p1'); // 悪霊憑依本人
  const dead = game.getPlayer('p2'); // 霊界が見える死者
  const observer = null; // 観戦者

  console.log('1. 原本が見えないプレイヤー: 転送ログ(mode:"day")だけを渡し, 短IDを引き継ぐ');
  check('生存者: 転送ログ1件のみ / 発言者は憑依先', function () {
    game.finished = false;
    game.heavenview = false;
    const logs = game.makelogs([heavenLog('123')], alive);
    assert.strictEqual(logs.length, 1);
    assert.strictEqual(logs[0].mode, 'day');
    assert.strictEqual(logs[0].name, '悪霊憑依');
    assert.strictEqual(logs[0].userid, 'p1');
    assert.strictEqual(logs[0].comment, '転送される霊界発言');
  });
  check('生存者: 転送ログが原本の短IDを持つ (>>123 で引用できる)', function () {
    const logs = game.makelogs([heavenLog('123')], alive);
    assert.strictEqual(logs.length, 1);
    assert.strictEqual(logs[0].shortId, '123');
  });
  check('悪霊憑依本人: 転送ログ1件のみ + 短IDを引き継ぐ', function () {
    const logs = game.makelogs([heavenLog('234')], possessor);
    assert.strictEqual(logs.length, 1);
    assert.strictEqual(logs[0].mode, 'day');
    assert.strictEqual(logs[0].shortId, '234');
  });
  check('観戦者: 転送ログ1件のみ + 短IDを引き継ぐ', function () {
    const logs = game.makelogs([heavenLog('456')], observer);
    assert.strictEqual(logs.length, 1);
    assert.strictEqual(logs[0].mode, 'day');
    assert.strictEqual(logs[0].shortId, '456');
  });
  check('原本に短IDが無い場合は転送ログにも付けない', function () {
    const logs = game.makelogs([heavenLog(undefined)], observer);
    assert.strictEqual(logs.length, 1);
    assert.strictEqual(logs[0].shortId, undefined);
  });

  console.log('2. 原本も見えるプレイヤー: 複製も渡すが短IDは原本だけに持たせる');
  check('霊界視点の死者: 原本 + half-day 複製の2件', function () {
    game.finished = false;
    game.heavenview = true;
    const logs = game.makelogs([heavenLog('789')], dead);
    assert.strictEqual(logs.length, 2);
    assert.strictEqual(logs[0].mode, 'heaven');
    assert.strictEqual(logs[0].shortId, '789');
    assert.strictEqual(logs[1].mode, 'half-day');
    assert.strictEqual(logs[1].name, '悪霊憑依');
  });
  check('霊界視点の死者: 複製側には短IDを付けない (同じ短IDが2行に出ない)', function () {
    const logs = game.makelogs([heavenLog('789')], dead);
    assert.strictEqual(logs[1].shortId, undefined);
  });

  console.log('3. ゲーム終了後: 原本が全員に公開されるので転送ログの複製は渡さない');
  check('終了後(観戦者): 原本1件のみ (同じ発言が2行にならない)', function () {
    game.finished = true;
    const logs = game.makelogs([heavenLog('321')], observer);
    assert.strictEqual(logs.length, 1);
    assert.strictEqual(logs[0].mode, 'heaven');
  });
  check('終了後(生存者): 原本1件のみ', function () {
    const logs = game.makelogs([heavenLog('321')], alive);
    assert.strictEqual(logs.length, 1);
    assert.strictEqual(logs[0].mode, 'heaven');
  });
  check('終了後(霊界視点の死者): 原本1件のみ', function () {
    const logs = game.makelogs([heavenLog('321')], dead);
    assert.strictEqual(logs.length, 1);
    assert.strictEqual(logs[0].mode, 'heaven');
  });
  check('終了後も原本は短IDを持つ (引用 >>321 が使える)', function () {
    const logs = game.makelogs([heavenLog('321')], observer);
    assert.strictEqual(logs[0].shortId, '321');
  });

  console.log('');
  if (failures.length) {
    console.log('NG: ' + failures.length + ' 件のチェックが失敗しました');
    for (const name of failures) {
      console.log('  - ' + name);
    }
    process.exit(1);
  }
  console.log('すべてのチェックに成功しました');
  process.exit(0);
}

main();
