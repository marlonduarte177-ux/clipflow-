import { createServerRunner } from "@aws-amplify/adapter-nextjs";
import { amplifyConfig } from "./amplify-config";

/** Permite usar Amplify Auth en el servidor (proxy y Server Components) leyendo las cookies. */
export const { runWithAmplifyServerContext } = createServerRunner({ config: amplifyConfig });
