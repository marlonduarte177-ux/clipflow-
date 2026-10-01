import { describe, expect, it } from "vitest";
import { parseProxyUrl } from "./config.js";

describe("proxy de descarga", () => {
  it("se activa solo con una URL de proxy real", () => {
    expect(parseProxyUrl("http://u:p@rp.evomi.com:1000")).toBe("http://u:p@rp.evomi.com:1000");
    expect(parseProxyUrl("  socks5://u:p@host:1002 ")).toBe("socks5://u:p@host:1002");
    // Valor de relleno que crea Secrets Manager, vacío o un protocolo no permitido: apagado.
    expect(parseProxyUrl("Xk29aLq0RtY7mZp3Wc8vBn4sJd6fGh1e")).toBeNull();
    expect(parseProxyUrl(undefined)).toBeNull();
    expect(parseProxyUrl("")).toBeNull();
    expect(parseProxyUrl("file:///etc/passwd")).toBeNull();
  });
});
