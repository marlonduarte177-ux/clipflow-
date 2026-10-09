import { pageTitle } from "@/i18n/server";
import { requireUser } from "@/lib/session";
import { CompareView } from "./compare-view";

export async function generateMetadata() {
  return { title: await pageTitle("compare") };
}

export default async function ComparePage() {
  await requireUser();
  return <CompareView />;
}
