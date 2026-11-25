# BIG CYCLE

미국 경기·유동성 지표가 역사적으로 어느 위치에 있는지, 그리고 그 지표가 과거에 얼마나 맞았는지를 보여주는 스터디용 상황판입니다. 매수·매도 신호를 주는 프로그램이 아닙니다.

- 화면: `web/index.html`
- 자료 만들기: `node scripts/build-web-data.mjs --refresh` (환경변수 `FRED_API_KEY` 필요)
- 지표 목록과 규칙: `config/indicators.json`
- 깃허브에서는 `.github/workflows/update.yml` 이 하루 두 번 자료를 새로 받아 화면을 다시 게시합니다.

출처: 미국 연준 계열 통계(FRED), 로버트 실러 교수 공개 자료.

This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.
