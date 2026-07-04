---
version: 1
name: OMG Studios Manager — Design System
description: >
  녹음/믹싱 스튜디오 내부 관리 웹앱의 디자인 시스템. 따뜻한 크림 캔버스 +
  클레이(테라코타) 액센트 + 세이지 성공색의 휴머니스트 톤(Anthropic/Claude
  에디토리얼 계열과 독립적으로 동일 지점 도달). 서버 렌더 HTML + Tailwind
  빌드, CSP 인라인 스크립트 0, Pretendard 한글 본문. 마케팅 페이지가 아니라
  밀도 높은 사내 CRUD(리스트·폼·탭·배지·카드) 도구다. 색 토큰은 R G B 채널로
  정의(`public/css/src.css`), Tailwind가 이름만 연결(`tailwind.config.js`).

# 라이트가 기본 정체성. 다크는 토글(html[data-theme]) 또는 OS 추종.
colors-light:
  bg: "#FAF9F5"        # warm ivory 캔버스
  surface: "#FFFFFF"   # 카드 표면
  elevated: "#F0EEE6"  # 사이드바·패널·호버
  border: "#E5E2D7"    # warm hairline
  muted: "#6E6A5F"     # warm gray — 본문 보조. WCAG AA 5.15:1 on bg (하한, 더 밝히지 말 것)
  fg: "#262421"        # warm near-black 본문
  primary: "#C8795B"   # 클레이(테라코타) — 주요 CTA·브랜드 액센트 전용
  primary-fg: "#FFFFFF"
  success: "#5C7A5C"   # muted sage — 완료·긍정 상태
  warning: "#B5793C"   # warm amber — 경고·예약됨
  danger: "#BC4B3C"    # warm red — 미수·삭제·오류
  info: "#60738C"      # cool blue-gray — 정보/중립 강조(상태색과 브랜드 클레이 분리)

colors-dark:            # media(prefers-color-scheme) 또는 html[data-theme="dark"]
  bg: "#1E1D1B"        # warm charcoal
  surface: "#262522"
  elevated: "#2D2B27"
  border: "#3D3A34"
  muted: "#9C968B"
  fg: "#EDEBE4"
  primary: "#D68A69"   # lighter clay
  primary-fg: "#1C1A18"
  success: "#84AA84"
  warning: "#D19E60"
  danger: "#E07A68"
  info: "#94A3B8"

typography:
  sans: "Pretendard, Inter, system-ui, -apple-system, sans-serif"   # 본문·UI 전부(한글 최적)
  serif: '"Source Serif 4", "Noto Serif KR", ui-serif, Georgia, serif'  # .font-display 제목만(에디토리얼 톤)
  scale: "Tailwind text-* 유틸 사용(고정 스케일 미문서화 — Known Gaps 참조). 금액·시간은 .tabular(tabular-nums)."
  weight: "본문 400, 라벨·강조 500. 세리프 제목은 굵게 쓰지 않음."

radius:
  md: "0.375rem  # rounded-md — 배지"
  lg: "0.5rem    # rounded-lg — 버튼·입력"
  xl: "0.75rem   # rounded-xl — 카드·리스트 카드"

spacing:
  scale: "Tailwind 기본 스케일(4px 기반). 카드 간격 space-y-2, 폼 필드 gap-2~3."
  container: "max-w-3xl(기본) / layout({full:true})=전폭. 콘텐츠 패딩 px-4 py-6 sm:px-6."
  full-bleed: "-mx-4 sm:-mx-6 로 콘텐츠 패딩 상쇄(캘린더 등 화면 끝까지)."

components:
  btn: ".btn 베이스 + .btn-primary(클레이 채움) / .btn-ghost(테두리+surface). 크기 .btn-sm / .btn-xs(≥36px)."
  input: ".input / .label / .label-sm. 모바일 16px(iOS 자동확대 방지)."
  card: ".card(rounded-xl border bg-surface p-5 + 은은한 그림자)."
  list-card: "리스트 항목 카드 = rounded-xl border-border/60 bg-surface + .row-link, 카드 간 space-y-2."
  badge: ".badge(whitespace-nowrap shrink-0) + 변형 neutral/primary/success/warning/danger/info(bg-*/12 tint + text-*)."
  row-link: ".row-link — 클릭 가능한 행/카드(hover:bg-elevated/60 active:bg-elevated). 터치엔 hover 없어 active: 필수."
  helpers-js: "src/views.js: listGroup·listRow·emptyState·tabBar·searchBox(typeahead)·explain(접기)·pageHeader."
---

# OMG Studios Manager — Design System

> AI 에이전트/개발자가 UI를 만들 때 읽는 단일 명세. 색·정체성은 **현행 그대로**(위 프론트매터가 진실원천). 이 파일은 흩어진 규칙을 한 장으로 증류한 것. 토큰/클래스 변경 시 이 파일도 갱신.

