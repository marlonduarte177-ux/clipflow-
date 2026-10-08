import Link from "next/link";
import { LegalPage } from "@/components/legal-page";
import { LEGAL } from "@/lib/legal";

export const metadata = {
  title: "Términos de uso · ClipFlow",
  alternates: { languages: { es: "/terminos", en: "/en/terms" } },
};

const mail = <a href={`mailto:${LEGAL.email}`}>{LEGAL.email}</a>;

export default function TermsPage() {
  return (
    <LegalPage
      doc="terms"
      title="Términos de uso"
      intro={
        <p>
          Estos términos regulan el uso de ClipFlow ({LEGAL.site}), un servicio de {LEGAL.owner}, con domicilio en {LEGAL.country}. Al
          crear una cuenta o usar el servicio, aceptas estos términos. Si no estás de acuerdo, no uses ClipFlow.
        </p>
      }
      sections={[
        {
          title: "El servicio",
          body: (
            <p>
              ClipFlow es un editor de video con inteligencia artificial: analiza los videos que subes (o que importas con un enlace a un
              video tuyo) y genera clips verticales cortos con subtítulos, listos para publicar en redes sociales.
            </p>
          ),
        },
        {
          title: "Tu cuenta",
          body: (
            <ul>
              <li>Debes tener al menos 18 años, o la mayoría de edad de tu país, para crear una cuenta.</li>
              <li>Eres responsable de mantener tu contraseña segura y de lo que se haga con tu cuenta.</li>
              <li>Puedes eliminar tu cuenta cuando quieras desde la página Cuenta; se borran tus videos, clips y transcripciones.</li>
            </ul>
          ),
        },
        {
          title: "Tu contenido y derechos de autor",
          body: (
            <>
              <ul>
                <li>
                  Solo puedes usar videos que sean tuyos o sobre los que tengas permiso. Al subir o importar un video, confirmas que tienes
                  esos derechos.
                </li>
                <li>Tú conservas todos los derechos sobre tus videos y los clips que generas.</li>
                <li>
                  Nos das permiso para guardar y procesar tus videos solo para prestarte el servicio (analizarlos, transcribirlos y crear tus
                  clips). No los publicamos ni los usamos para otros fines.
                </li>
              </ul>
              <p>Si crees que alguien usó tu contenido sin permiso en ClipFlow, escríbenos a {mail} y lo revisaremos.</p>
            </>
          ),
        },
        {
          title: "Usos prohibidos",
          body: (
            <ul>
              <li>Usar contenido de otras personas sin su permiso o que infrinja derechos de autor o de imagen.</li>
              <li>Contenido ilegal, de abuso sexual infantil, violento extremo, que incite al odio o que acose a otras personas.</li>
              <li>Intentar saltarse los límites del servicio, atacarlo, automatizar su uso de forma abusiva o revender el acceso.</li>
            </ul>
          ),
        },
        {
          title: "Planes, pagos y renovación",
          body: (
            <>
              <ul>
                <li>
                  <strong>Prueba:</strong> {LEGAL.plans.trial.priceUsd} USD por {LEGAL.plans.trial.days} días, con {LEGAL.plans.trial.minutes}{" "}
                  minutos de video. Al terminar, pasa automáticamente al plan Básico, salvo que la canceles antes. Solo una vez por persona.
                </li>
                <li>
                  <strong>Básico:</strong> {LEGAL.plans.basic.priceUsd} USD al mes, con {LEGAL.plans.basic.minutes} minutos de video por mes.
                </li>
                <li>
                  <strong>Pro:</strong> {LEGAL.plans.pro.priceUsd} USD al mes, con {LEGAL.plans.pro.minutes} minutos de video por mes.
                </li>
                <li>
                  <strong>Max:</strong> {LEGAL.plans.max.priceUsd} USD al mes, con {LEGAL.plans.max.minutes} minutos de video por mes.
                </li>
                <li>Los planes mensuales se renuevan cada mes hasta que los canceles.</li>
                <li>Los minutos se descuentan según la duración de cada video procesado y no se acumulan de un mes a otro.</li>
                <li>Puedes cancelar cuando quieras: conservas el acceso hasta el final del período ya pagado.</li>
                <li>Los precios pueden incluir impuestos según tu país. Te avisaremos con anticipación de cualquier cambio de precio.</li>
              </ul>
              <p>
                Nuestro proceso de compra lo realiza nuestro revendedor en línea Paddle.com. Paddle.com es el comerciante registrado (Merchant
                of Record) de todos nuestros pedidos. Paddle atiende las consultas de facturación y gestiona las devoluciones.
              </p>
            </>
          ),
        },
        {
          title: "Reembolsos",
          body: (
            <p>
              Consulta la <Link href="/reembolsos">Política de reembolsos</Link>.
            </p>
          ),
        },
        {
          title: "Límites de uso",
          body: (
            <p>
              Para que el servicio funcione bien para todos, hay topes de uso (por ejemplo, videos de hasta 3 horas y los minutos
              de tu plan). Te avisamos en la app cuando llegas a uno.
            </p>
          ),
        },
        {
          title: "Resultados de la inteligencia artificial",
          body: (
            <p>
              Los clips, títulos, subtítulos y transcripciones se generan de forma automática y pueden tener errores. Revísalos antes de
              publicarlos: tú decides qué publicas y eres responsable de ello.
            </p>
          ),
        },
        {
          title: "Disponibilidad y cambios",
          body: (
            <p>
              Trabajamos para que ClipFlow esté siempre disponible, pero puede haber interrupciones. Podemos mejorar o cambiar funciones. Si
              cambiamos estos términos de forma importante, te avisaremos en la app o por correo antes de que se apliquen.
            </p>
          ),
        },
        {
          title: "Suspensión de cuentas",
          body: (
            <p>
              Podemos suspender o cerrar cuentas que incumplan estos términos, en especial por infracciones de derechos de autor o usos
              prohibidos. Si es por error, escríbenos a {mail}.
            </p>
          ),
        },
        {
          title: "Responsabilidad",
          body: (
            <p>
              ClipFlow se ofrece «tal cual». En la medida que permita la ley, no somos responsables de daños indirectos ni de la pérdida de
              contenido, y nuestra responsabilidad total se limita a lo que hayas pagado en los últimos 3 meses. Guarda copia de tus videos
              originales.
            </p>
          ),
        },
        {
          title: "Ley aplicable",
          body: (
            <p>
              Estos términos se rigen por las leyes de la República de {LEGAL.country}. Esto no limita los derechos que te dé la ley de
              protección al consumidor de tu país.
            </p>
          ),
        },
        {
          title: "Contacto",
          body: <p>Para cualquier consulta: {mail}.</p>,
        },
      ]}
    />
  );
}
