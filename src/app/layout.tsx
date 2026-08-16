import type { Metadata, Viewport } from 'next';
import '../styles/globals.css';
import '../styles/themes/gym-dark.css';
import '../styles/themes/ultron.css';
import '../styles/themes/light.css';
import '../styles/prose.css';
import '../styles/motion.css';

export const metadata: Metadata = {
  title: 'Jarvis',
  description: 'Voice-assistant display',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="gym-dark">
      <body>{children}</body>
    </html>
  );
}
