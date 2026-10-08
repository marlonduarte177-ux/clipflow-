import { pageTitle } from "@/i18n/server";
import { requireUser } from "@/lib/session";
import { PlansView } from "./plans-view";

export async function generateMetadata() {
  return { title: await pageTitle("plans") };
}

export default async function PlansPage() {
  await requireUser();
  return <PlansView />;
}
