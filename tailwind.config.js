/**
 * 의미론적 CSS 변수 토큰(플레이북 §2.7) — Claude 스타일 따뜻한 크림 + 클레이 액센트.
 * 색상은 :root 의 --color-* (R G B 채널)로 정의하고, 여기서는 이름만 연결한다.
 * 폰트: 본문 Inter(sans), 제목 Source Serif 4(serif) — head의 <link>로 로드.
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
      },
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Apple SD Gothic Neo",
          "Pretendard",
          "sans-serif",
        ],
        serif: ['"Source Serif 4"', '"Noto Serif KR"', "ui-serif", "Georgia", "Cambria", "serif"],
      },
      maxWidth: {
        content: "64rem", // 콘텐츠 최대폭 통일(플레이북2 §5-5)
      },
    },
  },
  plugins: [],
};
