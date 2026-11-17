# 앱 ↔ 서버 메시지 규격 (1차)

출처: 팀장 작성 「11.14 계획」(2026-11-14). 이전 규격(설계 v3 기반 `/sessions`)을 대체한다.
모든 메시지는 JSON. "가정" = 출처 없는 초기값. "제안" = 계획서에 없어서 임시로 정한 값, 팀 확정 필요.

## REST
기본 주소: `http://<서버 IP>:3000` (포트는 서버 `SERVER_PORT`, 기본 3000) (에뮬레이터에선 localhost 대신 서버 PC IP. 에뮬레이터가 서버와 같은 PC에서 돌면 `10.0.2.2:3000`. Pleos Connect v2.1.0 에뮬레이터에서 `/health` 응답 확인됨, 2026-11-16)
- 안드로이드는 기본적으로 http 평문 통신을 막는다 → 앱에 `usesCleartextTraffic="true"` 또는 network security config 필요

| 메서드 · 경로 | 요청 | 응답 |
| --- | --- | --- |
| GET /health | - | `{"status":"ok"}` |
| POST /api/groups | `{"vehicleName":"1호차"}` | `{"groupId":"g1","inviteCode":"384271","vehicleId":"v1"}` |
| POST /api/groups/join | `{"inviteCode":"384271","vehicleName":"2호차"}` | `{"groupId":"g1","vehicleId":"v2","vehicles":["1호차","2호차"]}` |
| GET /api/groups/:groupId | - | `{"groupId":"g1","vehicles":["1호차","2호차"]}` (제안) |

- groupId·vehicleId: 서버가 만드는 **무작위 문자열**(예: `g3f9a1c0b7e2d`, `v74890ffb19a5`). 표의 `g1`·`v1`은 설명용 예시다. 앱은 형식·길이에 의존하지 말고 받은 문자열을 그대로 저장한다. 서버를 재시작하면 예전 ID는 모두 무효가 된다(`NOT_A_MEMBER`)
- inviteCode: 무작위 6자리 숫자. 사용 중인 코드와 겹치면 다시 뽑는다. **문자열**로 주고받는다 (`"012345"`처럼 0으로 시작할 수 있어 숫자로 바꾸면 앞자리 0이 사라짐).
- 동행을 만든 차량이 호스트이며 참가 목록에 바로 들어간다.
- 참가 거절 조건
  - 없는 코드
  - 만료된 코드: 발급 후 30분 (가정). 서버 환경변수 `CODE_TTL_MS`로 변경 가능 (테스트용)
  - 인원 초과: 최대 5대 (가정)
- 거절 응답 형식 (제안): HTTP 4xx + `{"error":"<코드>","message":"<설명>"}`
  - 404 `INVALID_CODE` / 410 `CODE_EXPIRED` / 409 `GROUP_FULL`
  - 400 `MISSING_VEHICLE_NAME`: vehicleName이 없거나, 문자열이 아니거나, 앞뒤 공백을 뺀 길이가 1~20자가 아닐 때 (20자는 가정)
  - 409 `DUPLICATE_NAME`: 같은 동행에 같은 이름이 이미 있을 때. 앞뒤 공백은 무시하고 비교 (`"2호차 "` = `"2호차"`)
- vehicleName은 서버가 앞뒤 공백을 지운 값으로 저장한다
- **앱은 참가 성공 시 받은 `groupId`·`vehicleId`를 로컬(SharedPreferences 등)에 저장한다.** 앱을 재시작하면 REST로 다시 참가하지 말고 저장한 값으로 WS `join`만 다시 보낸다 (같은 이름으로 REST 재참가하면 `DUPLICATE_NAME`)
  - 400 `BAD_JSON`: 요청 본문이 JSON이 아닐 때 / 500 `SERVER_ERROR`: 서버 내부 오류 (제안)
  - 404 `GROUP_NOT_FOUND`: GET /api/groups/:groupId 에서 없는 groupId (제안)

## WebSocket
접속 주소 (제안): `ws://<서버 IP>:3000` — REST와 같은 서버·포트
공통 형식: `{"type":"<타입>", ...}`

