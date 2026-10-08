#!/usr/bin/env node
/**
 * 月下人狼: 量子人狼(特殊规则.量子人狼)の勝敗判定の回帰テスト
 * =========================================================
 * room 250799 (2023-07-13, 量子人狼 / 村人4・占卜师1・人狼1) では,
 * 最後の確定人狼 Adrian を投票で処刑した直後に「【人狼胜利】」で終わっていた.
 *
 * 原因: Game::judge() の量子人狼ルーチンが
 *   - 生存者数 alives  … 実際の死亡状態(@dead)から数える
 *   - 確定人狼の人数   … beginturn が書いた古い確率(@flag.dead)から数える
 * と情報源が食い違っていたため, 処刑された確定人狼が「生存中の人狼」として
 * 数えられ, `alives(2) <= assured_wolf.alive(1) * 2` が成立していた.
 * @flag は beginturn でしか更新されず, 処刑はターンの途中に起きる.
 *
 * 検証内容:
 *   1. 純粋関数 server/libs/game.coffee の judgeQuantumWerewolf の基本ケース
 *   2. room 250799 の終局データ(実ログから復元)で "Human" になる
 *      (修正前の flag ベースの計算だと "Werewolf" になることも確かめる)
 *   3. 実物の Game::judge() を, DB もサーバーも無しで復元した状態に対して呼び,
 *      村人勝利で終わること・勝敗がプレイヤーに正しく配られることを確認する
 *
 * 使い方:
 *   node debug-script/test-quantum-werewolf.js
 *
 * 注意:
 *   * DB(MongoDB)もサーバーも使わない. global.M と ss はスタブする.
 *   * Game クラスは module の外に公開されていないため, Game のコンストラクタが
 *     server/libs/savelogs.coffee の LogSaver に自分自身を渡すことを利用して
 *     インスタンスを捕まえる(captureGame).
 */
'use strict';

const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// --- config (i18n の初期化に Config.language が要る) ------------------------
function loadConfig() {
  try {
    require('coffee-script/register');
  } catch (e) {
    return null;
  }
  for (const rel of ['../config/app.coffee', '../config.default/app.coffee']) {
    try {
      const config = require(path.join(__dirname, rel));
      if (config && config.language) {
        return config;
      }
    } catch (e) {
      // 次の候補へ
    }
  }
  return null;
}

global.Config =
  loadConfig() ||
  {
    language: { value: 'ja', fallback: 'ja' },
    mongo: { database: 'werewolf', host: '127.0.0.1', port: 27017 },
    admin: { password: '' },
  };

const libgame = require(path.join(ROOT, 'server', 'libs', 'game.coffee'));
const libi18n = require(path.join(ROOT, 'server', 'libs', 'i18n.coffee'));
const i18n = libi18n.getWithDefaultNS('game');

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

// ---------------------------------------------------------------------------
// room 250799 の終局データ (debug-script/rpc.js game.game.getlog 250799 の結果から復元)
// ---------------------------------------------------------------------------
// d4 の beginturn が書き, 処刑の瞬間まで更新されなかった最後の確率表.
// これが当時の @flag そのもの (= 古い確率).
const LAST_PROBABILITY_TABLE = {
  '271321': { name: '所念皆星河', Human: 1, Werewolf: 0, dead: 1 },
  LC: { name: 'LC', Human: 1, Werewolf: 0, dead: 1 },
  President: { name: 'President', Human: 1, Werewolf: 0, dead: 0 },
  haoyunlianlian: { name: '好运莲莲', Human: 1, Werewolf: 0, dead: 0 },
  User14000605: { name: '火星人 可能想死', Human: 1, Werewolf: 0, dead: 1 },
  // Adrian は d3 の夜に President / 好运莲莲 の占いで確定人狼になった.
  // dead は 0 のまま(処刑されるのはこの後).
  randi: { name: 'Adrian', Human: 0, Werewolf: 1, dead: 0 },
};

