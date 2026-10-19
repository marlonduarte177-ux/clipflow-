import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

/**
 * Lee un secreto de Secrets Manager mientras la API funciona (no solo al arrancar): así una clave
 * nueva pegada en AWS se usa en menos de un minuto, sin desplegar. Guarda el valor un rato para no
 * consultar AWS en cada petición. Nunca registra el valor.
 */
export interface LiveSecret {
  /** El valor actual (undefined si no se pudo leer). `fresh` lo vuelve a pedir ya. */
  get(fresh?: boolean): Promise<string | undefined>;
}

export function createLiveSecret(secretId: string, region: string | undefined, ttlMs = 60_000): LiveSecret {
  const client = new SecretsManagerClient({ region });
  let cached: { value: string | undefined; at: number } | null = null;
  return {
    async get(fresh = false) {
      if (!fresh && cached && Date.now() - cached.at < ttlMs) return cached.value;
      try {
        const res = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
        cached = { value: res.SecretString, at: Date.now() };
      } catch {
        // Sin acceso o AWS no responde: se sigue con lo último que se leyó (o con el valor del arranque).
        cached = { value: cached?.value, at: Date.now() };
      }
      return cached.value;
    },
  };
}
