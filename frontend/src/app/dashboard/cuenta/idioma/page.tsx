import { pageTitle } from "@/i18n/server";
import { LanguagePicker } from "./language-picker";

export async function generateMetadata() {
  return { title: await pageTitle("language") };
}

export default function LanguagePage() {
  return <LanguagePicker />;
}
