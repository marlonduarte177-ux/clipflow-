import { pageTitle } from "@/i18n/server";
import { VideoView } from "./video-view";

export async function generateMetadata() {
  return { title: await pageTitle("video") };
}

export default async function VideoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <VideoView videoId={id} />;
}
