/**
 * 의미론적 CSS 변수 토큰(플레이북 §2.7) — Claude 스타일 따뜻한 크림 + 클레이 액센트.
 * 색상은 :root 의 --color-* (R G B 채널)로 정의하고, 여기서는 이름만 연결한다.
 * 폰트: 본문 Pretendard→Inter(sans), 제목 Source Serif 4(serif) — head의 <link>로 로드.
 */
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.js", "./public/**/*.{html,js}"],
  theme: {
    extend: {
      colors: {
        bg: "rgb(var(--color-bg) / <alpha-value>)",
        surface: "rgb(var(--color-surface) / <alpha-value>)",
        elevated: "rgb(var(--color-elevated) / <alpha-value>)",
        border: "rgb(var(--color-border) / <alpha-value>)",
        muted: "rgb(var(--color-muted) / <alpha-value>)",
        fg: "rgb(var(--color-fg) / <alpha-value>)",
        primary: "rgb(var(--color-primary) / <alpha-value>)",
        "primary-fg": "rgb(var(--color-primary-fg) / <alpha-value>)",
        success: "rgb(var(--color-success) / <alpha-value>)",
        warning: "rgb(var(--color-warning) / <alpha-value>)",
        danger: "rgb(var(--color-danger) / <alpha-value>)",
        info: "rgb(var(--color-info) / <alpha-value>)",
      },
      // 폰트 스택을 CSS 변수로(테마 선택 기능 2026-07-17) — 팔레트가 --font-sans/--font-serif만 바꾸면 전체 폰트 교체.
      // 변수 기본값은 src.css :root에 정의(Original=Pretendard/Source Serif). 값 자체는 그대로라 렌더 불변.
      fontFamily: {
        sans: ["var(--font-sans)"],
        serif: ["var(--font-serif)"],
      },
      maxWidth: {
        content: "48rem", // 폼·상세 읽기 폭(2026-07-16 사용자 '폭이 넓어 부담·시선 분산' → 64→48rem[768px]로 좁혀 집중). 넓은 목록·표는 wide 사용.
        wide: "110rem", // 넓은 표(청구 목록 등) 전용 — 데이터가 많은 화면은 넓은 모니터 폭을 최대한 사용(2026-07-16, 80→110rem)
      },
      opacity: {
        12: "0.12", // .badge-* 색 변형(bg-*/12)의 슬래시 모디파이어 스케일(기본 스케일엔 12 없음)
      },
    },
  },
  plugins: [],
};
