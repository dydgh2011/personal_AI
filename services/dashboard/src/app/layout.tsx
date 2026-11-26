import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import { LangProvider } from '@/i18n/client';
import { LANG_COOKIE, parseLang } from '@/i18n';
import './globals.css';

export const metadata: Metadata = { title: 'Personal AI OS', robots: { index: false, follow: false } };
export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const jar = await cookies();
  // Dark is the default; the theme cookie holds only "light" or "dark".
  const theme = jar.get('pai_theme')?.value === 'light' ? 'light' : 'dark';
  // Korean is the default; the language cookie holds only "ko" or "en" (see src/i18n).
  const lang = parseLang(jar.get(LANG_COOKIE)?.value);
  return (
    <html lang={lang} data-theme={theme}>
      <body>
        <LangProvider lang={lang}>{children}</LangProvider>
      </body>
    </html>
  );
}