## Overview

따뜻한 **크림 캔버스(`#FAF9F5`) + 클레이/테라코타 액센트(`#C8795B`)** 의 휴머니스트 톤. 대부분의 SaaS가 쿨 블루/슬레이트를 쓰는 것에 반해 의도적으로 따뜻하다. 브랜드 전압은 **크림×클레이** 페어링에서 나오고, 클레이는 **주요 CTA와 브랜드 액센트에만** 아껴 쓴다. 상태색(성공=세이지, 경고=앰버, 위험=레드, 정보=블루그레이)은 브랜드 클레이와 **명확히 분리**한다.

이 앱은 **마케팅 페이지가 아니다.** 히어로·풀블리드 밴드·64px 세리프 헤드라인 같은 랜딩 어휘는 쓰지 않는다. 실제 화면은 리스트·폼·탭·배지·카드로 이뤄진 밀도 높은 업무 도구다.

## Colors

- **역할 토큰**(`--color-*`, R G B 채널) → Tailwind 이름(`bg`/`surface`/`elevated`/`border`/`muted`/`fg`/`primary`/`primary-fg`/`success`/`warning`/`danger`/`info`).
- **뷰 코드에 hex 인라인 금지** — 항상 토큰 이름(`bg-surface`, `text-muted`, `bg-primary`, `text-success`…). **유일 예외**: `<meta name="theme-color">`(CSS 변수 불가라 hex가 유일한 방법, 라이트 `#faf9f5`·다크 `#1e1d1b`).
- **라이트가 기본 정체성.** 다크는 `html[data-theme]`(수동 토글) 또는 `[data-theme]` 없을 때 OS 추종. 크림 라이트는 OS가 다크여도 `data-theme="light"`로 유지 가능.
- `muted`는 **AA 하한(5.15:1)** 이다. 더 밝히지 말 것.
- 배지 색 변형은 `bg-*/12` 불투명도를 쓰므로 `tailwind.config.js`의 `opacity.12`가 반드시 있어야 함(없으면 빌드에서 클래스 제거됨).

## Typography

- **한 벌의 산세리프(Pretendard)** 가 본문·UI 전부. 한글 렌더가 핵심이라 Pretendard 우선, Inter/system-ui 폴백.
- **세리프(Source Serif 4)** 는 `.font-display`(제목·에디토리얼 강조)에만. 굵게 쓰지 않는다.
- 금액·시간 등 자리 맞춤이 필요한 숫자는 `.tabular`(tabular-nums).
- 한글은 CJK 기본 줄바꿈이 글자 사이 아무데서나 끊어 단어를 찌그러뜨린다 → 줄바꿈되는 텍스트 청크에 **`break-keep`(word-break:keep-all)** 을 붙여 공백에서만 접히게 한다.

## Layout

- 콘텐츠 폭: 기본 `max-w-3xl`, 필요 시 `layout({full:true})`로 전폭. 패딩 `px-4 py-6 sm:px-6`.
- 화면 끝까지(full-bleed) 필요 시 `-mx-4 sm:-mx-6`로 콘텐츠 패딩 상쇄(캘린더 그리드 등).
- 사이드바는 `elevated` 표면 + 운영/청구/관리 그룹, 좌측 레일 활성표시.

## Elevation & Shapes

- 그림자는 **거의 쓰지 않는다.** `.card`만 은은한 2겹 그림자(`0 1px 3px /.06`, `0 1px 2px /.04`). 깊이는 주로 **border + surface 대비**로 표현.
- 라운드 스케일: 배지 `rounded-md`, 버튼·입력 `rounded-lg`, 카드·리스트 카드 `rounded-xl`.

## Components

