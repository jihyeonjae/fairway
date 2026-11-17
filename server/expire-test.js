// 참가 코드 만료 테스트
// 사용법: 서버를  CODE_TTL_MS=2000 node index.js  로 켠 뒤 다른 창에서  node expire-test.js
// 끝나면 서버를 끄고 그냥  node index.js  로 다시 켤 것 (2초인 채로 e2e-test.js를 돌리면 실패함)
const BASE = process.env.BASE || 'http://localhost:3000';
const WAIT_MS = Number(process.env.WAIT_MS) || 2500; // 서버 TTL보다 조금 길게

const post = (p, b) => fetch(BASE + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
}).then(async (r) => ({ status: r.status, json: await r.json() }));

(async () => {
  const c = await post('/api/groups', { vehicleName: '1호차' });
  const fresh = await post('/api/groups/join', { inviteCode: c.json.inviteCode, vehicleName: '2호차' });
  const freshOk = fresh.status === 200;
  console.log(freshOk ? '✅ 발급 직후 참가 성공' : '❌ 발급 직후 참가 실패 ' + JSON.stringify(fresh.json));

  await new Promise((r) => setTimeout(r, WAIT_MS));
  const late = await post('/api/groups/join', { inviteCode: c.json.inviteCode, vehicleName: '3호차' });
  const lateOk = late.status === 410 && late.json.error === 'CODE_EXPIRED';
  console.log(lateOk ? '✅ 만료 코드 거절 (410 CODE_EXPIRED)' : '❌ 만료 안 됨 ' + JSON.stringify(late.json)
    + '\n   → 서버를 CODE_TTL_MS=2000 으로 켰는지 확인');
  process.exit(freshOk && lateOk ? 0 : 1);
})().catch((e) => { console.log('❌ 서버 연결 실패:', e.message); process.exit(1); });
