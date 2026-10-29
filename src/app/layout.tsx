import type { Metadata } from 'next';
import { connection } from 'next/server';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { QueryProvider } from '@/providers/query-provider';
import { ThemeProvider } from '@/providers/theme-provider';
import { AuthProvider } from '@/providers/auth-provider';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { isTelemetryConfigured } from '@/lib/telemetry/http';
import { Toaster } from 'sonner';

const inter = Inter({ subsets: ['latin', 'cyrillic'], variable: '--font-inter' });
const jetbrainsMono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains-mono' });

export const metadata: Metadata = {
  title: 'ЛЕНКАНБАН',
  description: 'Next-generation project management application.',
  icons: {
    icon: '/favicon.svg',
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // The availability flag must reflect the running server, not a build-time
  // snapshot, so a late .env change takes effect on the next request.
  await connection();
  // Boolean only: the HMAC secret stays on the server. A disabled deployment
  // therefore never issues a telemetry request from the browser at all.
  const telemetryEnabled = isTelemetryConfigured();
  return (
    <html lang="ru" suppressHydrationWarning>
      <body className={`${inter.variable} ${jetbrainsMono.variable} font-sans antialiased min-h-screen`}>
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:px-4 focus:py-2 focus:bg-primary focus:text-primary-foreground focus:rounded-md focus:shadow-lg"
        >
          Перейти к основному содержимому
        </a>
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          storageKey="lenkanban-theme-v2"
          enableSystem={true}
          disableTransitionOnChange
        >
          <ErrorBoundary>
            <AuthProvider telemetryEnabled={telemetryEnabled}>
              <ErrorBoundary>
                <QueryProvider>
                  {children}
                </QueryProvider>
              </ErrorBoundary>
            </AuthProvider>
          </ErrorBoundary>
          <Toaster
            position="bottom-right"
            richColors
            closeButton
            toastOptions={{
              style: {
                background: 'var(--card)',
                color: 'var(--foreground)',
                border: '1px solid var(--border)',
              },
            }}
          />
        </ThemeProvider>
      </body>
    </html>
  );
}
