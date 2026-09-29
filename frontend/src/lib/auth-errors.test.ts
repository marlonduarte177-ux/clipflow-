import { describe, expect, it } from "vitest";
import { authErrorMessage } from "./auth-errors";

const err = (name: string) => Object.assign(new Error("x"), { name });

describe("authErrorMessage", () => {
  it("traduce errores conocidos de Cognito", () => {
    expect(authErrorMessage(err("UsernameExistsException"))).toMatch(/Ya existe una cuenta/);
    expect(authErrorMessage(err("CodeMismatchException"))).toMatch(/código no es correcto/);
  });

  it("no revela si un usuario existe: mismo mensaje para usuario inexistente y contraseña incorrecta", () => {
    expect(authErrorMessage(err("UserNotFoundException"))).toBe(authErrorMessage(err("NotAuthorizedException")));
  });

  it("da un mensaje genérico para errores desconocidos (sin detalles internos)", () => {
    expect(authErrorMessage(new Error("stack interno"))).toBe(
      "No se pudo completar la operación. Inténtalo de nuevo.",
    );
    expect(authErrorMessage("texto")).toMatch(/No se pudo completar/);
  });
});
