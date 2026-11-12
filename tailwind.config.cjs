module.exports = {
  content: ['./public/**/*.html', './public/js/**/*.js'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: { sans: ['"Plus Jakarta Sans"', 'sans-serif'] },
      colors: {
        brand: { 50: '#eef2ff', 100: '#e0e7ff', 500: '#6366f1', 600: '#4f46e5', 700: '#4338ca' },
        canvas: '#ebe9f7'
      },
      boxShadow: { xs: '0 1px 2px 0 rgb(0 0 0 / 0.05)' }
    }
  },
  plugins: [require('@tailwindcss/forms'), require('@tailwindcss/container-queries')]
};
