#!/usr/bin/env node
/**
 * 月下人狼（jinrou）通用 RPC 客户端
 * ==================================
 * Web 版客户端通过 socketstream（engine.io 轮询）调用 server/rpc 下的任意 RPC 方法。
 * 本脚本在 Node 里复现这套协议，用于抓取房间/对局数据、复现和调试 RPC 行为。
 *
 * 用法:
 *   node tool/rpc.js <RPC方法> [位置参数...] [选项]
 *
 * 例:
 *   node tool/rpc.js game.rooms.oneRoom 397032
 *   node tool/rpc.js game.game.getlog 397032 --out=log.json --pretty
 *   node tool/rpc.js game.rooms.getRooms waiting 1
 *   node tool/rpc.js game.game.getlog --params='[397032]' --raw
 *
 * 选项:
 *   --params=<json>       RPC 参数（JSON 数组或单值；优先于位置参数）
 *   --room=<id>           取 session cookie 用的房间页（默认: 位置参数中的数字，否则 /）
 *   --host=<host>         连接主机（默认取自 config/app.coffee，可用 JINRO_HOST 覆盖）
 *   --port=<n>            连接端口（默认取自 config/app.coffee 里 URL 的端口）
 *   --scheme=<http|https> 协议（默认取自 config/app.coffee）
 *   --out=<path>          把结果写入文件（UTF-8）
 *   --pretty              输出/保存时做 JSON 缩进
 *   --raw                 不拆包，直接输出服务端返回的原始 JSON（{id,p,e}）
 *   --preview=<n>         控制台预览字符数（默认 2000，0 表示全部输出）
 *   --timeout=<ms>        长轮询超时（默认 40000）
 *   --help
 *
 * 已知约束（与浏览器客户端一致）:
 *   * socketstream 的 responder id: 事件 = 0 / RPC = 1
 *   * engine.io 为 0.x（协议 v2），payload 是「<长度>:<包」的拼接
 *   * 连接需要 connect.sid 这个 session cookie（脚本会先请求页面拿 cookie）
 *   * 未结束的房间多半需要登录/已入室权限；已结束的房间一般可直接读取
 */
'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

// socketstream：事件通道是 0，RPC 通道是 1
const RPC_RESPONDER_ID = '1';

// 连接目标默认取自 config/app.coffee 的 application.url。
// 找不到 config 就退回 config.default，再不行才用兜底值。
// 覆盖顺序：命令行 --host/--port/--scheme > 环境变量 JINRO_HOST > config。
const FALLBACK_TARGET = { scheme: 'https', host: 'www.werewolf.com.cn', port: null };

// 读取配置里的 application.url（config 是 CoffeeScript，所以先加载编译器）
function loadConfiguredUrl() {
  try {
    require('coffee-script/register');
  } catch (e) {
    return null; // 没有编译器就只用兜底值
  }
  for (const relative of ['../config/app.coffee', '../config.default/app.coffee']) {
    try {
      const config = require(path.join(__dirname, relative));
      const url = config && config.application && config.application.url;
      if (url) {
        return url;
      }
    } catch (e) {
      // 换下一个候选
    }
  }
  return null;
}

// "https://example.com/" → {scheme, host, port}
function parseUrlTarget(url) {
  if (!url) {
    return null;
  }
  try {
    const parsed = new URL(url);
    return {
      scheme: parsed.protocol === 'http:' ? 'http' : 'https',
      host: parsed.hostname,
      port: parsed.port ? parseInt(parsed.port, 10) : null,
    };
  } catch (e) {
    return null;
  }
}

// "example.com"、"example.com:8800"、"http://example.com/" 都接受
function parseHostSpec(spec) {
  if (!spec) {
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(spec)) {
    return parseUrlTarget(spec);
  }
  const matched = /^([^:/]+)(?::(\d+))?$/.exec(spec);
  if (!matched) {
    return null;
  }
  return { host: matched[1], port: matched[2] ? parseInt(matched[2], 10) : null };
}

// 优先级：命令行 > JINRO_HOST > config > 兜底值
const CONFIG_TARGET = parseUrlTarget(loadConfiguredUrl()) || FALLBACK_TARGET;
const DEFAULT_TARGET = Object.assign({}, CONFIG_TARGET, parseHostSpec(process.env.JINRO_HOST) || {});

// 出错提示里显示的目标
function targetLabel(target) {
  return target.scheme + '://' + target.host + (target.port ? ':' + target.port : '');
}

