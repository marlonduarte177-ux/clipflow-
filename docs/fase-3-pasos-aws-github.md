# Fase 3 — Pasos manuales (una sola vez): conectar GitHub con AWS

Objetivo: que GitHub Actions pueda desplegar ClipFlow en tu cuenta de AWS **sin guardar
claves**. Se usa OIDC: GitHub pide credenciales temporales (1 hora) y AWS solo se las da
a este repositorio.

Tiempo: ~15 minutos. Mejor desde una computadora.
**No compartas en el chat** ninguna contraseña, clave ni el ARN (no es secreto, pero no hace falta).

---

## Paso A — Crear el rol de despliegue (CloudFormation)

1. En GitHub abre `infrastructure/bootstrap/github-deploy-role.yaml`
   (rama `claude/clipflow-aws-audit-vwp1ob`) y pulsa el icono **"Download raw file"** (flecha hacia abajo).
2. Entra a https://console.aws.amazon.com.
3. Arriba a la derecha verifica que la región sea **N. Virginia (us-east-1)**.
4. En la barra de búsqueda escribe **CloudFormation** y ábrelo.
5. Pulsa **Create stack** → **With new resources (standard)**.
6. Selecciona **Choose an existing template** → **Upload a template file** → **Choose file** →
   elige el archivo descargado → **Next**.
7. **Stack name:** `clipflow-github-deploy`.
   Parámetros: deja los valores por defecto → **Next**.
8. En *Configure stack options* no cambies nada. Baja al final, marca
   **"I acknowledge that AWS CloudFormation might create IAM resources with custom names"** → **Next**.
9. Revisa y pulsa **Submit**.
10. Espera a que el estado sea **CREATE_COMPLETE** (1–2 min; pulsa el botón de refrescar).
11. Abre la pestaña **Outputs** y copia el valor de **DeployRoleArn**
    (algo como `arn:aws:iam::123456789012:role/clipflow-github-deploy`).

> Si falla con un error que dice que el proveedor `token.actions.githubusercontent.com` ya existe:
> borra el stack fallido y repite con el parámetro **CreateOIDCProvider = false**.

## Paso B — Preparar AWS CDK (CloudShell)

CDK necesita crear una vez sus propios recursos de apoyo en tu cuenta ("bootstrap").

1. En la consola de AWS (región us-east-1), pulsa el icono **CloudShell** `>_` en la barra superior.
   Se abre una terminal en el navegador (ya tiene tus permisos, no pide claves).
2. Pega este comando y pulsa Enter:

   ```bash
   npx --yes aws-cdk@2 bootstrap aws://$(aws sts get-caller-identity --query Account --output text)/us-east-1
   ```

3. Espera 2–3 minutos hasta ver: `✅  Environment aws://…/us-east-1 bootstrapped.`

## Paso C — Configurar GitHub

1. Abre el repositorio en GitHub → **Settings** → menú izquierdo **Environments** → **New environment**.
2. **Name:** `staging` → **Configure environment**.
3. En **Environment variables** pulsa **Add environment variable** y crea:

   | Name | Value |
   |---|---|
   | `AWS_DEPLOY_ROLE_ARN` | el ARN copiado en el paso A.11 |
   | `AWS_REGION` | `us-east-1` |

4. Guarda. (No hace falta crear *secrets*: nada de esto es secreto.)

> En el celular, *Settings* de GitHub solo aparece en el navegador (no en la app).

## Recomendación de seguridad (puede hacerse después)

Evita usar el usuario **root** para el trabajo diario. Más adelante crearemos un usuario
administrador con **IAM Identity Center** y te daré los pasos.
