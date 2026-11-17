# server

페어웨이 동행 서버. Node.js + Express(REST) + ws(WebSocket), 같은 포트 3000.
1차는 **메모리 저장**이라 서버를 끄면 동행·차량 정보가 모두 사라진다.

## 실행
```bash
cd server
npm install        # 처음 한 번
node index.js      # "서버 시작! 포트 3000"이 뜨면 정상
```
- 포트 바꾸기: `env/.env.example`을 `env/.env`로 복사해 `SERVER_PORT`를 고치거나, `SERVER_PORT=4000 node index.js`. 둘 다 있으면 터미널 값이 우선. 없으면 3000
- `env/.env` 읽기는 Node 20.12 이상에서만 동작 (`node -v`로 확인). 그 아래 버전은 파일을 무시하고 터미널 값·3000을 씀
- 포트를 바꿨으면 테스트도 `BASE=http://localhost:<포트> node e2e-test.js`
- 같은 PC: `http://localhost:3000`
- 다른 PC·에뮬레이터: `http://<서버 PC의 IP>:3000` (맥은 `ipconfig getifaddr en0`으로 IP 확인)
- 안 붙으면: 같은 네트워크인지, 서버가 켜져 있는지, 방화벽에서 node 수신이 허용됐는지 확인

## API 요약
| 종류 | 주소 / type | 보내는 값 |
| --- | --- | --- |
| REST | `POST /api/groups` | `{"vehicleName":"1호차"}` |
| REST | `POST /api/groups/join` | `{"inviteCode":"123456","vehicleName":"2호차"}` |
| REST | `GET /api/groups/:groupId` | - |
| WS | `ws://<IP>:3000` 접속 후 `join` | `{"type":"join","groupId":"g1","vehicleId":"v2"}` |
| WS | `vehicle_status` | `{"type":"vehicle_status","data":{"ready":true,"warning":"NONE"}}` |
| WS | `leave` | `{"type":"leave"}` |

전체 규격과 에러 코드: [`docs/protocol.md`](../docs/protocol.md)

## 테스트
서버를 켠 상태에서 다른 터미널에서:
```bash
node e2e-test.js                          # 전체 자동 테스트 (31개 항목)
BASE=http://<IP>:3000 node e2e-test.js    # 다른 PC의 서버 확인
node ws-test.js <groupId> <vehicleId>      # 앱 대신 직접 연결해보기. ID는 REST 응답값 (r / n / w 코드 / {JSON} / leave)
```

코드 만료 테스트 (서버를 TTL 2초로 켜야 함):
```bash
CODE_TTL_MS=2000 node index.js            # 창 1
node expire-test.js                       # 창 2
```
끝나면 서버를 끄고 `node index.js`로 다시 켤 것. TTL 2초인 채로 `e2e-test.js`를 돌리면 실패한다.

## 1차 가정값 (근거 없는 초기값, `index.js` 위쪽 상수에서 변경)
- 참가 코드 유효시간 30분(`CODE_TTL_MS` 환경변수로 변경), 동행 최대 5대, 차량 이름 최대 20자
- 상태 전송 1초 20회, 메시지 1개 16KB
