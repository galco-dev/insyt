// Tailwind config generated 1:1 from build-doc §18.1 tokens (Cloudis) +
// §18.2 severity additions. NOTHING else — the token layer is the contract
// between the Webflow site and this app. Type scale compressed one step for
// dashboard density per master §17.3.
const path = require('path');

module.exports = {
  content: [path.join(__dirname, 'index.html'), path.join(__dirname, 'src/**/*.{js,jsx}')],
  theme: {
    colors: {
      transparent: 'transparent',
      current: 'currentColor',
      white: '#ffffff',
      black: '#000000',
      accent: '#000d14',
      neutral: {
        50: '#fafafa', 100: '#f7f7f7', 200: '#f2f2f2', 300: '#ededed',
        400: '#e6e6e6', 500: '#dedede', 600: '#d9d9d9', 700: '#d1d1d1',
        800: '#c2c2c2', 900: '#727272',
      },
      critical: { DEFAULT: '#DC2626', tint: 'rgba(220,38,38,0.06)' },
      warning: { DEFAULT: '#D97706', tint: 'rgba(217,119,6,0.06)' },
      success: { DEFAULT: '#16A34A', tint: 'rgba(22,163,74,0.06)' },
      info: { DEFAULT: '#2563EB', tint: 'rgba(37,99,235,0.06)' },
    },
    fontFamily: {
      sans: ['Geist', 'Helvetica', 'Arial', 'sans-serif'],
      mono: ['"Geist Mono"', 'ui-monospace', 'monospace'],
    },
    borderRadius: { none: '0', DEFAULT: '6px', sm: '4px', lg: '10px', full: '9999px' },
    extend: {
      maxWidth: { container: '1428px', xl2: '1138px', l2: '896px', m2: '654px', s2: '412px' },
      fontSize: {
        // §18.1 scale compressed one step for app density (§17.3)
        h1: ['2.5rem', { lineHeight: '1.1', fontWeight: '600' }],
        h2: ['2rem', { lineHeight: '1.15', fontWeight: '600' }],
        h3: ['1.5rem', { lineHeight: '1.2', fontWeight: '600' }],
        h4: ['1.25rem', { lineHeight: '1.3', fontWeight: '600' }],
        h5: ['1.125rem', { lineHeight: '1.35', fontWeight: '600' }],
        body: ['0.9375rem', { lineHeight: '1.5' }],
        small: ['0.8125rem', { lineHeight: '1.45' }],
        tiny: ['0.6875rem', { lineHeight: '1.4' }],
      },
    },
  },
  plugins: [],
};
