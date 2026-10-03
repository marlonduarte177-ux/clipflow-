import { requireUser } from "@/lib/session";
import { AccountView } from "./account-view";

export const metadata = { title: "Cuenta · ClipFlow" };

export default async function AccountPage() {
  const user = await requireUser();
  return <AccountView name={user.name} email={user.email} />;
}
