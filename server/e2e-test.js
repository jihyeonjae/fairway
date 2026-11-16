// 처음부터 끝까지 한 번에 확인하는 테스트 (11.14 계획서 체크리스트 + 리더 요구 2건 + 11.16 재연결·중복 참가)
// 사용법: 서버를 켠 상태에서 다른 창에서  node e2e-test.js
// 다른 PC의 서버를 확인하려면:  BASE=http://<IP>:3000 node e2e-test.js
const WebSocket = require('ws');

const BASE = process.env.BASE || 'http://localhost:3000';
const WS_URL = BASE.replace(/^http/, 'ws');
let pass = 0;
let fail = 0;

function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}  ${detail}`); }
}

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  let json = null;
  try { json = await res.json(); } catch { /* JSON 아님 */ }
  return { status: res.status, json };
}

// WebSocket 연결 하나를 열고, 받은 메시지를 모아두는 도우미
function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.inbox = [];
    ws.on('message', (d) => { try { ws.inbox.push(JSON.parse(d)); } catch { /* 무시 */ } });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}
const sendJson = (ws, obj) => ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));

// 조건에 맞는 메시지가 올 때까지 기다림 (못 받으면 null)
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

async function main() {
  console.log(`대상 서버: ${BASE}\n`);

  console.log('[1] 서버 실행');
  const h = await api('GET', '/health').catch(() => null);
  check('GET /health → ok', h && h.json?.status === 'ok', '서버가 켜져 있는지 확인하세요');
  if (!h) return;

  console.log('[2] 동행 만들기');
  const c = await api('POST', '/api/groups', { vehicleName: '1호차' });
  const code = c.json?.inviteCode;
  check('6자리 문자열 코드 발급', typeof code === 'string' && /^\d{6}$/.test(code), JSON.stringify(c.json));
  const g = c.json?.groupId;
  const v1 = c.json?.vehicleId;

  console.log('[3] 코드로 참가');
  const j = await api('POST', '/api/groups/join', { inviteCode: code, vehicleName: '2호차' });
  const v2 = j.json?.vehicleId;
  check('2호차 참가 성공', j.status === 200 && j.json?.vehicles?.length === 2, JSON.stringify(j.json));

  console.log('[4] 틀린 코드');
  const wrong = await api('POST', '/api/groups/join', { inviteCode: 'ABCDEF', vehicleName: 'x' });
  check('INVALID_CODE (404)', wrong.status === 404 && wrong.json?.error === 'INVALID_CODE', JSON.stringify(wrong.json));

  console.log('[5] 참가 목록');
  const list = await api('GET', `/api/groups/${g}`);
  check('목록 = 1호차, 2호차', JSON.stringify(list.json?.vehicles) === '["1호차","2호차"]', JSON.stringify(list.json));

  console.log('[6] WebSocket 실시간 명단');
  const A = await connect();
  const B = await connect();
  sendJson(A, { type: 'join', groupId: g, vehicleId: v1 });
  sendJson(B, { type: 'join', groupId: g, vehicleId: v2 });
  check('A: join 직후 명단 수신', !!(await waitFor(A, (m) => m.type === 'group_state')));
  check('B: join 직후 명단 수신', !!(await waitFor(B, (m) => m.type === 'group_state')));
  await api('POST', '/api/groups/join', { inviteCode: code, vehicleName: '3호차' });
  const ga = await waitFor(A, (m) => m.type === 'group_state' && m.vehicles?.length === 3);
  const gb = await waitFor(B, (m) => m.type === 'group_state' && m.vehicles?.length === 3);
  check('3호차 참가 → A·B 둘 다 새 명단', !!ga && !!gb);
  check('group_state에 groupId 포함', ga?.groupId === g);

  console.log('[7] 연습용 차량 상태');
  sendJson(B, { type: 'vehicle_status', data: { ready: true } });
  const st = await waitFor(A, (m) => m.type === 'vehicle_status_updated');
  check('B ready → A 수신', st?.data?.ready === true && st?.vehicleName === '2호차', JSON.stringify(st));
  check('data에 warning 기본값 NONE 채워짐', st?.data?.warning === 'NONE');
  check('보낸 B는 자기 상태 안 받음', !(await waitFor(B, (m) => m.type === 'vehicle_status_updated', 400)));

  console.log('[리더 요구 1] 잘못된 값 → 토스트용 에러, 서버 유지');
  sendJson(B, { type: 'vehicle_status', data: { ready: 'yes' } });
  check('B: BAD_STATUS 에러 받음', (await waitFor(B, (m) => m.type === 'error'))?.error === 'BAD_STATUS');
  check('A: 잘못된 값 안 받음', !(await waitFor(A, (m) => m.type === 'vehicle_status_updated', 400)));
  const T = await connect();
  sendJson(T, 'null');
  check('WS null → BAD_MESSAGE', (await waitFor(T, (m) => m.type === 'error'))?.error === 'BAD_MESSAGE');
  const badRest = await api('POST', '/api/groups', '{bad');
  check('REST 깨진 JSON → JSON 에러', badRest.json?.error === 'BAD_JSON');
  T.close();
  await sleep(200);
  check('서버 계속 살아있음', (await api('GET', '/health').catch(() => null))?.json?.status === 'ok');

  console.log('[리더 요구 2] 방 바꾸면 이전 방 소식 안 옴');
  const c2 = await api('POST', '/api/groups', { vehicleName: 'B방장' });
  const j2 = await api('POST', '/api/groups/join', { inviteCode: c2.json.inviteCode, vehicleName: '1호차' });
  A.inbox.length = 0;
  sendJson(A, { type: 'join', groupId: c2.json.groupId, vehicleId: j2.json.vehicleId });
  await waitFor(A, (m) => m.type === 'group_state' && m.groupId === c2.json.groupId);
  await api('POST', '/api/groups/join', { inviteCode: code, vehicleName: '4호차' }); // 이전 방에 새 차
  check('이전 방 소식 안 옴', !(await waitFor(A, (m) => m.groupId === g, 500)));
  await api('POST', '/api/groups/join', { inviteCode: c2.json.inviteCode, vehicleName: 'B새차' });
  check('새 방 소식은 옴', !!(await waitFor(A, (m) => m.type === 'group_state' && m.groupId === c2.json.groupId)));

  console.log('[8] 끊고 다시 연결');
  const A2 = await connect();
  sendJson(A2, { type: 'join', groupId: g, vehicleId: v1 });
  check('재연결: 명단 다시 받음', !!(await waitFor(A2, (m) => m.type === 'group_state' && m.groupId === g)));
  const last = await waitFor(A2, (m) => m.type === 'vehicle_status_updated' && m.vehicleId === v2);
  check('재연결: 2호차 마지막 상태(ready=true) 받음', last?.data?.ready === true, JSON.stringify(last));

  console.log('[9] 같은 차량 중복 연결');
  B.closeCode = null;
  B.on('close', (code) => { B.closeCode = code; });
  const B2 = await connect();
  sendJson(B2, { type: 'join', groupId: g, vehicleId: v2 });
  await waitFor(B2, (m) => m.type === 'group_state');
  check('예전 B 연결은 REPLACED 받음', !!(await waitFor(B, (m) => m.type === 'error' && m.error === 'REPLACED')));
  await sleep(200);
  check('예전 B 연결은 close 코드 4000으로 끊김', B.closeCode === 4000, String(B.closeCode));
  sendJson(B2, { type: 'vehicle_status', data: { ready: false } });
  const st2 = await waitFor(A2, (m) => m.type === 'vehicle_status_updated' && m.vehicleId === v2);
  check('새 B2 상태가 A2로 전달', st2?.data?.ready === false, JSON.stringify(st2));

  console.log('[10] 이름 검사');
  const dup = await api('POST', '/api/groups/join', { inviteCode: code, vehicleName: '2호차' });
  check('같은 이름 → DUPLICATE_NAME (409)', dup.status === 409 && dup.json?.error === 'DUPLICATE_NAME', JSON.stringify(dup.json));
  const dupSpace = await api('POST', '/api/groups/join', { inviteCode: code, vehicleName: ' 2호차 ' });
  check('앞뒤 공백 붙여도 같은 이름으로 거절', dupSpace.json?.error === 'DUPLICATE_NAME', JSON.stringify(dupSpace.json));
  const numName = await api('POST', '/api/groups', { vehicleName: 123 });
  check('문자열 아닌 이름 → 400', numName.status === 400 && numName.json?.error === 'MISSING_VEHICLE_NAME', JSON.stringify(numName.json));
  const longName = await api('POST', '/api/groups', { vehicleName: 'x'.repeat(21) });
  check('21자 이름 → 400', longName.status === 400, JSON.stringify(longName.json));

  A.close();
  A2.close();
  B2.close();
}

main()
  .catch((e) => { fail++; console.log('  ❌ 테스트 중 에러:', e.message); })
  .finally(() => {
    console.log(`\n결과: ${pass}개 통과, ${fail}개 실패`);
    process.exit(fail ? 1 : 0);
  });
