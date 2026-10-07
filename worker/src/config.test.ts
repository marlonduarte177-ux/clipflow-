import { describe, expect, it } from "vitest";
import { describeProxyValue, looksLikeAssemblyAIKey, parseProxyUrl } from "./config.js";

describe("proxy de descarga", () => {
  it("acepta la URL estándar", () => {
    expect(parseProxyUrl("http://u:p@rp.evomi.com:1000")).toBe("http://u:p@rp.evomi.com:1000");
    expect(parseProxyUrl("  socks5://u:p@host:1002 ")).toBe("socks5://u:p@host:1002");
    expect(parseProxyUrl("u:p@rp.evomi.com:1000")).toBe("http://u:p@rp.evomi.com:1000");
  });

  it("acepta el formato que copia Evomi (host:puerto:usuario:contraseña), con o sin http://", () => {
    expect(parseProxyUrl("rp.evomi.com:1000:usuario1:Clave123")).toBe("http://usuario1:Clave123@rp.evomi.com:1000");
    expect(parseProxyUrl("http://rp.evomi.com:1000:usuario1:Clave123")).toBe("http://usuario1:Clave123@rp.evomi.com:1000");
    // Símbolos en la contraseña: se codifican solos.
    expect(parseProxyUrl("rp.evomi.com:1000:usuario1:a@b:c/d")).toBe("http://usuario1:a%40b%3Ac%2Fd@rp.evomi.com:1000");
    expect(parseProxyUrl('"rp.evomi.com:1000:u:p"')).toBe("http://u:p@rp.evomi.com:1000");
  });

  it("se apaga con el valor de relleno, vacío o algo que no es un proxy", () => {
    expect(parseProxyUrl("Xk29aLq0RtY7mZp3Wc8vBn4sJd6fGh1e")).toBeNull();
    expect(parseProxyUrl(undefined)).toBeNull();
    expect(parseProxyUrl("")).toBeNull();
    expect(parseProxyUrl("file:///etc/passwd")).toBeNull();
    expect(parseProxyUrl("rp.evomi.com")).toBeNull();
  });

  it("dice qué hay en el secreto sin mostrarlo", () => {
    expect(describeProxyValue("rp.evomi.com:1000:u:p")).toBe("activado");
    expect(describeProxyValue("Xk29aLq0RtY7mZp3Wc8vBn4sJd6fGh1e")).toBe("sin configurar");
    expect(describeProxyValue(undefined)).toBe("sin configurar");
    expect(describeProxyValue("mi clave de evomi")).toBe("mal escrito");
  });
});

describe("clave de AssemblyAI", () => {
  it("acepta una clave real y rechaza el relleno del secreto (lleva signos)", () => {
    expect(looksLikeAssemblyAIKey("0123456789abcdef0123456789abcdef")).toBe(true);
    expect(looksLikeAssemblyAIKey("aB3$kL9!mN2#pQ5%rS8&tU1*vW4^xY7(")).toBe(false);
    expect(looksLikeAssemblyAIKey("")).toBe(false);
    expect(looksLikeAssemblyAIKey(undefined)).toBe(false);
  });
});
