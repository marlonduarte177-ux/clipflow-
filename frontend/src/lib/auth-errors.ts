/** Traduce los errores de Cognito/Amplify a mensajes claros en español. */
const MESSAGES: Record<string, string> = {
  UsernameExistsException: "Ya existe una cuenta con ese email.",
  NotAuthorizedException: "Email o contraseña incorrectos.",
  UserNotFoundException: "Email o contraseña incorrectos.",
  UserNotConfirmedException: "Tu email todavía no está verificado.",
  CodeMismatchException: "El código no es correcto.",
  ExpiredCodeException: "El código expiró. Pide uno nuevo.",
  InvalidPasswordException:
    "La contraseña debe tener al menos 10 caracteres, con mayúsculas, minúsculas y números.",
  InvalidParameterException: "Revisa los datos ingresados.",
  LimitExceededException: "Demasiados intentos. Espera unos minutos e inténtalo de nuevo.",
  TooManyRequestsException: "Demasiados intentos. Espera unos minutos e inténtalo de nuevo.",
  TooManyFailedAttemptsException: "Demasiados intentos. Espera unos minutos e inténtalo de nuevo.",
  CodeDeliveryFailureException: "No pudimos enviar el código. Inténtalo de nuevo más tarde.",
  UserAlreadyAuthenticatedException: "Ya tienes una sesión iniciada.",
  NetworkError: "Sin conexión. Revisa tu internet e inténtalo de nuevo.",
};

export function authErrorMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : undefined;
  if (name && MESSAGES[name]) return MESSAGES[name];
  return "No se pudo completar la operación. Inténtalo de nuevo.";
}

export function authErrorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}
