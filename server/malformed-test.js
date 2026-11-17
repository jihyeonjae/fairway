// 잘못된 메시지 테스트 (계획서 7절: 깨진 JSON, null, 배열, 숫자, 지나치게 긴 메시지)
// 사용법: 서버를 켠 상태에서 다른 창에서  node malformed-test.js
const WebSocket = require('ws');

const BASE = process.env.BASE || 'http://localhost:3000';
const WS_URL = BASE.replace(/^http/, 'ws');
const MAX_PAYLOAD = 16 * 1024; // index.js의 maxPayload와 같아야 한다
let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}  ${detail}`); }
}
function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.inbox = [];
    ws.closeCode = null;
    ws.on('message', (d) => { try { ws.inbox.push(JSON.parse(d)); } catch { /* 무시 */ } });
    ws.on('close', (code) => { ws.closeCode = code; });
    ws.on('error', () => { /* 서버가 끊을 때 나는 에러는 closeCode로 확인 */ });
    ws.on('open', () => resolve(ws));
    ws.once('error', reject);
  });
}
function waitFor(ws, pred, ms = 1500) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      const i = ws.inbox.findIndex(pred);
      if (i >= 0) return resolve(ws.inbox.splice(i, 1)[0]);
      if (Date.now() - start > ms) return resolve(null);
      setTimeout(tick, 30);
    };
    tick();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rest(method, path, rawBody) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json' }, body: rawBody });
  let json = null;
  try { json = await res.json(); } catch { /* JSON 아님 */ }
  return { status: res.status, json };
}
const errOf = async (ws) => (await waitFor(ws, (m) => m.type === 'error'))?.error;

async function main() {
  console.log(`대상 서버: ${BASE}\n`);

  console.log('[1] WS: JSON이 아닌 것');
  const ws = await connect();
  for (const [name, raw] of [['깨진 JSON', '{"type":"join",'], ['빈 문자열', ''], ['그냥 글자', 'hello'], ['JSON 뒤에 쓰레기', '{"type":"join"}xyz']]) {
    ws.send(raw);
    check(`${name} → BAD_JSON`, (await errOf(ws)) === 'BAD_JSON');
  }
  ws.send(Buffer.from([0xff, 0xfe, 0x00, 0x01]));
  check('바이너리 쓰레기 → BAD_JSON', (await errOf(ws)) === 'BAD_JSON');

  console.log('[2] WS: JSON이지만 { } 객체가 아닌 것');
  for (const [name, raw] of [['null', 'null'], ['빈 배열', '[]'], ['배열', '[{"type":"join"}]'], ['숫자', '42'], ['음수 소수', '-3.5'], ['문자열', '"join"'], ['true', 'true']]) {
    ws.send(raw);
    check(`${name} → BAD_MESSAGE`, (await errOf(ws)) === 'BAD_MESSAGE');
  }

  console.log('[3] WS: 객체지만 type이 이상한 것');
  for (const [name, raw] of [['빈 객체', '{}'], ['type 숫자', '{"type":1}'], ['type null', '{"type":null}'], ['모르는 type', '{"type":"hack"}'], ['type 객체', '{"type":{"a":1}}']]) {
    ws.send(raw);
    check(`${name} → UNKNOWN_TYPE`, (await errOf(ws)) === 'UNKNOWN_TYPE');
  }
  check('여기까지 연결 유지', ws.closeCode === null);

  console.log('[4] WS: 지나치게 긴 메시지 (최대 16KB)');
  const ok = await connect();
  const under = JSON.stringify({ type: 'hack', pad: 'x'.repeat(MAX_PAYLOAD - 100) });
  ok.send(under);
  check(`16KB 바로 아래(${under.length}바이트) → 정상 처리(UNKNOWN_TYPE), 연결 유지`, (await errOf(ok)) === 'UNKNOWN_TYPE' && ok.closeCode === null);
  const big = await connect();
  big.send(JSON.stringify({ type: 'join', pad: 'x'.repeat(MAX_PAYLOAD) }));
  await sleep(500);
  check('16KB 초과 → 서버가 close 1009로 끊음', big.closeCode === 1009, `closeCode=${big.closeCode}`);
  const huge = await connect();
  huge.send('x'.repeat(5 * 1024 * 1024));
  await sleep(800);
  check('5MB → close 1009', huge.closeCode === 1009, `closeCode=${huge.closeCode}`);
  ok.send('null');
  check('다른 연결은 영향 없음', (await errOf(ok)) === 'BAD_MESSAGE' && ok.closeCode === null);

  console.log('[5] REST: 잘못된 본문');
  check('깨진 JSON → 400 BAD_JSON', (await rest('POST', '/api/groups', '{"vehicleName":')).json?.error === 'BAD_JSON');
  check('본문 null → 400 BAD_JSON', (await rest('POST', '/api/groups', 'null')).json?.error === 'BAD_JSON');
  check('본문 숫자 → 400 BAD_JSON', (await rest('POST', '/api/groups', '42')).json?.error === 'BAD_JSON');
  const arr = await rest('POST', '/api/groups', '[{"vehicleName":"1호차"}]');
  check('본문 배열 → 400 MISSING_VEHICLE_NAME', arr.status === 400 && arr.json?.error === 'MISSING_VEHICLE_NAME', JSON.stringify(arr));
  const bigRest = await rest('POST', '/api/groups', JSON.stringify({ vehicleName: 'x'.repeat(200 * 1024) }));
  check('200KB 본문 → 413 PAYLOAD_TOO_LARGE', bigRest.status === 413 && bigRest.json?.error === 'PAYLOAD_TOO_LARGE', JSON.stringify(bigRest));

  console.log('[6] 서버 생존');
  check('/health ok', (await rest('GET', '/health')).json?.status === 'ok');

  for (const w of [ws, ok, big, huge]) w.terminate();
  console.log(`\n결과: ${pass}개 통과, ${fail}개 실패`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.log('❌ 테스트 중단:', e.message); process.exit(1); });
