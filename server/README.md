# server

페어웨이 동행 서버. Node.js + Express(REST) + ws(WebSocket), 같은 포트 3000.
1차는 **메모리 저장**이라 서버를 끄면 동행·차량 정보가 모두 사라진다.

## 실행
```bash
cd server
npm install        # 처음 한 번
node index.js      # "서버 시작!"이 뜨면 정상
```
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
node e2e-test.js                          # 전체 자동 테스트 (19개 항목)
BASE=http://<IP>:3000 node e2e-test.js    # 다른 PC의 서버 확인
node ws-test.js g1 v1                     # 앱 대신 직접 연결해보기 (r / n / w 코드 / {JSON} / leave)
```

## 1차 가정값 (근거 없는 초기값, `index.js` 위쪽 상수에서 변경)
- 참가 코드 유효시간 30분, 동행 최대 5대
- 상태 전송 1초 20회, 메시지 1개 16KB
