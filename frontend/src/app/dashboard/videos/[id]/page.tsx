import { VideoView } from "./video-view";

export const metadata = { title: "Video · ClipFlow" };

export default async function VideoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <VideoView videoId={id} />;
}
