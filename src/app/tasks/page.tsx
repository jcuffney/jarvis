import type { Metadata } from 'next';
import { TaskBoard } from '../../components/TaskBoard';

export const metadata: Metadata = { title: 'Jarvis — Tasks' };

export default function TasksPage() {
  return <TaskBoard />;
}
