/** @type {import('tailwindcss').Config} */
export default {
  content: ["./web/index.html", "./web/src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#0b0d10",
        panel: "#13161b",
        border: "#1f242c",
        muted: "#8a93a3",
      },
    },
  },
  plugins: [],
};