// 人狼の役職が入る枠は 1 つだけなので, 確定人狼になるのは Adrian しかいない.
const WOLF_ID = 'randi';
// それ以外の 5 人 (このうち 1 人が占卜师, 残りが村人).
const NON_WOLF_IDS = ['LC', 'President', 'haoyunlianlian', 'User14000605', '271321'];
// 終局までに死亡しているプレイヤー (d2 に LC 処刑, d3 に所念皆星河 処刑,
// d4 の朝に 火星人 が人狼の襲撃で死亡).
const DEAD_IDS = ['LC', 'User14000605', '271321'];

// 処刑 (Adrian) 直後に残っている世界線.
// 火星人の死因が「人狼の襲撃」だったため火星人=村人に収束し,
// 「人狼は Adrian しかありえない」世界だけが残った(確率表で Werewolf=1.00).
function buildPatterns(wolfDead) {
  return NON_WOLF_IDS.map(function (diviner) {
    const world = {};
    for (const id of NON_WOLF_IDS) {
      world[id] = {
        jobtype: id === diviner ? 'Diviner' : 'Human',
        dead: DEAD_IDS.indexOf(id) >= 0,
      };
    }
    world[WOLF_ID] = { jobtype: 'Werewolf', rank: 1, dead: !!wolfDead };
    return world;
  });
}
// 処刑直後 (Adrian は死亡)
const FINAL_PATTERNS = buildPatterns(true);
// 処刑前 (d4 の beginturn 時点 = 最後の確率表が作られた時点)
const START_PATTERNS = buildPatterns(false);

// 判定対象のプレイヤー (実際の生死 = 処刑後).
const PLAYERS = [
  { id: 'LC', name: 'LC', realid: 'LC', dead: true },
  { id: 'President', name: 'President', realid: 'President', dead: false },
  { id: 'haoyunlianlian', name: '好运莲莲', realid: 'haoyunlianlian', dead: false },
  { id: 'User14000605', name: '火星人 可能想死', realid: 'User14000605', dead: true },
  { id: '271321', name: '所念皆星河', realid: '271321', dead: true },
  { id: 'randi', name: 'Adrian', realid: 'randi', dead: true }, // ← 処刑された
];

// 修正前の judge() と同じ計算 (古い @flag を読む).
function legacyJudgeWithStaleFlags(table, players, totalWolf) {
  const alives = players.filter(function (p) {
    return !p.dead;
  }).length;
  const assured_wolf = { alive: 0, dead: 0 };
  for (const player of players) {
    const flag = table[player.id];
    if (!flag) break;
    if (flag.Werewolf === 1) {
      if (flag.dead === 1) assured_wolf.dead++;
      else if (flag.dead === 0) assured_wolf.alive++;
    }
  }
  if (alives <= assured_wolf.alive * 2) return 'Werewolf';
  if (assured_wolf.dead === totalWolf) return 'Human';
  return null;
}

// 世界線を組み立てるヘルパ (role:id の並びから 1 つの世界線を作る).
function makeWorld(jobs) {
  const world = {};
  for (const [job, ids] of jobs) {
    for (const id of ids) {
      world[id] = { jobtype: job, dead: false };
    }
  }
  return world;
}
function markDead(world, ids) {
  for (const id of ids) {
    world[id] = Object.assign({}, world[id], { dead: true });
  }
  return world;
}


// ---------------------------------------------------------------------------
// 1. 純粋関数 judgeQuantumWerewolf の基本ケース
// ---------------------------------------------------------------------------
function alivePlayers(ids) {
  return ids.map(function (id) {
    return { id: id, dead: false };
  });
}

