const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());

// ── 메모리 저장소 (서버 끄면 사라짐) ──
const groups = new Map();      // groupId → 동행 정보
const codeToGroup = new Map(); // inviteCode → groupId (코드로 동행 찾기용)
let groupSeq = 0;              // g1, g2, ... 만들 때 쓰는 번호
let vehicleSeq = 0;            // v1, v2, ... 동행이 달라도 서버 전체에서 겹치지 않음

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
  const vehicleName = req.body?.vehicleName; // ?. = body가 없어도 에러 없이 undefined
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

// ── 참가 규칙 (계획서 가정값) ──
const CODE_TTL_MS = 30 * 60 * 1000; // 코드 유효시간 30분 (가정)
const MAX_VEHICLES = 5;             // 동행 최대 5대 (가정)

// 동행 안 차량들의 이름만 뽑아서 배열로: ["1호차", "2호차"]
function vehicleNames(group) {
  return [...group.vehicles.values()].map(v => v.vehicleName);
}

// ── 동행 참가하기 ──
app.post('/api/groups/join', (req, res) => {
  const inviteCode = req.body?.inviteCode;
  const vehicleName = req.body?.vehicleName;
  if (!vehicleName) {
    return res.status(400).json({ error: 'MISSING_VEHICLE_NAME', message: 'vehicleName이 필요합니다' });
  }

  // 코드로 동행 찾기
  const groupId = codeToGroup.get(String(inviteCode));
  const group = groups.get(groupId);
  if (!group) {
    return res.status(404).json({ error: 'INVALID_CODE', message: '없는 참가 코드입니다' });
  }
  if (Date.now() - group.createdAt > CODE_TTL_MS) {
    return res.status(410).json({ error: 'CODE_EXPIRED', message: '참가 코드 유효시간이 지났습니다' });
  }
  if (group.vehicles.size >= MAX_VEHICLES) {
    return res.status(409).json({ error: 'GROUP_FULL', message: `동행은 최대 ${MAX_VEHICLES}대까지입니다` });
  }

  // 통과하면 참가 목록에 추가
  const vehicleId = 'v' + (++vehicleSeq);
  group.vehicles.set(vehicleId, { vehicleId, vehicleName });

  res.json({ groupId, vehicleId, vehicles: vehicleNames(group) });
});

// ── 참가 차량 목록 보기 ──
app.get('/api/groups/:groupId', (req, res) => {
  const group = groups.get(req.params.groupId);
  if (!group) {
    return res.status(404).json({ error: 'GROUP_NOT_FOUND', message: '없는 동행입니다' });
  }
  res.json({ groupId: group.groupId, vehicles: vehicleNames(group) });
});

app.listen(3000, '0.0.0.0', () => console.log('서버 시작!'));
