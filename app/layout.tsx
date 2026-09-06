import type { Metadata } from 'next'
import { IBM_Plex_Mono, IBM_Plex_Sans, Space_Grotesk } from 'next/font/google'
import './globals.css'

// Three faces, each doing one job.
//
// Space Grotesk sets the product name and headlines: a grotesque with genuinely odd
// letterforms -- the flat-sided G, the squared-off S -- that reads as engineered
// rather than corporate, and holds up at display size where a neutral sans goes limp.
//
// IBM Plex Sans sets the answers. It was drawn for technical documentation and
// engineering interfaces, which is exactly what this is, and it stays legible at the
// long line lengths a full-width layout produces.
//
// IBM Plex Mono carries anything the machine measures -- amperages, page numbers,
// duty cycle percentages -- so numbers align in a column and read as instrument data.
const display = Space_Grotesk({ subsets: ['latin'], weight: ['500', '700'], variable: '--font-display' })
const body = IBM_Plex_Sans({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-body' })
const mono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-mono' })

export const metadata: Metadata = {
  title: 'OmniPro 220 — technical expert',
  description:
    'Ask the Vulcan OmniPro 220 owner’s manual anything. Answers cite the page, ' +
    'surface the figure, and check their own numbers.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  )
}