function runPart1() {
  console.log('\n1. libgame.judgeQuantumWerewolf (純粋関数)');

  check('世界線が空 → null (呼び出し側が引き分けにする)', function () {
    assert.strictEqual(libgame.judgeQuantumWerewolf([], []), null);
  });

  // 1 世界線だけ: A が人狼, B/C が村人
  const world = makeWorld([['Werewolf', ['A']], ['Human', ['B', 'C']]]);

  check('確定人狼1人(生存) + 村人2人 → まだ決着しない', function () {
    assert.strictEqual(
      libgame.judgeQuantumWerewolf([world], alivePlayers(['A', 'B', 'C'])),
      null,
    );
  });

  check('確定人狼1人(生存) + 村人1人 → Werewolf', function () {
    assert.strictEqual(
      libgame.judgeQuantumWerewolf([world], alivePlayers(['A', 'B'])),
      'Werewolf',
    );
  });

  check('確定人狼が処刑された (村人2人) → Human', function () {
    assert.strictEqual(
      libgame.judgeQuantumWerewolf([world], [
        { id: 'A', dead: true },
        { id: 'B', dead: false },
        { id: 'C', dead: false },
      ]),
      'Human',
    );
  });

  check('確定人狼2人(生存) + 村人2人 → Werewolf', function () {
    const w = makeWorld([['Werewolf', ['A', 'B']], ['Human', ['C', 'D']]]);
    assert.strictEqual(
      libgame.judgeQuantumWerewolf([w], alivePlayers(['A', 'B', 'C', 'D'])),
      'Werewolf',
    );
  });

  check('確定人狼が 1 人死んでも, もう 1 人が確定でなければ決着しない', function () {
    // A は人狼の可能性も村人の可能性もある (確定していない). どちらの世界線でも死んでいる.
    const p1 = markDead(makeWorld([['Werewolf', ['A']], ['Human', ['B', 'C']]]), ['A']);
    const p2 = markDead(makeWorld([['Werewolf', ['B']], ['Human', ['A', 'C']]]), ['A']);
    assert.strictEqual(
      libgame.judgeQuantumWerewolf([p1, p2], [
        { id: 'A', dead: true },
        { id: 'B', dead: false },
        { id: 'C', dead: false },
      ]),
      null,
    );
  });
}

// ---------------------------------------------------------------------------
// 2. room 250799 の終局データ (実ログから復元)
// ---------------------------------------------------------------------------
function runPart2() {
  console.log('\n2. room 250799 の終局データ (実ログから復元)');

  check('処刑直後の世界線では Adrian だけが確定人狼', function () {
    const certainWolves = PLAYERS.filter(function (p) {
      return FINAL_PATTERNS.every(function (w) {
        return w[p.id].jobtype === 'Werewolf';
      });
    }).map(function (p) {
      return p.id;
    });
    assert.deepStrictEqual(certainWolves, [WOLF_ID]);
  });

  check('修正前の計算 (古い @flag を読む) では "Werewolf" になっていた', function () {
    assert.strictEqual(legacyJudgeWithStaleFlags(LAST_PROBABILITY_TABLE, PLAYERS, 1), 'Werewolf');
  });

  check('処刑前 (d4 開始時点) は決着しない', function () {
    const before = PLAYERS.map(function (p) {
      return { id: p.id, dead: p.id === WOLF_ID ? false : p.dead };
    });
    assert.strictEqual(libgame.judgeQuantumWerewolf(FINAL_PATTERNS, before), null);
  });

  check('処刑後は "Human" (村人勝利)', function () {
    assert.strictEqual(libgame.judgeQuantumWerewolf(FINAL_PATTERNS, PLAYERS), 'Human');
  });
}


