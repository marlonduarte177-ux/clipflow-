import { pageTitle } from "@/i18n/server";
import { ProjectsView } from "./projects-view";

export async function generateMetadata() {
  return { title: await pageTitle("videos") };
}

export default function DashboardPage() {
  return <ProjectsView />;
}
