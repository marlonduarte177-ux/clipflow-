import { pageTitle } from "@/i18n/server";
import { Suspense } from "react";
import { UploadView } from "./upload-view";

export async function generateMetadata() {
  return { title: await pageTitle("upload") };
}

export default function UploadPage() {
  return (
    <Suspense>
      <UploadView />
    </Suspense>
  );
}
