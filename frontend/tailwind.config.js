/** @type {import('tailwindcss').Config} */
module.exports = {
    darkMode: ["class"],
    content: [
    "./src/**/*.{js,jsx,ts,tsx}",
    "./public/index.html"
  ],
  theme: {
  	extend: {
  		fontFamily: {
  			sans: ['"Instrument Sans"', 'system-ui', '-apple-system', '"Segoe UI"', 'sans-serif'],
  			mono: ['"JetBrains Mono"', 'ui-monospace', 'Menlo', 'Consolas', 'monospace']
  		},
  		boxShadow: {
  			knob: 'var(--knob-shadow)',
  			'elev-1': 'var(--elev-1)',
  			'elev-2': 'var(--elev-2)'
  		},
  		borderRadius: {
  			lg: 'var(--radius)',
  			md: 'calc(var(--radius) - 2px)',
  			sm: 'calc(var(--radius) - 4px)'
  		},
  		colors: {
  			background: 'hsl(var(--background))',
  			foreground: 'hsl(var(--foreground))',
  			// Two extra background tiers (root canvas < panel < panel-hover)
  			// and a fourth text tier (subtle, below muted-foreground) — the app's
  			// three-level surface hierarchy and smallest uppercase labels don't
  			// map onto shadcn's single --card tier. See index.css for values.
  			panel: {
  				DEFAULT: 'hsl(var(--panel))',
  				hover: 'hsl(var(--panel-hover))',
  				active: 'hsl(var(--panel-active))'
  			},
  			subtle: 'hsl(var(--subtle-foreground))',
  			card: {
  				DEFAULT: 'hsl(var(--card))',
  				foreground: 'hsl(var(--card-foreground))'
  			},
  			popover: {
  				DEFAULT: 'hsl(var(--popover))',
  				foreground: 'hsl(var(--popover-foreground))'
  			},
  			primary: {
  				DEFAULT: 'hsl(var(--primary))',
  				foreground: 'hsl(var(--primary-foreground))'
  			},
  			secondary: {
  				DEFAULT: 'hsl(var(--secondary))',
  				foreground: 'hsl(var(--secondary-foreground))'
  			},
  			muted: {
  				DEFAULT: 'hsl(var(--muted))',
  				foreground: 'hsl(var(--muted-foreground))'
  			},
  			accent: {
  				DEFAULT: 'hsl(var(--accent))',
  				foreground: 'hsl(var(--accent-foreground))'
  			},
  			destructive: {
  				DEFAULT: 'hsl(var(--destructive))',
  				foreground: 'hsl(var(--destructive-foreground))'
  			},
  			border: 'hsl(var(--border))',
  			// Stronger line: field and control outlines, dividers that must hold
  			// on a hovered surface. `border` stays the hairline between panels.
  			edge: 'hsl(var(--edge))',
  			// The one accent. tint/line are complete colours (the dark tint is
  			// translucent, the light one solid), so no /opacity modifier on them.
  			crema: {
  				DEFAULT: 'hsl(var(--crema))',
  				foreground: 'hsl(var(--crema-foreground))',
  				tint: 'hsl(var(--crema-tint))',
  				line: 'hsl(var(--crema-line))'
  			},
  			ok: 'hsl(var(--ok))',
  			warn: 'hsl(var(--warn))',
  			knob: 'hsl(var(--knob))',
  			input: 'hsl(var(--input))',
  			ring: 'hsl(var(--ring))',
  			chart: {
  				'1': 'hsl(var(--chart-1))',
  				'2': 'hsl(var(--chart-2))',
  				'3': 'hsl(var(--chart-3))',
  				'4': 'hsl(var(--chart-4))',
  				'5': 'hsl(var(--chart-5))'
  			}
  		},
  		keyframes: {
  			'accordion-down': {
  				from: {
  					height: '0'
  				},
  				to: {
  					height: 'var(--radix-accordion-content-height)'
  				}
  			},
  			'accordion-up': {
  				from: {
  					height: 'var(--radix-accordion-content-height)'
  				},
  				to: {
  					height: '0'
  				}
  			}
  		},
  		animation: {
  			'accordion-down': 'accordion-down 0.2s ease-out',
  			'accordion-up': 'accordion-up 0.2s ease-out'
  		}
  	}
  },
  plugins: [require("tailwindcss-animate")],
};