- **버튼**: `.btn-primary`(클레이 채움, 주요 동작·저장), `.btn-ghost`(테두리+surface, 보조). 크기 `.btn-sm`/`.btn-xs`. 클레이 채움은 **주요 동작에만** — 완료·상태 토글 등에는 쓰지 않는다(§ Do/Don't).
- **입력/폼**: `.input`, `.label`, `.label-sm`. dirty 저장 패턴(`data-dirty-form`/`data-dirty-save`) + 이탈 가드(미저장 시 저장/저장하지 않음 모달).
- **카드**: `.card`. 리스트 항목 카드는 `rounded-xl border-border/60 bg-surface` + `.row-link`, 카드 간 `space-y-2`(프로젝트·일정·청구 목록 공통 톤).
- **배지**: `.badge` + 변형(neutral/primary/success/warning/danger/info). 공백 라벨이 쪼개지지 않게 `whitespace-nowrap shrink-0`.
- **탭/필터**: `tabBar`(aria-current, 개수 라벨) — 목록 상단 분류(진행중/완료, 발행필요/발행완료 등).
- **검색**: `searchBox`(typeahead — 200ms 디바운스, `/suggest` JSON, ↑↓·엔터, 한글 IME 가드).
- **클릭 어포던스**: 클릭 가능한 행·카드에 `.row-link`. 터치엔 hover가 없으니 반드시 `active:` 눌림 피드백을 함께.
- **예약 슬롯**: 이미 찬 슬롯은 비활성 회색 대신 `.slot-busy`(앰버, 선택 가능·확인 후 등록).

## Do's and Don'ts

### Do
- **완료·긍정 상태 = `success`(세이지)** 흐름. 완료 토글은 켜짐=`bg-success/10 text-success border-success/40`, 꺼짐=ghost+`text-success`+`−`, 켜짐=`✓`(세션·청구 상태 공통).
- **`primary`(클레이)는 저장·주요 CTA에만** 아껴 쓴다.
- 리스트 행은 좁은 화면 찌그러짐 방지로 **제목 전폭 → 배지 줄(`flex flex-wrap gap-1`) → 메타** 순으로 쌓는다.
- 상태·분류는 알맞은 `badge-*` 색으로(성공/경고/위험/정보 구분).
- 새 색이 필요하면 먼저 **기존 역할 토큰**으로 표현할 수 있는지 본다.

### Don't
- **완료/토글 같은 상태 버튼에 `btn-primary`(클레이) 쓰지 말 것** — 너무 강하고 "저장/주요 기능" 신호와 충돌. 완료엔 세이지 성공 흐름.
- 캔버스에 쿨 그레이나 순백을 쓰지 말 것. **크림이 정체성.**
- `muted`를 AA 아래로 밝히지 말 것.
- hover 전용 어포던스를 `active:` 없이 넣지 말 것(터치 미대응).
- 뷰에 hex를 인라인하지 말 것(토큰 이름만).
- 인라인 `<script>`/`<style>` 금지(CSP). JS는 `public/js/app.js`에 위임 방식으로.

## Responsive

- 브레이크포인트: Tailwind `sm=640px`. **모바일=`< 640px`.**
- 모바일 폼 컨트롤 **16px**(iOS 자동확대 방지, `src.css` 미디어쿼리).
- **터치 타깃 ≥44px**(모바일 전용 미디어 — `.btn`·`.row-link`·`[role=listbox]>button`). 데스크톱 밀도는 현행 유지.
- 검증법: 오프스크린 `<iframe width=390>`에 페이지 로드 → `scrollWidth - clientWidth == 0`(가로 오버플로우 0). Chrome 최소창폭(500px)을 우회해 320~430px 실측.
- 모달 열리면 배경 스크롤 잠금(공통 IIFE, MutationObserver).

## Tech Guardrails

- **서버 렌더 HTML**(`src/views*.js`) + 클래식 폼 POST + 최소 JS(`public/js/app.js`).
- **Tailwind CLI 빌드**: `public/css/src.css`(소스) → `app.css`. 컴포넌트 클래스는 `@layer components`. 색·컴포넌트 바꾸면 **`npm run build:css`** 필수.
- **CSP**: 인라인 스크립트 0. 콤보 옵션 등은 `<script type="application/json">` 정적 임베드로 전달.
- 정적 자산 캐시 버스팅 `?v=`(mtime+size).
- 테마: `html[data-theme]` + localStorage 토글, 크림 라이트 기본. `theme-color` 다크 대응.

## Iteration Guide

1. 색은 **역할 토큰**으로만(`bg`/`surface`/`primary`/`success`…) — hex 인라인 금지.
2. 새 재사용 컴포넌트는 `src.css @layer components`에 `.class` 추가 후 `build:css`.
3. 상태 신호는 **성공=세이지 / 주요=클레이 / 경고=앰버 / 위험=레드 / 정보=블루그레이** 역할을 지킨다.
4. 한글 줄바꿈 청크엔 `break-keep`, 짧은 단위(금액·상태)엔 `whitespace-nowrap`.
5. 목록·탭·빈상태는 공용 헬퍼(`listRow`/`tabBar`/`emptyState`) 재사용 — 새로 만들지 말 것.
6. 토큰/클래스/가드레일이 바뀌면 **이 파일과 `CLAUDE.md`를 함께 갱신**(드리프트 방지).

## Known Gaps

- **고정 타입 스케일 미문서화** — 현재 Tailwind `text-*`를 상황별로 씀(일관성은 리뷰로 보완). 필요 시 명명 스케일 도입 검토.
- **명명된 elevation 스케일 없음** — `.card` 그림자 1종 외에는 border/surface 대비로만.
- 폰트는 CDN 로드(Pretendard jsdelivr, CSP 허용) — 오프라인/서브셋 최적화는 향후.
- 애니메이션·트랜지션 타이밍 시스템은 범위 밖(개별 `transition-colors` 정도).
