import { InterviewWorkspace } from "@/features/interview-practice/workspace";
export default async function InterviewPage({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return <InterviewWorkspace id={id} />; }