| 방향 | type | 필드 | 보내는 때 |
| --- | --- | --- | --- |
| 앱→서버 | `join` | groupId, vehicleId | 연결 직후. 실시간 알림 등록용이며 동행 참가 자체는 REST join이 담당 |
| 앱→서버 | `leave` | - | 방을 나가거나 바꿀 때. 알림만 끊고 동행 명단에서는 빼지 않음 |
| 서버→앱 | `group_state` | groupId, vehicles | 참가 차량 목록이 바뀔 때 해당 동행 연결 전체에 |
| 서버→앱 | `group_state` | groupId, vehicles | `join` 직후 그 연결에 1회 (현재 명단, 제안) |
| 서버→앱 | `error` | error, message | 잘못된 메시지를 보낸 연결에만. `BAD_JSON` / `BAD_MESSAGE`(객체가 아님) / `NOT_A_MEMBER`(REST 참가 안 한 vehicleId) / `REPLACED`(같은 차량이 새로 연결돼 이 연결이 끊김) / `NOT_JOINED` / `BAD_STATUS` / `BAD_LOCATION` / `LOCATION_TOO_OLD` / `LOCATION_FROM_FUTURE` / `RATE_LIMITED` / `UNKNOWN_TYPE` / `SERVER_ERROR` (제안). 앱은 message를 토스트로 표시 |
| 앱→서버 | `vehicle_status` | data `{ready?, warning?}`, vehicleId(생략 가능) | 상태 변경 시. 보낸 칸만 갱신 |
| 서버→앱 | `vehicle_status_updated` | groupId, vehicleId, vehicleName, data `{ready, warning}` | 다른 차량이 vehicle_status를 보냈을 때 같은 동행의 **보낸 차량 제외** 전체에. `join` 직후에도 다른 차들의 마지막 상태를 1회씩 |
| 앱→서버 | `location` | data `{lat, lng, heading, speed, accuracy, timestamp}`, vehicleId(생략 가능) | **1초마다. 서 있어도 보냄** |
| 서버→앱 | `vehicle_location_updated` | groupId, vehicleId, vehicleName, data `{lat, lng, heading, speed, accuracy, measuredAt, receivedAt}` | 같은 동행의 **보낸 차량 제외** 전체에. `join` 직후에도 다른 차들의 최근 60초 안 위치를 1회씩 |

- 1차의 `ready`/`warning`은 **연습용 값**이다 (예: `ready:true`, `warning:"NONE"`). 차량 SDK에서 읽은 값이 아니다.
- `vehicle_status` 검사 (실패 시 보낸 연결에만 `error`, 다른 차로는 안 퍼짐)
  - `NOT_JOINED`: join 전이거나 leave 후에 보냄
  - `BAD_STATUS`: data가 객체가 아님 / ready가 true·false가 아님 / warning이 대문자 코드(`A-Z 0-9 _`, 32자 이하)가 아님 / 둘 다 없음 / 메시지의 vehicleId가 join한 차량과 다름
  - `RATE_LIMITED`: 한 연결이 1초에 20번 넘게 보냄 (가정)
  - ready·warning 외의 칸은 버리고 전달하지 않는다
- `vehicle_status_updated.data`에는 **항상 `ready`와 `warning`이 둘 다** 들어 있다. 아직 안 보낸 칸은 기본값(`ready:false`, `warning:"NONE"`)으로 서버가 채운다
- 보낸 차량은 자기 상태를 돌려받지 않는다 (앱이 자기 화면은 직접 갱신)
- 메시지 1개 최대 16KB. 넘으면 서버가 연결을 끊는다 (close 코드 1009)
- 연결이 끊겨도 동행에서 바로 빼지 않는다.
- 같은 vehicleId로 새 연결이 `join`하면 예전 연결에 `error`(`REPLACED`)를 보내고 **close 코드 4000**으로 끊는다.
  - **앱은 close 코드 4000이면 자동 재연결하지 않는다.** 두 곳(예: 앱과 테스트 도구)이 같은 차량으로 자동 재연결하면 서로 끊는 무한 반복이 생긴다. "다른 곳에서 연결됨"을 안내한다
- 한 연결로 다른 동행에 `join`하면 이전 동행 알림은 자동으로 끊긴다. 앱이 방을 바꿀 때 **새 연결을 만들면 이전 연결은 반드시 close** 해야 한다 (서버는 두 연결이 같은 기기인지 모름).
- 앱은 `group_state.groupId`가 현재 방과 다르면 무시한다.
### 위치 (`location`, 11.17 추가)
보내는 예:
```json
{"type":"location","data":{"lat":37.5665,"lng":126.978,"heading":90.0,"speed":20.5,"accuracy":5.0,"timestamp":1794900000000}}
```
| 칸 | 필수 | 규칙 |
| --- | --- | --- |
| lat | O | 숫자 -90~90. 문자열 `"37.5"`는 거절 |
| lng | O | 숫자 -180~180 |
| heading | X | 0 이상 360 미만 숫자, 모르면 `null` (Android `hasBearing()`이 false면 null) |
| speed | X | m/s, 0~100 숫자 또는 `null` |
| accuracy | X | m, 0 이상 숫자 또는 `null` |
| timestamp | O | 측정 시각, **밀리초** (Android `Location.getTime()`). 초 단위면 `BAD_LOCATION` |

