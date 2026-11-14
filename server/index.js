const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());

// ── 메모리 저장소 (서버 끄면 사라짐) ──
const groups = new Map();      // groupId → 동행 정보
const codeToGroup = new Map(); // inviteCode → groupId (코드로 동행 찾기용)
let groupSeq = 0;              // g1, g2, ... 만들 때 쓰는 번호
let vehicleSeq = 0;            // v1, v2, ... 만들 때 쓰는 번호

// 6자리 코드 만들기. 이미 쓰는 코드면 다시 뽑는다
function newInviteCode() {
  let code;
  do {
    code = String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
  } while (codeToGroup.has(code));
  return code;
}

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── 동행 만들기 ──
app.post('/api/groups', (req, res) => {
  const vehicleName = req.body?.vehicleName;
  if (!vehicleName) {
    return res.status(400).json({ error: 'MISSING_VEHICLE_NAME', message: 'vehicleName이 필요합니다' });
  }

  const groupId = 'g' + (++groupSeq);
  const vehicleId = 'v' + (++vehicleSeq);
  const inviteCode = newInviteCode();

  groups.set(groupId, {
    groupId,
    inviteCode,
    createdAt: Date.now(),          // 30분 만료 계산에 씀 (다음 단계)
    hostVehicleId: vehicleId,       // 만든 차량 = 호스트
    vehicles: new Map([[vehicleId, { vehicleId, vehicleName }]]),
  });
  codeToGroup.set(inviteCode, groupId);

  res.json({ groupId, inviteCode, vehicleId });
});

app.listen(3000, '0.0.0.0', () => console.log('서버 시작!'));
