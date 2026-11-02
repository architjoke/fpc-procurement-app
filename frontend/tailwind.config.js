/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: '#FAFAF7',
        forest: '#1B5E20',
        'forest-dark': '#123F17',
        amber: '#F59E0B',
        ink: '#1F2937',
        muted: '#667085',
        line: '#D9DFD7',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        card: '0 18px 48px rgba(27, 55, 33, 0.12)',
      },
    },
  },
  plugins: [],
};
