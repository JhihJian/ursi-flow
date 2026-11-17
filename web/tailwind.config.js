/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{vue,ts}'],
  theme: {
    extend: {
      colors: {
        canvas: '#f5f7f8',
        ink: '#162d35',
        muted: '#52666e',
        accent: '#087f75',
        line: '#dce5e8',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '"PingFang SC"', '"Microsoft YaHei"', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
