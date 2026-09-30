import { Suspense } from "react";
import { UploadView } from "./upload-view";

export const metadata = { title: "Subir video · ClipFlow" };

export default function UploadPage() {
  return (
    <Suspense>
      <UploadView />
    </Suspense>
  );
}