// ---------------------------------------------------------------------------
// 3. 実物の Game#judge()
// ---------------------------------------------------------------------------
// Game クラスは module の外に公開されていないので,
//   - Game のコンストラクタが server/libs/savelogs.coffee の LogSaver に
//     自分自身を渡すことを利用してインスタンスを捕まえ,
//   - global.M (DB) と ss をスタブし,
//   - M.games.findOne が返すゲーム文書から Player.unserialize でプレイヤーを復元させる
// ことで, サーバーを起動せずに judge() を直接呼ぶ.
//
// ゲーム文書の players[].flag は「d4 開始時の古い確率」, dead は「処刑後の実際の生死」.
// まさにバグが起きた瞬間の状態になる.
const RULE = {
  number: 7,
  maxnumber: 30,
  blind: '',
  gm: false,
  watchspeak: true,
  day: 30,
  night: 30,
  remain: 60,
  voting: 0,
  silentrule: 0,
  dynamic_day_time_factor: 30,
  quantum_joblist: { Diviner: 1, Human: 4, Werewolf1: 1 },
  jobrule: '特殊规则.量子人狼',
  dynamic_day_time: '',
  decider: '',
  authority: '',
  scapegoat: 'off',
  will: 'die',
  wolfsound: 'aloud',
  couplesound: '',
  heavenview: 'norevive',
  shoji: '',
  wolfattack: '',
  guardmyself: '',
  votemyself: '',
  deadfox: '',
  deathnote: '',
  divineresult: 'sunrise',
  psychicresult: 'sunrise',
  waitingnight: 'wait',
  safety: 'full',
  friendsjudge: 'alive',
  noticebitten: '',
  voteresult: '',
  GMpsychic: '',
  wolfminion: '',
  drunk: '',
  losemode: '',
  gjmessage: '',
  rolerequest: '',
  runoff: 'no',
  drawvote: 'revote',
  chemical: '',
  ushi: '',
  firstnightdivine: 'manual',
  consecutiveguard: 'yes',
  hunter_lastattack: 'yes',
  poisonwolf: 'selector',
  friendssplit: 'split',
  quantumwerewolf_table: 'open',
  quantumwerewolf_dead: '',
  quantumwerewolf_diviner: '',
  quantumwerewolf_firstattack: '',
  yaminabe_hidejobs: '',
  yaminabe_safety: 'low',
  hide_singleton_teams: '',
};

function playerDoc(id) {
  const table = LAST_PROBABILITY_TABLE[id];
  const actual = PLAYERS.filter(function (p) {
    return p.id === id;
  })[0];
  return {
    type: 'QuantumPlayer',
    id: id,
    name: table.name,
    realid: id,
    dead: actual.dead,
    norevive: false,
    winner: false,
    // 古い確率 (処刑前). Adrian は Werewolf=1 なのに dead=0 のまま.
    flag: JSON.stringify({
      Human: table.Human,
      Diviner: 0,
      Werewolf: table.Werewolf,
      dead: table.dead,
    }),
    jobname: '量子人类',
    originalJobname: '量子人类',
  };
}

const gameDoc = {
  id: 250799,
  rule: RULE,
  players: PLAYERS.map(function (p) {
    return playerDoc(p.id);
  }),
  additionalParticipants: [],
  finished: false,
  day: 4,
  phase: 'day_remain',
  winner: null,
  jobscount: { QuantumPlayer: { name: '量子人类', number: 6 } },
  gamelogs: [],
  gm: null,
  watchspeak: true,
  iconcollection: {},
  werewolf_flag: [],
  werewolf_target: [],
  werewolf_target_remain: 0,
  log_save_mode: 'v2',
};

// DB スタブ用: どのコレクションも no-op (Promise を返しておく).
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