const USAGE = `用法: node tool/rpc.js <RPC方法> [位置参数...] [选项]

例:
  node tool/rpc.js game.rooms.oneRoom 397032
  node tool/rpc.js game.game.getlog 397032 --out=log.json --pretty
  node tool/rpc.js game.rooms.getRooms waiting 1
  node tool/rpc.js game.game.getlog --params='[397032]' --raw

选项:
  --params=<json>       RPC 参数（JSON 数组或单值；优先于位置参数）
  --room=<id>           取 session cookie 用的房间页
  --host=<host>         连接主机（默认取自 config/app.coffee，可用 JINRO_HOST 覆盖）
  --port=<n>            连接端口（默认取自 config 中 URL 的端口）
  --scheme=<http|https> 协议（默认取自 config/app.coffee）
  --out=<path>          结果写入文件
  --pretty              JSON 缩进
  --raw                 输出原始响应（{id,p,e}）
  --preview=<n>         控制台预览字符数（默认 2000，0=全部）
  --timeout=<ms>        长轮询超时（默认 40000）
  --help

当前默认目标: ${targetLabel(DEFAULT_TARGET)}
`;

// "123" → 123、"true" → true、"[1,2]" → [1,2]，其它情况原样保留为字符串
function coerce(value) {
  try {
    return JSON.parse(value);
  } catch (e) {
    return value;
  }
}

function parseArgs(argv) {
  const opts = {
    help: false,
    method: null,
    params: null,
    room: null,
    host: DEFAULT_TARGET.host,
    port: DEFAULT_TARGET.port,
    scheme: DEFAULT_TARGET.scheme,
    out: null,
    pretty: false,
    raw: false,
    preview: 2000,
    timeout: 40000,
  };
  const positional = [];
  for (const arg of argv) {
    const eq = arg.indexOf('=');
    const key = eq >= 0 ? arg.slice(0, eq) : arg;
    const value = eq >= 0 ? arg.slice(eq + 1) : null;
    switch (key) {
      case '--help':
      case '-h':
        opts.help = true;
        break;
      case '--pretty':
        opts.pretty = true;
        break;
      case '--raw':
        opts.raw = true;
        break;
      case '--params':
        opts.params = coerce(value);
        break;
      case '--room':
        opts.room = value;
        break;
      case '--host': {
        const spec = parseHostSpec(value);
        if (spec) {
          if (spec.host) {
            opts.host = spec.host;
          }
          if (spec.port != null) {
            opts.port = spec.port;
          }
          if (spec.scheme) {
            opts.scheme = spec.scheme;
          }
        }
        break;
      }
      case '--port':
        opts.port = parseInt(value, 10) || null;
        break;
      case '--scheme':
        opts.scheme = value === 'http' ? 'http' : 'https';
        break;
      case '--out':
        opts.out = value;
        break;
      case '--preview':
        opts.preview = parseInt(value, 10);
        break;
      case '--timeout':
        opts.timeout = parseInt(value, 10);
        break;
      default:
        positional.push(arg);
    }
  }
  opts.method = positional[0] || null;
  const params = positional.slice(1).map(coerce);
  if (opts.params == null) {
    opts.params = params;
  } else if (!Array.isArray(opts.params)) {
    opts.params = [opts.params];
  }
  if (opts.room == null && typeof params[0] === 'number') {
    opts.room = String(params[0]);
  }
  return opts;
}

function request(opts, method, path, options) {
  options = options || {};
  const lib = opts.scheme === 'http' ? http : https;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        host: opts.host,
        port: opts.port || undefined,
        method,
        path,
        headers: options.headers || {},
      },
      res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
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
    if (options.timeout) {
      req.setTimeout(options.timeout, () =>
        req.destroy(new Error('请求超时（' + options.timeout + 'ms）')),
      );
    }
    if (options.body != null) {
      req.write(options.body);
    }
    req.end();
  });
}

// engine.io（协议 v2）的 payload 是「<长度>:<包」的重复拼接
function frame(packet) {
  return Buffer.byteLength(packet, 'utf8') + ':' + packet;
}

function decodePackets(payload) {
  const packets = [];
  let rest = payload;
  while (rest.length > 0) {
    const sep = rest.indexOf(':');
    if (sep < 0) {
      break;
    }
    const length = parseInt(rest.slice(0, sep), 10);
    if (!Number.isFinite(length)) {
      break;
    }
    packets.push(rest.slice(sep + 1, sep + 1 + length));
    rest = rest.slice(sep + 1 + length);
  }
  return packets;
}

