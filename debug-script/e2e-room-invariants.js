#!/usr/bin/env node
/**
 * 月下人狼：部屋/対局の状態不変条件のエンドツーエンドテスト
 * ========================================================
 * room.mode と対局の状態が食い違ったまま残ると、部屋は二度と開始できなくなる。
 * 実際に room 372115 がこれで詰んだ（GMのヘルパー付きの村で、希望役職制の
 * 発牌が中断 → 部屋だけ playing のまま → gameStart も join も拒否される）。
 *
 * 本スクリプトは修正後のサーバーに対して以下を検証する:
 *   0. 使い捨てアカウントを作ってログインできる
 *   1. 使い捨ての部屋が「playing なのに未開始(day=0)」である（バグ状態の再現）
 *   2. game.game.getlog が部屋を waiting に戻す（Game.unserialize の自癒）
 *   3. game.rooms.helper は GM を対象として拒否する（error.helperTargetNotPlayer）
 *   4. game.rooms.helper はプレイヤー対象なら従来どおり通る
 *   5. game.game.gameStart で実際に対局が始まる（GMのヘルパーがあっても発牌できる）
 *      … 希望役職制のタイマー(60秒) → day=1/night になり、nextturn ログが残る
 *
 * 使い方:
 *   node debug-script/e2e-room-invariants.js                    # サーバーを自分で起動/停止
 *   node debug-script/e2e-room-invariants.js --no-start-server   # 既に起動中のサーバーに対して
 *   node debug-script/e2e-room-invariants.js --keep             # 検証データを消さずに残す
 *
 * オプション:
 *   --host=<host>       接続先（既定: config/app.coffee の application.url）
 *   --port=<n>          接続先ポート（既定: config/app.coffee の http.port）
 *   --scheme=<http|https>
 *   --mongo=<uri>       MongoDB URI（既定: config/app.coffee の mongo 設定）
 *   --no-start-server   サーバーを起動しない（起動済みのものを使う）
 *   --keep              終了時に検証データを消さない
 *   --timeout=<ms>      長輪詢のタイムアウト（既定: 40000）
 *   --help
 *
 * 注意:
 *   * DB に使い捨ての room/game とユーザー(e2euser9000001)を作り、終了時に消す。
 *   * 検証対象の部屋は毎回あたらしい id を使うので、既存の部屋には触れない。
 *   * --no-start-server のときはサーバーのログを読めないため、ログ確認は SKIP になる。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const mongo = require('mongodb');

const ROOT = path.join(__dirname, '..');
const E2E_USER = 'e2euser9000001';
const E2E_PASS = 'e2epass123';
// 希望役職制のタイマーは60秒。余裕を見て70秒待つ。
const WAIT_ROLEREQUEST_MS = 70000;
const RPC_RESPONDER_ID = '1';

// --- 設定（debug-script/rpc.js と同じ流儀で config/app.coffee を読む）-----------------
function loadConfig() {
  try {
    require('coffee-script/register');
  } catch (e) {
    return null;
  }
  for (const rel of ['../config/app.coffee', '../config.default/app.coffee']) {
    try {
      const config = require(path.join(__dirname, rel));
      if (config && config.mongo) {
        return config;
      }
    } catch (e) {
      // 次の候補へ
    }
  }
  return null;
}

const CONFIG = loadConfig() || {
  mongo: {
    database: 'werewolf',
    host: '127.0.0.1',
    port: 27017,
    user: 'test',
    pass: 'test',
  },
  http: { port: 8080 },
  application: { url: 'http://127.0.0.1/' },
};

const USAGE = `使い方: node debug-script/e2e-room-invariants.js [オプション]

オプション:
  --host=<host>       接続先（既定: config/app.coffee）
  --port=<n>          接続先ポート（既定: config/app.coffee の http.port）
  --scheme=<http|https>
  --mongo=<uri>       MongoDB URI（既定: config/app.coffee の mongo 設定）
  --no-start-server   サーバーを起動しない（起動済みのものを使う）
  --keep              検証データを消さずに残す
  --timeout=<ms>      長輪詢のタイムアウト（既定: 40000）
  --help
`;

function parseArgs(argv) {
  // E2E は基本的に手元のサーバーに対して走らせるので、既定は 127.0.0.1 +
  // config の http.port。別ホストに向けたいときは --host/--port/--scheme で上書きする。
  const opts = {
    host: '127.0.0.1',
    port: CONFIG.http && CONFIG.http.port ? CONFIG.http.port : 8080,
    scheme: 'http',
    mongo: null,
    startServer: true,
    keep: false,
    timeout: 40000,
    help: false,
  };
  for (const arg of argv) {
    const eq = arg.indexOf('=');
    const key = eq >= 0 ? arg.slice(0, eq) : arg;
    const value = eq >= 0 ? arg.slice(eq + 1) : null;
    switch (key) {
      case '--help':
      case '-h':
        opts.help = true;
        break;
      case '--host':
        opts.host = value;
        break;
      case '--port':
        opts.port = parseInt(value, 10) || opts.port;
        break;
      case '--scheme':
        opts.scheme = value === 'https' ? 'https' : 'http';
        break;
      case '--mongo':
        opts.mongo = value;
        break;
      case '--no-start-server':
        opts.startServer = false;
        break;
      case '--keep':
        opts.keep = true;
        break;
      case '--timeout':
        opts.timeout = parseInt(value, 10) || opts.timeout;
        break;
      default:
        break;
    }
  }
  return opts;
}

// --- engine.io(socketstream) の最小クライアント ---------------------------------
// 1本のセッションで複数の RPC を呼ぶ（ログイン状態を保つ必要があるため）。
// プロトコルは debug-script/rpc.js と同じ。payload の長さは「文字数」で宣言する
// （engine.io-parser は message.length で検証するので、バイト数だと非ASCIIで壊れる）。
function frame(packet) {
  return packet.length + ':' + packet;
}

function decodePackets(payload) {
  const packets = [];
  let rest = payload;
  while (rest.length > 0) {
    const sep = rest.indexOf(':');
    if (sep < 0) break;
    const length = parseInt(rest.slice(0, sep), 10);
    if (!Number.isFinite(length)) break;
    packets.push(rest.slice(sep + 1, sep + 1 + length));
    rest = rest.slice(sep + 1 + length);
  }
  return packets;
}

function httpRequest(opts, method, reqPath, options) {
  options = options || {};
  const lib = opts.scheme === 'https' ? require('https') : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        host: opts.host,
        port: opts.port || undefined,
        method,
        path: reqPath,
        headers: options.headers || {},
      },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.setTimeout(opts.timeout, () => req.destroy(new Error('timeout')));
    if (options.body != null) req.write(options.body);
    req.end();
  });
}

class RpcClient {
  constructor(opts) {
    this.opts = opts;
    this.cookie = '';
    this.sid = null;
    this.seq = 0;
  }

  async open() {
    const page = await httpRequest(this.opts, 'GET', '/', {
      timeout: this.opts.timeout,
    });
    this.cookie = (page.headers['set-cookie'] || [])
      .map(c => c.split(';')[0])
      .join('; ');
    if (!this.cookie) {
      throw new Error('session cookie(connect.sid) が取れません');
    }
    const hs = await httpRequest(
      this.opts,
      'GET',
      '/engine.io/?EIO=3&transport=polling&t=' + Date.now(),
      { headers: { Cookie: this.cookie }, timeout: this.opts.timeout },
    );
    const m = /"sid":"([^"]+)"/.exec(hs.body);
    if (!m) {
      throw new Error(
        'engine.io handshake 失敗: HTTP ' +
          hs.status +
          ' ' +
          hs.body.slice(0, 200),
      );
    }
    this.sid = m[1];
    return this;
  }

  url() {
    return (
      '/engine.io/?EIO=3&transport=polling&sid=' + this.sid + '&t=' + Date.now()
    );
  }

  post(packet) {
    return httpRequest(this.opts, 'POST', this.url(), {
      headers: {
        'Content-Type': 'text/plain;charset=UTF-8',
        Cookie: this.cookie,
      },
      body: frame('4' + packet),
      timeout: this.opts.timeout,
    });
  }

  poll() {
    return httpRequest(this.opts, 'GET', this.url(), {
      headers: { Cookie: this.cookie },
      timeout: this.opts.timeout,
    });
  }

  // 通信が原因の失敗はセッションを張り直してリトライする
  async call(method, params) {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.callOnce(method, params);
      } catch (e) {
        lastError = e;
        if (
          !/Session ID unknown|timeout|ECONNRESET|socket hang up/.test(
            String(e.message),
          )
        ) {
          throw e;
        }
        await sleep(1000);
        await this.open();
      }
    }
    throw lastError;
  }

  async callOnce(method, params) {
    let pending = this.poll();
    await sleep(300);
    const posted = await this.post(
      RPC_RESPONDER_ID +
        '|' +
        JSON.stringify({ m: method, id: ++this.seq, p: params }),
    );
    if (posted.status !== 200) {
      throw new Error(
        'POST 失敗: HTTP ' + posted.status + ' ' + posted.body.slice(0, 200),
      );
    }
    for (let i = 0; i < 20; i++) {
      const res = await pending;
      if (res.status !== 200) {
        throw new Error(
          'poll 失敗: HTTP ' + res.status + ' ' + res.body.slice(0, 200),
        );
      }
      for (const packet of decodePackets(res.body)) {
        if (packet[0] === '2') {
          await this.post('3');
          continue;
        }
        if (packet[0] !== '4') continue;
        const message = packet.slice(1);
        const sep = message.indexOf('|');
        if (sep < 0) continue;
        if (message.slice(0, sep) !== RPC_RESPONDER_ID) continue;
        const reply = JSON.parse(message.slice(sep + 1));
        if (reply && reply.e) {
          throw new Error(
            'RPC エラー: ' + (reply.e.message || JSON.stringify(reply.e)),
          );
        }
        const p = reply ? reply.p : undefined;
        return Array.isArray(p) && p.length === 1 ? p[0] : p;
      }
      pending = this.poll();
      await sleep(100);
    }
    throw new Error('RPC 応答なし: ' + method);
  }
}

// --- ユーティリティ -------------------------------------------------------------
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
function check(label, cond, detail, skip) {
  if (skip) {
    console.log('  SKIP ' + label + (detail == null ? '' : '  <= ' + detail));
    return;
  }
  console.log(
    (cond ? '  PASS ' : '  FAIL ') +
      label +
      (detail == null ? '' : '  <= ' + detail),
  );
  if (!cond) failures++;
}

function mongoUrl(opts) {
  if (opts.mongo) return opts.mongo;
  const c = CONFIG.mongo;
  return (
    'mongodb://' +
    c.user +
    ':' +
    c.pass +
    '@' +
    c.host +
    ':' +
    c.port +
    '/' +
    c.database +
    '?w=1'
  );
}

function connect(url) {
  return new Promise((resolve, reject) => {
    mongo.MongoClient.connect(
      url,
      (err, client) => (err ? reject(err) : resolve(client)),
    );
  });
}

async function withDb(url, fn) {
  const client = await connect(url);
  try {
    return await fn(client.db());
  } finally {
    await client.close();
  }
}

// --- 検証用の使い捨てデータ -----------------------------------------------------
// room 372115 の事故と同じ形を毎回組み立てる:
//   GM 1人 + プレイヤー11人 + ヘルパー3人（うち1人は「GMのヘルパー」＝バグの引き金）
function buildClone(roomid) {
  const players = [];
  const gm = {
    userid: 'e2egm',
    realid: 'e2egm',
    name: 'E2E GM',
    icon: '',
    start: true,
    mode: 'gm',
    nowprize: null,
  };
  for (let i = 1; i <= 11; i++) {
    players.push({
      userid: 'e2ep' + i,
      realid: 'e2ep' + i,
      name: 'E2E Player ' + i,
      icon: '',
      start: true,
      mode: 'player',
      nowprize: null,
    });
  }
  const helpers = [
    { userid: 'e2eh1', mode: 'helper_e2ep1' },
    { userid: 'e2eh2', mode: 'helper_e2ep2' },
    { userid: 'e2eh3', mode: 'helper_e2egm' }, // ← GM のヘルパー
  ].map(h => ({
    userid: h.userid,
    realid: h.userid,
    name: 'E2E ' + h.userid,
    icon: '',
    start: true,
    mode: h.mode,
    nowprize: null,
  }));
  // テスト実行者（ログインするアカウント）もメンバーにしておく。
  // rooms.helper は部屋のメンバーでないと応答を返さないため。
  helpers.push({
    userid: E2E_USER,
    realid: E2E_USER,
    name: 'E2E Tester',
    icon: '',
    start: true,
    mode: 'helper_e2ep1',
    nowprize: null,
  });
  const room = {
    id: roomid,
    name: 'E2E テスト（使い捨て）',
    number: 30,
    // バグ状態: 対局は未開始なのに room だけ playing
    mode: 'playing',
    players: [gm].concat(players, helpers),
    made: Date.now(),
    owner: { userid: gm.userid, name: gm.name },
    gm: true,
    watchspeak: true,
    jobrule: null,
    password: false,
    blind: '',
    theme: '',
    comment: 'debug-script/e2e-room-invariants.js が作った使い捨ての部屋',
  };
  const game = {
    id: roomid,
    rule: null, // 未開始のゲームは rule も phase も保存されていない
    players: [],
    additionalParticipants: [],
    finished: false,
    day: 0,
    phase: 'preparing',
    winner: null,
    jobscount: null,
    gamelogs: [],
    gm: true,
    watchspeak: true,
    iconcollection: {},
    werewolf_flag: [],
    werewolf_target: [],
    werewolf_target_remain: 0,
    finish_time: null,
    log_save_mode: 'v2',
  };
  return {
    room,
    game,
    playerCount: players.length,
    gmUser: gm.userid,
    gmHelper: helpers[2].userid,
  };
}

async function freeRoomId(db) {
  for (let i = 0; i < 10; i++) {
    const id = 900000000 + Math.floor(Math.random() * 100000000);
    if ((await db.collection('rooms').countDocuments({ id })) === 0) return id;
  }
  throw new Error('空いている検証用 room id を確保できませんでした');
}

// gameStart に渡すルール query を Shared.new_rules から組み立て、
// サーバー自身の validateGameStartQuery で検証する。
function buildQuery(playerCount) {
  require('coffee-script/register');
  global.Config = global.Config || CONFIG;
  const Shared = require(path.join(
    ROOT,
    'client',
    'code',
    'shared',
    'game.coffee',
  ));
  const libgame = require(path.join(ROOT, 'server', 'libs', 'game.coffee'));
  const rules = [];
  (function flatten(list) {
    for (const obj of list) {
      if (obj.type === 'group') flatten(obj.items);
      else if (obj.type === 'item') rules.push(obj.value);
    }
  })(Shared.new_rules);

  const q = {};
  for (const r of rules) {
    if (r.type === 'select') {
      const def = r.defaultValue;
      q[r.id] = def != null && r.values.indexOf(def) >= 0 ? def : r.values[0];
    } else if (r.type === 'checkbox') {
      q[r.id] = r.defaultChecked ? r.value : '';
    } else if (r.type === 'time' || r.type === 'integer') {
      q[r.id] = String(
        r.defaultValue != null
          ? r.defaultValue
          : r.minValue != null
            ? r.minValue
            : 1,
      );
    } else if (r.type === 'hidden') {
      q[r.id] = r.value;
    }
  }
  const byId = id => rules.filter(r => r.id === id)[0];
  q.jobrule = '特殊规则.自由配置';
  const scapegoat = byId('scapegoat');
  if (scapegoat) q.scapegoat = 'off';
  const chemical = byId('chemical');
  if (chemical)
    q.chemical = chemical.type === 'checkbox' ? '' : chemical.values[0];
  const rolerequest = byId('rolerequest');
  q.rolerequest = rolerequest && rolerequest.value ? rolerequest.value : 'on';
  for (const job of Shared.jobs) q[job] = '0';
  // 人狼を入れておかないと day1 の夜に「村人勝利」で即終了してしまう
  q.Human = String(playerCount - 2);
  q.Werewolf = '2';

  const err = libgame.validateGameStartQuery(null, q);
  if (err) throw new Error('生成した query が不正: ' + JSON.stringify(err));
  return q;
}

// --- サーバーの起動/停止 --------------------------------------------------------
function portOpen(opts) {
  return new Promise(resolve => {
    const req = http.request(
      { host: opts.host, port: opts.port, path: '/', method: 'GET' },
      res => {
        res.resume();
        resolve(true);
      },
    );
    req.on('error', () => resolve(false));
    req.setTimeout(3000, () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

async function startServer(opts) {
  if (await portOpen(opts)) {
    throw new Error(
      'ポート ' +
        opts.port +
        ' は既に使用中です。停止するか --no-start-server を付けてください',
    );
  }
  const outPath = path.join(os.tmpdir(), 'jinrou-e2e-server.out.log');
  const errPath = path.join(os.tmpdir(), 'jinrou-e2e-server.err.log');
  const child = spawn(process.execPath, ['app.js'], {
    cwd: ROOT,
    stdio: ['ignore', fs.openSync(outPath, 'w'), fs.openSync(errPath, 'w')],
  });
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    if (await portOpen(opts)) {
      await sleep(1000);
      return { child, outPath, errPath };
    }
    if (child.exitCode != null) {
      throw new Error('サーバーが起動直後に終了しました: ' + errPath);
    }
  }
  throw new Error('サーバーが起動しませんでした: ' + errPath);
}

function stopServer(server) {
  if (!server || !server.child || !server.child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(server.child.pid), '/T', '/F'], {
      stdio: 'ignore',
    });
  } else {
    server.child.kill('SIGTERM');
  }
}

// --- main ---------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  const url = mongoUrl(opts);
  const info = {};
  let server = null;
  let roomid = null;

  try {
    // 使い捨てデータの準備
    console.log('=== 準備: 使い捨ての部屋とアカウント ===');
    roomid = await withDb(url, async db => {
      const id = await freeRoomId(db);
      const clone = buildClone(id);
      Object.assign(info, clone);
      await db.collection('rooms').insertOne(clone.room);
      await db.collection('games').insertOne(clone.game);
      await db.collection('users').deleteMany({ userid: E2E_USER }); // 前回の残りを掃除
      return id;
    });
    console.log(
      '  部屋 #' +
        roomid +
        ': GM 1 / プレイヤー' +
        info.playerCount +
        ' / ヘルパー（' +
        info.gmHelper +
        ' は GM のヘルパー＝バグの引き金）',
    );
    const query = buildQuery(info.playerCount);
    console.log(
      '  gameStart: ' +
        query.jobrule +
        ' / Human=' +
        query.Human +
        ' / Werewolf=' +
        query.Werewolf,
    );

    if (opts.startServer) {
      console.log(
        '=== 準備: サーバーを起動（' +
          opts.scheme +
          '://' +
          opts.host +
          ':' +
          opts.port +
          '） ===',
      );
      server = await startServer(opts);
      console.log(
        '  サーバー PID: ' + server.child.pid + ' / ログ: ' + server.errPath,
      );
    } else {
      console.log('=== 準備: 起動済みのサーバーを使います ===');
      if (!(await portOpen(opts))) {
        throw new Error(
          'サーバーに接続できません: ' + opts.host + ':' + opts.port,
        );
      }
    }

    const client = new RpcClient(opts);
    await client.open();

    console.log('=== 0. 使い捨てアカウントの新規登録（=login） ===');
    await client.call('user.hello', []);
    const reg = await client.call('user.newentry', [
      { userid: E2E_USER, password: E2E_PASS },
    ]);
    check(
      'user.newentry でログインできた',
      reg && reg.login === true,
      JSON.stringify(reg),
    );

    console.log('=== 1. バグ状態の再現（#' + roomid + '） ===');
    const room0 = await client.call('game.rooms.oneRoom', [roomid]);
    check(
      'room.mode == "playing"（詰んだ状態）',
      room0.mode === 'playing',
      room0.mode,
    );
    const log0 = await client.call('game.game.getlog', [roomid]);
    check('game.day == 0', log0.game.day === 0, log0.game.day);
    check(
      'game.phase == "preparing"',
      log0.game.phase === 'preparing',
      log0.game.phase,
    );
    check(
      'game.rule == null',
      log0.game.rule === null,
      JSON.stringify(log0.game.rule),
    );

    console.log('=== 2. getlog（Game.unserialize の自癒） ===');
    const room1 = await client.call('game.rooms.oneRoom', [roomid]);
    check(
      'room.mode が "waiting" に戻った',
      room1.mode === 'waiting',
      room1.mode,
    );

    console.log('=== 3. ヘルパー: GM を対象にする ===');
    const helperGm = await client.call('game.rooms.helper', [
      roomid,
      info.gmUser,
    ]);
    check(
      'GM を対象にすると拒否される（i18n 済み）',
      typeof helperGm === 'string' &&
        helperGm.indexOf('只能成为玩家的帮手') >= 0,
      JSON.stringify(helperGm),
    );

    console.log('=== 4. ヘルパー: プレイヤーを対象にする（回帰チェック） ===');
    const helperPlayer = await client.call('game.rooms.helper', [
      roomid,
      'e2ep1',
    ]);
    check(
      'プレイヤー対象は従来どおり通る（null）',
      helperPlayer === null,
      JSON.stringify(helperPlayer),
    );

    console.log('=== 5. gameStart（希望役職制 → 60秒後に発牌） ===');
    const started = await client.call('game.game.gameStart', [roomid, query]);
    check(
      'gameStart が成功（null）',
      started === null,
      JSON.stringify(started),
    );

    console.log('  ... 希望役職制のタイマー(60秒)を待ちます ...');
    await sleep(WAIT_ROLEREQUEST_MS);

    const log2 = await client.call('game.game.getlog', [roomid]);
    check(
      'game.day == 1（対局が始まった）',
      log2.game.day === 1,
      log2.game.day,
    );
    check('game.night == true', log2.game.night === true, log2.game.night);
    check(
      'game.rule.jobrule が設定された',
      !!(log2.game.rule && log2.game.rule.jobrule === '特殊规则.自由配置'),
      JSON.stringify(log2.game.rule && log2.game.rule.jobrule),
    );
    const phaseLogs = (log2.logs || []).filter(l => l.mode === 'nextturn');
    check(
      'nextturn のログが記録された（元の症状はこれが無かった）',
      phaseLogs.length > 0,
      JSON.stringify(phaseLogs.map(l => l.comment)),
    );
    const room2 = await client.call('game.rooms.oneRoom', [roomid]);
    const finished = log2.game.finished === true;
    check(
      'room.mode が対局状態と同期している（playing か end）',
      room2.mode === (finished ? 'end' : 'playing'),
      room2.mode + ' (finished=' + finished + ')',
    );

    console.log('=== 6. サーバーログの確認 ===');
    if (server) {
      const log = fs.readFileSync(server.errPath, 'utf8');
      check(
        '発牌時に GM のヘルパーを無視したログがある',
        new RegExp('has no target player \\(id=' + info.gmUser + '\\)').test(
          log,
        ),
        '',
      );
      check(
        '自癒ログ（playing→waiting）がある',
        /is 'playing' but its game has never started/.test(log),
        '',
      );
    } else {
      check(
        '発牌時に GM のヘルパーを無視したログがある',
        false,
        'ログを読めません',
        true,
      );
      check(
        '自癒ログ（playing→waiting）がある',
        false,
        'ログを読めません',
        true,
      );
    }
  } finally {
    stopServer(server);
    if (roomid != null && !opts.keep) {
      console.log('=== 後片付け: 使い捨てデータを削除 ===');
      await withDb(url, async db => {
        const r = await db.collection('rooms').deleteMany({ id: roomid });
        const g = await db.collection('games').deleteMany({ id: roomid });
        const gl = await db
          .collection('gamelogs')
          .deleteMany({ gameid: roomid });
        const u = await db.collection('users').deleteMany({ userid: E2E_USER });
        console.log(
          '  削除: rooms=' +
            r.deletedCount +
            ' games=' +
            g.deletedCount +
            ' gamelogs=' +
            gl.deletedCount +
            ' users=' +
            u.deletedCount,
        );
      }).catch(e => console.error('  後片付けに失敗: ' + e.message));
    } else if (roomid != null) {
      console.log(
        '=== --keep のため検証データを残しました: room #' +
          roomid +
          ' / ' +
          E2E_USER +
          ' ===',
      );
    }
  }

  console.log('');
  console.log(
    failures === 0
      ? '*** E2E: すべて PASS ***'
      : '*** E2E: ' + failures + ' 件 FAIL ***',
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => {
  console.error('ERROR: ' + (e && e.message));
  process.exit(1);
});