- **앱 설정 (중요)**: 위치 요청 간격 1초, **최소 이동거리 0m**. 거리 조건을 걸면 정지 중에 위치가 안 와서 서버가 위험 판정을 못 한다. 위치 콜백과 별개로 **타이머로 1초마다 마지막 위치를 보낸다**.
- 검사 실패 시 보낸 연결에만 `error`, 다른 차로는 안 퍼짐
  - `BAD_LOCATION`: 위 규칙 위반 / (0, 0) 좌표(GPS 못 잡은 기본값) / data가 객체가 아님 / 메시지 vehicleId가 join한 차량과 다름
  - `LOCATION_TOO_OLD`: timestamp가 서버 시각보다 10초 넘게 과거 (끊긴 동안 쌓인 위치를 한꺼번에 보내지 말 것)
  - `LOCATION_FROM_FUTURE`: timestamp가 서버 시각보다 5초 넘게 미래 → 기기 시계 확인
  - `RATE_LIMITED`: 한 연결이 1초에 5번 넘게 보냄. 초과분은 **조용히 버리고** 에러는 그 1초에 한 번만
  - `NOT_JOINED` / `NOT_A_MEMBER`: vehicle_status와 같음
- 서버는 차마다 **마지막 위치 하나만** 기억한다. 측정 시각이 이미 받은 것보다 옛날이면 무시한다
- `receivedAt`은 서버 시계 기준 수신 시각. 앱이 "몇 초 전 위치"를 표시할 땐 이 값을 쓴다
- 재접속하면 `join` 직후 다른 차들의 위치 중 **60초 안에 받은 것만** 1회씩 보낸다. 더 오래된 위치는 지도에 엉뚱하게 찍히므로 안 보낸다
- 서버는 움직이는 중(speed ≥ 1m/s, 또는 speed 없이 heading이 온 경우)에 받은 방향만 위험 판정용으로 따로 기억한다
- 숫자(1초, 5회, 10초, 5초, 60초)는 전부 가정값. 환경변수 `LOCATION_MAX_PER_SEC`, `LOCATION_MAX_AGE_MS`, `LOCATION_MAX_FUTURE_MS`, `LOCATION_REPLAY_MAX_MS`로 바꿀 수 있다
- 자동 테스트: `server/location-test.js`

- 자동 테스트: `server/e2e-test.js` (전체), `server/expire-test.js` (코드 만료, 서버를 `CODE_TTL_MS=2000`으로 켜고 실행)
- 수동 테스트: `server/ws-test.js` (`node ws-test.js <groupId> <vehicleId>`, ID는 REST 응답값). 연결 후 `r`/`n`/`w 코드`/`{JSON}`/`leave` 입력. 다른 PC면 `WS_URL=ws://<IP>:3000 node ws-test.js <groupId> <vehicleId>`

## 서버 저장
1차는 서버 메모리(Map)에 저장. 서버를 끄면 사라진다. DB·배포는 1차 범위 밖.
- `Group { groupId, inviteCode, createdAt, hostVehicleId, vehicles: Map<vehicleId, {vehicleId, vehicleName, status, location, lastMovingHeading}> }`
- `inviteCode → groupId` 인덱스, `groupId → Set<WebSocket>` 연결 목록

---

## 다음 단계 (기존 설계 v3, 미확정)
아래는 이전 규격에 있던 위험 공유 기능이다. 1차 범위 밖이며, 붙일 때 키 이름은 위 규격(`type`, groupId/vehicleId)에 맞춰 다시 정한다.

| 방향 | 이름 | 필드 | 보내는 때 |
| --- | --- | --- | --- |
| 앱→서버 | `hazard` | kind(`"HAZARD_LIGHT"`/`"SLIP"`), lat, lng, heading, locAgeMs, durationMs | 판정 규칙 통과 시 1회 |
| 앱→서버 | `capability` | hazardLight: bool, esc: bool | 연결 직후 1회 |
| 앱→서버 | `alert_ack` | hazardId | 음성을 읽은 뒤 |
| 서버→앱 | `hazard_alert` | hazardId, kind, distanceM, fromVehicle, count | 매칭 조건 만족 시 수신차에 1회 |
| 서버→앱 | `demo_location` | lat, lng, heading | 시연 모드 스크립트가 차량을 움직일 때. 0.5초 간격(가정) |
| 서버→앱 | `session_end` | reason | 동행 종료 |
| 서버→앱 | `error` | code, message | 잘못된 메시지 |

- `Hazard { id, kind, lat, lng, heading, firstTs, lastTs, fromVehicle, count }`
- 수신차가 alert_ack를 안 보내도 보낸 시점에 alerted에 넣는다 (재연결 시 중복 경고 방지).
