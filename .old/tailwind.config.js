/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './renderer/**/*.html',
    './renderer/**/*.js'
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: '#533483',
          hover: '#402870',
          light: '#e0d6f0'
        },
        toolbar: {
          DEFAULT: '#dfe1e5',
          dark: '#202124'
        },
        tabbar: {
          DEFAULT: '#dfe1e5',
          dark: '#202124'
        }
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', '"Noto Sans CJK SC"', '"WenQuanYi Micro Hei"', 'sans-serif']
      },
      borderRadius: {
        'lg': '8px'
      }
    }
  },
  plugins: []
};
