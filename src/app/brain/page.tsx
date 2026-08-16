import type { Metadata } from 'next';
import { BrainGraph } from '../../components/BrainGraph';

export const metadata: Metadata = { title: 'Jarvis — Brain' };

export default function BrainPage() {
  return <BrainGraph />;
}
