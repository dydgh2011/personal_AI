import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import './globals.css';

export const metadata: Metadata = { title: 'Personal AI OS', robots: { index: false, follow: false } };
export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Dark is the default; the theme cookie holds only "light" or "dark".
  const theme = (await cookies()).get('pai_theme')?.value === 'light' ? 'light' : 'dark';
  return (
    <html lang="ko" data-theme={theme}>
      <body>{children}</body>
    </html>
  );
}