// 先 GET 一次页面拿到 connect.sid（socketstream 的连接需要它）
async function openSession(opts) {
  const paths = [];
  if (opts.room != null) {
    paths.push('/room/' + opts.room);
  }
  paths.push('/');
  let cookie = '';
  for (const path of paths) {
    try {
      const page = await request(opts, 'GET', path, { timeout: opts.timeout });
      cookie = (page.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
      if (cookie) {
        break;
      }
    } catch (e) {
      // 换下一个候选
    }
  }
  if (!cookie) {
    throw new Error('取不到 session cookie（connect.sid），请确认 ' + targetLabel(opts) + ' 可以访问');
  }

  const handshake = await request(
    opts,
    'GET',
    '/engine.io/?EIO=3&transport=polling&t=' + Date.now(),
    { headers: { Cookie: cookie }, timeout: opts.timeout },
  );
  if (handshake.status !== 200) {
    throw new Error(
      'engine.io 握手失败: HTTP ' + handshake.status + ' ' + handshake.body.slice(0, 200),
    );
  }
  const matched = /"sid":"([^"]+)"/.exec(handshake.body);
  if (!matched) {
    throw new Error('握手响应里没有 sid: ' + handshake.body.slice(0, 200));
  }
  return { cookie, sid: matched[1] };
}

// 调用一次 RPC，返回 socketstream 的响应 JSON（{id,p,e}）
async function callRpc(opts, session, method, params) {
  const cookieHeader = { Cookie: session.cookie };
  const url = () =>
    '/engine.io/?EIO=3&transport=polling&sid=' + session.sid + '&t=' + Date.now();
  const send = packet =>
    request(opts, 'POST', url(), {
      headers: Object.assign({ 'Content-Type': 'text/plain;charset=UTF-8' }, cookieHeader),
      body: frame('4' + packet),
      timeout: opts.timeout,
    });
  const poll = () => request(opts, 'GET', url(), { headers: cookieHeader, timeout: opts.timeout });

  // 和浏览器一样：先挂起长轮询，再发送 POST
  let pending = poll();
  await new Promise(resolve => setTimeout(resolve, 300));

  const post = await send(
    RPC_RESPONDER_ID + '|' + JSON.stringify({ m: method, id: 1, p: params }),
  );
  if (post.status !== 200) {
    throw new Error('POST 失败: HTTP ' + post.status + ' ' + post.body.slice(0, 200));
  }

  for (let attempt = 0; attempt < 20; attempt++) {
    let res;
    try {
      res = await pending;
    } catch (e) {
      throw new Error('轮询失败: ' + e.message);
    }
    if (res.status !== 200) {
      throw new Error('轮询失败: HTTP ' + res.status + ' ' + res.body.slice(0, 200));
    }
    for (const packet of decodePackets(res.body)) {
      if (packet[0] === '2') {
        // ping → pong（不回 pong 会被服务端断开）
        await send('3');
        continue;
      }
      if (packet[0] !== '4') {
        continue; // 0=open、1=close、3=pong 这些包直接忽略
      }
      const message = packet.slice(1);
      const sep = message.indexOf('|');
      if (sep < 0) {
        continue;
      }
      const responderId = message.slice(0, sep);
      const content = message.slice(sep + 1);
      if (responderId !== RPC_RESPONDER_ID) {
        continue; // X=连接成功，0=事件等，都不是我们要的应答
      }
      try {
        return JSON.parse(content);
      } catch (e) {
        throw new Error('应答不是合法 JSON: ' + content.slice(0, 200));
      }
    }
    pending = poll();
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('没有收到 RPC 应答（请检查方法名和 responder id）');
}

// socketstream 的应答是 {id, p: [结果], e: 错误}，这里只取出结果
function unwrap(reply) {
  if (reply && reply.e) {
    throw new Error('RPC 错误: ' + (reply.e.message || JSON.stringify(reply.e)));
  }
  const p = reply ? reply.p : undefined;
  if (Array.isArray(p) && p.length === 1) {
    return p[0];
  }
  return p;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.method) {
    console.log(USAGE);
    process.exit(opts.help ? 0 : 1);
  }
  const session = await openSession(opts);
  const reply = await callRpc(opts, session, opts.method, opts.params);
  const result = opts.raw ? reply : unwrap(reply);
  const json = opts.pretty ? JSON.stringify(result, null, 2) : JSON.stringify(result);

  if (opts.out) {
    fs.writeFileSync(opts.out, json, 'utf8');
    console.log('已保存: ' + opts.out + '（' + json.length + ' 字符）');
  }
  if (opts.preview > 0 && json.length > opts.preview) {
    console.log(json.slice(0, opts.preview) + ' ...（已截断，共 ' + json.length + ' 字符）');
  } else {
    console.log(json);
  }
}

main().catch(e => {
  console.error('错误: ' + ((e && e.message) || e));
  process.exit(1);
});