function runPart3() {
  console.log('\n3. Game#judge() (実物・DB とサーバーはスタブ)');

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
    rooms: stubCollection(),
    users: stubCollection(),
    gamelogs: stubCollection(),
    userrawlogs: stubCollection(),
  };

  // Game のコンストラクタは `new libsavelogs.LogSaver this` で自分自身を渡す.
  const libsavelogs = require(path.join(ROOT, 'server', 'libs', 'savelogs.coffee'));
  const OriginalLogSaver = libsavelogs.LogSaver;
  let capturedGame = null;
  libsavelogs.LogSaver = function (game) {
    capturedGame = game;
    return new OriginalLogSaver(game);
  };

  const gameModule = require(path.join(ROOT, 'server', 'rpc', 'game', 'game.coffee'));

  const published = [];
  const fakeSs = {
    publish: {
      channel: function (channel, event, data) {
        published.push({ channel: channel, event: event, data: data });
      },
      user: function () {},
    },
  };

  // loadGame -> Game.unserialize の中で Game が作られ, 上のフックで捕まる
  gameModule.playerchannel(fakeSs, gameDoc.id, {
    userId: 'test-observer',
    channel: { subscribe: function () {} },
  });

  const game = capturedGame;
  check('Game インスタンスを取得できる', function () {
    assert.ok(game, 'Game を取得できなかった');
  });
  if (!game) {
    return;
  }

  // DB やタイマーに触らないように差し替える
  game.logsaver = { saveLog: function () {} };
  game.save = function () {};
  game.saveUserRawLogs = function () {};
  game.prize_check = function () {};
  clearTimeout(game.timerid);
  game.timer = function () {};
  // quantum_patterns は DB に保存されないので, 処刑直後の世界線を手で入れる.
  game.quantum_patterns = FINAL_PATTERNS;

  check('復元直後: finished=false / winner=null', function () {
    assert.strictEqual(game.finished, false);
    assert.strictEqual(game.winner, null);
  });

  check('Player は QuantumPlayer として復元され, 古い @flag を持っている', function () {
    assert.strictEqual(game.players.length, 6);
    for (const pl of game.players) {
      assert.strictEqual(pl.type, 'QuantumPlayer');
    }
    const randi = game.getPlayer(WOLF_ID);
    const flag = JSON.parse(randi.flag);
    assert.strictEqual(flag.Werewolf, 1);
    assert.strictEqual(flag.dead, 0); // ← 古い (実際には処刑済み)
    assert.strictEqual(randi.dead, true); // ← 実際は死亡している
  });

  check('updateQuantumProbability() が実ログと同じ確率表を作る (d4 開始時点)', function () {
    // 処刑前の状態に戻して計算する. 実サーバーが d4 の beginturn で出した
    // probability_table (= LAST_PROBABILITY_TABLE, 実ログから復元) と一致するはず.
    const wolf = game.getPlayer(WOLF_ID);
    game.quantum_patterns = START_PATTERNS;
    wolf.setDead(false, null);
    const table = game.updateQuantumProbability();
    for (const id of Object.keys(LAST_PROBABILITY_TABLE)) {
      const expected = LAST_PROBABILITY_TABLE[id];
      const actual = table[id];
      assert.strictEqual(actual.Werewolf, expected.Werewolf, id + ': Werewolf');
      assert.strictEqual(actual.Human, expected.Human, id + ': Human');
      assert.strictEqual(actual.dead, expected.dead, id + ': dead');
    }
    // 処刑後の状態に戻す
    game.quantum_patterns = FINAL_PATTERNS;
    wolf.setDead(true, 'punish');
  });

  const judged = game.judge();

  check('judge() が対局の終了を報告する', function () {
    assert.strictEqual(judged, true);
    assert.strictEqual(game.finished, true);
  });

  check('winner は "Human" (人狼勝利にならない)', function () {
    assert.strictEqual(game.winner, 'Human');
  });

  check('勝敗: 村人 5 人が勝者, 確定人狼 Adrian は敗者', function () {
    const winners = game.players
      .filter(function (p) {
        return p.winner;
      })
      .map(function (p) {
        return p.id;
      })
      .sort();
    assert.deepStrictEqual(winners, NON_WOLF_IDS.slice().sort());
  });

  check('判定後: Adrian の @flag が最新になる (Werewolf=1, dead=1)', function () {
    const flag = JSON.parse(game.getPlayer(WOLF_ID).flag);
    assert.strictEqual(flag.Werewolf, 1);
    assert.strictEqual(flag.dead, 1);
  });

  check('村人勝利のアナウンスが配信される', function () {
    const comments = published
      .map(function (x) {
        return x.data && x.data.comment;
      })
      .filter(Boolean);
    const expected = i18n.t('system.judge', {
      short: i18n.t('judge.short.human'),
      result: i18n.t('judge.human'),
    });
    assert.ok(comments.indexOf(expected) >= 0, JSON.stringify(comments));
  });
}

// ---------------------------------------------------------------------------
// i18n の準備と実行
// ---------------------------------------------------------------------------
function waitForI18n(timeoutMs) {
  return new Promise(function (resolve) {
    const timer = setTimeout(function () {
      resolve(false);
    }, timeoutMs);
    libi18n.addResourceLoadCallback(function () {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function report() {
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

// ---------------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------------
(async function main() {
  // judge() がメッセージを翻訳するので, i18n のリソース読み込みを待つ.
  const loaded = await waitForI18n(15000);
  if (!loaded) {
    console.log('警告: i18n のリソース読み込みがタイムアウトしました');
  }
  runPart1();
  runPart2();
  runPart3();
  report();
})();

