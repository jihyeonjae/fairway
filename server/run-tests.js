// npm test 진입점: 테스트마다 필요한 설정으로 서버를 따로 켜고, 테스트를 돌린 뒤 끈다
// 사용법: server 폴더에서  npm test
// 이미 켜 둔 서버(3000번)와 겹치지 않게 3901번부터 쓴다
const { spawn } = require('child_process');
const path = require('path');

const SUITES = [
  { file: 'e2e-test.js', env: {} },
  { file: 'expire-test.js', env: { CODE_TTL_MS: '2000' } },
  { file: 'location-test.js', env: {} },
  { file: 'hazard-test.js', env: {} },
  { file: 'lifecycle-test.js', env: { DEBUG_STATS: '1' } },
  { file: 'lifecycle-expire-test.js', env: { DEBUG_STATS: '1', GROUP_TTL_MS: '1500', CODE_TTL_MS: '600', SWEEP_INTERVAL_MS: '200' } },
];
const BASE_PORT = Number(process.env.TEST_BASE_PORT) || 3901;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealthy(base, ms = 5000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try { if ((await fetch(base + '/health')).ok) return true; } catch { /* 아직 안 켜짐 */ }
    await sleep(100);
  }
  return false;
}

function run(cmd, args, env) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: __dirname, env: { ...process.env, ...env }, stdio: 'inherit' });
    p.on('exit', (code) => resolve(code));
  });
}

(async () => {
  const results = [];
  for (let i = 0; i < SUITES.length; i++) {
    const { file, env } = SUITES[i];
    const port = String(BASE_PORT + i);
    const base = `http://localhost:${port}`;
    console.log(`\n━━━ ${file} (포트 ${port}${Object.keys(env).length ? ', ' + Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ') : ''}) ━━━`);
    // env/.env 값보다 여기 값이 우선하도록 환경변수로 넘긴다
    const server = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
      cwd: __dirname, env: { ...process.env, ...env, SERVER_PORT: port }, stdio: ['ignore', 'ignore', 'inherit'],
    });
    if (!(await waitHealthy(base))) {
      console.log(`❌ 서버가 켜지지 않음 (포트 ${port})`);
      server.kill();
      results.push([file, 1]);
      continue;
    }
    const code = await run(process.execPath, [file], { BASE: base });
    server.kill();
    await new Promise((r) => server.on('exit', r));
    results.push([file, code]);
  }
  console.log('\n━━━ 요약 ━━━');
  for (const [file, code] of results) console.log(`${code === 0 ? '✅' : '❌'} ${file}`);
  const failed = results.filter(([, c]) => c !== 0).length;
  console.log(failed ? `\n${failed}개 묶음 실패` : '\n전부 통과');
  process.exit(failed ? 1 : 0);
})();
