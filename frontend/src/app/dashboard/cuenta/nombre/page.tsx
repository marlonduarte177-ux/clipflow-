import { pageTitle } from "@/i18n/server";
import { requireUser } from "@/lib/session";
import { NameForm } from "./name-form";

export async function generateMetadata() {
  return { title: await pageTitle("name") };
}

export default async function NamePage() {
  const user = await requireUser();
  return <NameForm initial={user.name ?? ""} />;
}
