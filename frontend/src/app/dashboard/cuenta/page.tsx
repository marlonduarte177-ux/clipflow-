import { pageTitle } from "@/i18n/server";
import { requireUser } from "@/lib/session";
import { AccountView } from "./account-view";

export async function generateMetadata() {
  return { title: await pageTitle("account") };
}

export default async function AccountPage() {
  const user = await requireUser();
  return <AccountView name={user.name} email={user.email} />;
}
