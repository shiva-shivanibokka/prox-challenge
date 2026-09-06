import type { Metadata } from 'next'
import { Archivo, Literata } from 'next/font/google'
import './globals.css'

// Archivo carries structure and every machine readout: an industrial grotesque with
// enough weight range to do headings and LCD digits without a second face. Literata
// sets the answers, because a long technical explanation reads better as a document
// than as UI text -- and the split is the design: paper for what you read, panel for
// what the machine says.
const ui = Archivo({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--font-ui' })
const body = Literata({ subsets: ['latin'], weight: ['400', '600'], variable: '--font-body' })

export const metadata: Metadata = {
  title: 'OmniPro 220 — technical expert',
  description:
    'Ask the Vulcan OmniPro 220 owner’s manual anything. Answers cite the page, ' +
    'surface the figure, and check their own numbers.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${ui.variable} ${body.variable}`}>
      <body>{children}</body>
    </html>
  )
}
