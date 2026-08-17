import type { Metadata } from 'next';
import { TaskView } from '../../../components/TaskView';

export const metadata: Metadata = { title: 'Jarvis — Task' };

export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TaskView taskId={id} />;
}
